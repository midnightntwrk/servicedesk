#!/usr/bin/env node
/**
 * check-zkir-crash.mjs: read-only check for a Compact compile that fails after "Compiling N
 * circuits:", where zkir (the program that writes each circuit's prover and verifier keys) stops with
 * "zkir returned a non-zero exit status N", or where the compile never gets past that line.
 *
 * It reads the compile output, names what stopped zkir, and checks this machine for the known
 * causes: a CPU without the ADX instructions zkir is built with, too little memory, a public
 * parameter download that failed, a cached parameter file that is damaged, a broken compiler install,
 * and zkir panics that have an issue. With --out it also checks the keys the compile left behind.
 *
 * Node >= 20, no install. Run it where the compile ran: the same machine, VM or container. It writes
 * nothing, except that --compile compiles into --out (by default a new temporary directory).
 *
 *   compact compile +0.31.1 src/contract.compact out 2>&1 | tee compile.log
 *   node check-zkir-crash.mjs --log compile.log --out out --compiler 0.31.1
 *   node check-zkir-crash.mjs --error 'Exception: zkir returned a non-zero exit status -4'
 *   node check-zkir-crash.mjs --compile src/contract.compact --compiler 0.31.1
 *   node check-zkir-crash.mjs --machine          # only the machine, install and cache checks
 *
 * Run it with the same environment as the compile: MIDNIGHT_PP, XDG_CACHE_HOME, MIDNIGHT_PARAM_SOURCE
 * and COMPACT_DIRECTORY decide which cache and install it checks. If the compile used
 * `compact --directory <dir>`, pass --directory <dir> here too.
 *
 * Other options: --zkir-v3 (with --compile), --offline (skip the download test), --json (its
 * result.ok is true when nothing failed), --timeout <seconds> (download test, default 20).
 *
 * Exit code: 0 = a known cause (the output names the fix), or no failure (every key written); 2 = no
 * known cause, or nothing in the input to go on; 1 = could not run. With --machine: 0 = nothing found
 * that stops zkir, 2 = something was.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`Node >= 20 is required (this is ${process.version})`);
  process.exit(1);
}

const USAGE = `usage: node check-zkir-crash.mjs [--log <file> | --error '<text>' | stdin] [--out <dir>] [--compiler <version>]
       node check-zkir-crash.mjs --compile <file.compact> [--compiler <version>] [--zkir-v3] [--out <dir>]
       node check-zkir-crash.mjs --machine [--compiler <version>]
       options: [--directory <compact dir>] [--offline] [--json] [--timeout <seconds>]`;

// ---------- facts this check relies on (the runbook's Key identifiers) ----------
// zkir needs the public parameters bls_midnight_2p<k> for a circuit of up to 2^k rows. It downloads
// each file once, checks its SHA-256 and keeps it in the cache. This table, k = 0 to 25, is the same in
// every zkir and zkir-v3 binary from compiler 0.28.0 to 0.35.0; k = 0 to 19 also match files downloaded
// on 2026-10-17 (k = 0 to 12 from both hosts).
const PARAM_SHA256 = [
  '59b30b3114a34ccbbfb599376e178fb8d9b3366cae2174c2f1da20e75847f823', 'bbe04fe3c70d0c138447cb086b4baddc30cb8bb2a004114bc02e6f739516280e',  // k = 0, 1
  '80e15568fa1a0117db893239be7fa5e34a6bcc3a8c3bfa7709534b9cb88eb6c1', '4be827a6472193df80d8f08b4b25a85baef436fdd1965d89b6af89f4ec4e99e2',  // k = 2, 3
  '232f401fad10c7ddf8828d2aa4c85c6506c5da09795998cecaeb9f75fc8f6ada', '0a1c9229f315fc1868ff25f668fb83aec4d09f4f23a706b5197c692c619d72c6',  // k = 4, 5
  'cf2ad6be7d0fedf5bec2aaa35f6be4aca33053d74268fdf5aa54fcb2891ea6df', 'e82ae890c080188355f37feaffe91372584cd810615082d9143d4dec0453fd9d',  // k = 6, 7
  '909b707551eaaea79828e883cde6fc46ab15986c3b1d791bed462c9e2805c933', 'b9009f1098bcefffec3c461ab3a5e3a17f7e5599f0f08c70fcdc55a89227bcbd',  // k = 8, 9
  '46b2290933cbed4c378889e4ba971f1a92888331ffb09466acd4ff61a1e2cb42', '9901589d7956ff58be0d85569b2f455b77b58c3758026ffb5bbe4807000b96d1',  // k = 10, 11
  'ef08eb3fcf62df8f72c515cffa027e681808b530cb016eea104115545ef6d5c8', 'd3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803',  // k = 12, 13
  'fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244', '724c7c3d779148bb113c7ee9c034b2f27db16e6bdf315fde90105a9bad00b1de',  // k = 14, 15
  '09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6', '4a9ef6c7c0619aab74eede44b13e753e3ba54508a02dd3b7106a949aabb73b74',  // k = 16, 17
  'e8436dc5d8b598f169c127c745135d889744007e6d384ff126df8d1332522f86', '8e8dc15c4362f05c912f1e770559a3945db3e58a374def416ed5d3e65ad5b10e',  // k = 18, 19
  '1cc62978558fdc1e445cd70cfd9a86ec3c2e2151b6d74811232d37faf9133ff1', '9cf1644a87f0f027ae5fc6278f91d823a6334ff3e338a29e2f2ef57d071ed64d',  // k = 20, 21
  'e8ad5eed936d657a0fb59d2a55ba19f81a3083bb3554ef88f464f5377e9b2c2f', '09399d05f9f50875dfdd87dc9903d40c897eaafa9ec8cbb08bace853ecc36c0c',  // k = 22, 23
  'b0e6fa7a4ab4a79a1e6560966f267556409db44bab6d5fab3711ad6c6b623207', '3289a751c938988cd2f54154d8722d1eda2cd11593064afdde82099b24ff4a58',  // k = 24, 25
];
// File size: 192 bytes per row and a 388-byte header (Content-Length on both hosts, k = 4 to 25).
const paramBytes = (k) => 192 * 2 ** k + 388;
// zkir's download host when MIDNIGHT_PARAM_SOURCE isn't set: S3 in 0.28.0 to 0.31.1, srs in 0.34.0 and
// 0.35.0 (no 0.32 or 0.33 was released). srs answers 403 to a request with no User-Agent, and the
// zkir in 0.31.0 and 0.31.1 sends none, so pointing those at srs fails every time.
// Overridable so the test can point the script at a local mock.
const SRS = process.env.CHECK_ZKIR_SRS ?? 'https://srs.midnight.network/';
const S3 = process.env.CHECK_ZKIR_S3 ?? 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/';
const SRS_HOST = 'srs.midnight.network';
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
// Chez Scheme's (system …) returns minus the signal number when zkir is killed by a signal; these are
// the same on Linux and macOS.
const SIGNALS = { 2: 'SIGINT', 4: 'SIGILL', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM' };
// zkir's peak memory (max RSS) by the largest circuit's k, compiler 0.31.1 on x86_64 macOS, measured
// on 2026-10-17. Used only to give a scale.
const PEAK_MB = [
  { what: 'k = 5 (a counter)', mb: 14 },
  { what: 'k = 15', mb: 373 },
  { what: 'k = 16', mb: 705 },
  { what: 'k = 19', mb: 2808 },
];
// compactc itself (not zkir) peaked at 228 MB on the same contracts.
const COMPACTC_MB = 228;

// zkir panics that have an issue. Each was reproduced on 2026-10-17 with the versions named.
const PANICS = [
  {
    id: 'jubjub-scalar-equality',
    match: /Unsupported test_eq: JubjubScalar == JubjubScalar/,
    issue: 'LFDT-Minokawa/compact#757',
    what: () => 'zkir-v3 has no equality test for JubjubScalar values, and compiler 0.34.0 passes `==` and `!=` on JubjubScalar through to it (with --feature-zkir-v3 only).',
    fix: [
      'Upgrade to compiler 0.35.0: it builds keys for the same code, with and without --feature-zkir-v3.',
      'Or, on 0.34.0, compare the values as Field: `assert((r as Field) != (0 as Field), "zero")` builds keys with --feature-zkir-v3.',
      'Or build without --feature-zkir-v3.',
    ],
  },
  {
    id: 'zkir-v3-jubjub-arch',
    match: /ZkStdLibArch must enable jubjub/,
    issue: 'LFDT-Minokawa/compact#616',
    what: () => 'with --feature-zkir-v3, zkir sets up a circuit without the Jubjub gadgets the circuit needs. Seen with Secp256k1Point, and with a circuit that returns ecMulGenerator(…). Open on 0.34.0 and 0.35.0.',
    fix: [
      'Build without --feature-zkir-v3: the default backend builds keys for the ecMulGenerator case on 0.34.0 and 0.35.0.',
      'Secp256k1Point exists only with --feature-zkir-v3 (0.34.0 and 0.35.0), so a circuit that uses it has no workaround until the issue is fixed.',
    ],
  },
  {
    id: 'constant-out-of-range',
    match: /Trying to convert Fq\((0x[0-9a-fA-F]+)\) to an AssignedBounded less than 2\^(\d+)!/,
    issue: 'LFDT-Minokawa/compact#299',
    what: (m) => `the circuit casts a value that is fixed at compile time, ${BigInt(m[1])}, to an unsigned type of ${m[2]} bits, and it doesn't fit, so no proof of this circuit could ever be made. zkir stops on it instead of the compiler reporting it. Same on 0.31.1 to 0.35.0, both backends.`,
    fix: [
      'Find the `as Uint<…>` cast of a constant expression, often a wrap-around such as `((255 as Uint<8>) + (1 as Uint<8>)) as Uint<8>`, and keep the wider type or change the constant. The same cast on a value from an argument or witness compiles, and is checked when proving.',
      'A cast to a smaller Uint doesn\'t wrap around: it fails when the value doesn\'t fit. If the code meant to wrap, the wrap-around has to be written out another way. The panic doesn\'t name the circuit.',
    ],
  },
  {
    id: 'zkir-v3-jubjub-native',
    match: /cannot convert JubjubPoint to \\?"Native\\?"/,
    issue: 'LFDT-Minokawa/compact#280',
    what: () => 'zkir-v3 in compilers 0.30.0 and 0.31.1 can\'t compare JubjubPoint values. Fixed from 0.34.0.',
    fix: [
      'On 0.31.1, build without --feature-zkir-v3: the default backend builds keys for the same code.',
      'Or use 0.34.0 or later if you need --feature-zkir-v3.',
    ],
  },
];

// ---------- arguments ----------
const argv = process.argv.slice(2);
const opts = { offline: false, json: false, machine: false, zkirV3: false, timeout: 20 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value\n${USAGE}`);
    return v;
  };
  if (a === '--log') opts.log = value();
  else if (a === '--error') opts.error = value();
  else if (a === '--out') opts.out = value();
  else if (a === '--compile') opts.compile = value();
  else if (a === '--compiler') opts.compiler = value().replace(/^\+/, '');
  else if (a === '--directory') opts.directory = value();
  else if (a === '--timeout') opts.timeout = Number(value());
  else if (a === '--zkir-v3') opts.zkirV3 = true;
  else if (a === '--machine') opts.machine = true;
  else if (a === '--offline') opts.offline = true;
  else if (a === '--json') opts.json = true;
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else fail(`unknown argument ${a}\n${USAGE}`);
}
if ([opts.log, opts.error, opts.compile].filter((x) => x !== undefined).length > 1) fail(`use one of --log, --error and --compile\n${USAGE}`);
if (opts.machine && (opts.log ?? opts.error ?? opts.compile) !== undefined) fail(`--machine takes no compile output\n${USAGE}`);
if (opts.zkirV3 && opts.compile === undefined) fail('--zkir-v3 goes with --compile');
if (!(opts.timeout > 0)) fail('--timeout takes a number of seconds');
if (opts.compiler !== undefined && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(opts.compiler)) fail('--compiler takes a version such as 0.31.1');

function fail(message) {
  console.error(message);
  process.exit(1);
}
// fetch() reports "fetch failed" and keeps the reason in `cause`.
const why = (e) => `${e.message}${e.cause?.code ? ` (${e.cause.code})` : e.cause?.message ? ` (${e.cause.message})` : ''}`;
// What the common network failures mean, for the download test.
const NET_CODES = {
  EAI_AGAIN: "the host name doesn't resolve: no network or no DNS",
  ENOTFOUND: "the host name doesn't resolve",
  ECONNREFUSED: 'the connection was refused',
  ECONNRESET: 'the connection was reset',
  ETIMEDOUT: 'the connection timed out',
  ENETUNREACH: 'no route to the network',
  EHOSTUNREACH: 'no route to the host',
  SELF_SIGNED_CERT_IN_CHAIN: 'an unknown TLS certificate in the chain (a proxy that intercepts TLS?)',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'an unknown TLS certificate issuer (a proxy that intercepts TLS?)',
};
const netWhy = (e) => (NET_CODES[e.cause?.code] ? `${NET_CODES[e.cause.code]} (${e.cause.code})` : why(e));
const readMaybe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } };
const mb = (n) => `${Math.round(n / 1048576).toLocaleString('en-US')} MB`;
const size = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? mb(n) : `${Math.ceil(n / 1024)} KB`);
const vparts = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '') ?? []).slice(1).map(Number);
const vless = (a, b) => { const x = vparts(a), y = vparts(b); if (x.length < 3) return undefined; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };

// ---------- the compile output ----------
export function parse(raw) {
  // A terminal run draws a progress bar with carriage returns and colour codes.
  const text = String(raw).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n');
  const r = {};
  let m;
  if ((m = /Compiling (\d+) circuits?:/.exec(text))) { r.circuits = Number(m[1]); r.compiling = m[0]; }
  if ((m = /zkir returned a non-zero exit status (-?\d+)/.exec(text))) r.status = Number(m[1]);
  if ((m = /panicked at (\S+?):(\d+):(\d+):\n([\s\S]*?)(?=\nnote: |\nException: |\n\n|$)/.exec(text))) r.panic = { at: `${m[1]}:${m[2]}:${m[3]}`, message: m[4].trim() };
  if ((m = /Failed to fetch data from (\S+?) after (\d+) attempts/.exec(text))) r.fetch = { url: m[1].replace(/["\\]+$/, ''), k: numK(m[1]) };
  if ((m = /Hash mismatch in data stored at (.+?)\. Found hash ([0-9a-f]{64}), but expected ([0-9a-f]{64})/.exec(text))) r.hash = { file: m[1], found: m[2], expected: m[3], k: numK(m[1]) };
  if (/ZKIR not found; skipping final circuit compilation/.test(text)) r.zkirMissing = true;
  if ((m = /exec:? (zkir(?:-v3)?): not found/.exec(text))) r.notFound = m[1];
  if (/compiler toolchain was terminated by a signal/.test(text)) r.toolchainSignal = true;
  if ((m = /Exception: (\S+?) line (\d+) char (\d+):\n\s*(.*)/.exec(text))) r.compileError = `${m[1]} line ${m[2]} char ${m[3]}: ${m[4].trim()}`;
  if ((m = /Internal error \(please report\):?\s*(.*)/.exec(text))) r.internalError = m[1].trim();
  const err = text.split('\n').find((l) => /^Error: /.test(l) && !/Failed to (?:run compactc|fetch data)|Hash mismatch/.test(l));
  if (err) r.error = err.trim();
  return r;
}
function numK(s) {
  const m = /bls_midnight_2p(\d+)/.exec(s ?? '');
  return m ? Number(m[1]) : undefined;
}

// ---------- this machine ----------
const PLATFORM = process.env.CHECK_ZKIR_PLATFORM ?? process.platform;
const ARCH = process.env.CHECK_ZKIR_ARCH ?? process.arch;

function sysctl(names) {
  if (process.env.CHECK_ZKIR_SYSCTL) {
    const fake = JSON.parse(fs.readFileSync(process.env.CHECK_ZKIR_SYSCTL, 'utf8'));
    return Object.fromEntries(names.map((n) => [n, fake[n]]));
  }
  const out = {};
  for (const n of names) {
    try { out[n] = execFileSync('sysctl', ['-n', n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { out[n] = undefined; }
  }
  return out;
}

export function cpu() {
  const c = { platform: PLATFORM, arch: ARCH };
  if (PLATFORM === 'linux') {
    const info = readMaybe(process.env.CHECK_ZKIR_CPUINFO ?? '/proc/cpuinfo');
    if (info === undefined) return { ...c, unreadable: '/proc/cpuinfo' };
    c.model = /^model name\s*:\s*(.+)$/m.exec(info)?.[1].trim();
    const flags = /^flags\s*:\s*(.*)$/m.exec(info)?.[1];
    if (flags !== undefined) {
      const f = new Set(flags.trim().split(/\s+/));
      c.adx = f.has('adx');
      c.bmi2 = f.has('bmi2');
      c.vm = f.has('hypervisor');
    } else if (/^(?:Features|CPU implementer)\s*:/m.test(info)) {
      c.kernel = 'arm64';
    }
    // An x86_64 program on an ARM kernel is being emulated (Docker Desktop's linux/amd64 on Apple
    // Silicon, or qemu-user): /proc/cpuinfo then describes the ARM CPU, not what the emulator offers.
    if (ARCH === 'x64' && c.kernel === 'arm64') c.emulated = 'an x86_64 program on an ARM machine';
  } else if (PLATFORM === 'darwin') {
    const s = sysctl(['machdep.cpu.brand_string', 'machdep.cpu.leaf7_features', 'hw.optional.arm64', 'sysctl.proc_translated']);
    c.model = s['machdep.cpu.brand_string'];
    c.appleSilicon = s['hw.optional.arm64'] === '1';
    if (s['sysctl.proc_translated'] === '1') c.emulated = 'Rosetta 2';
    if (!c.appleSilicon && s['machdep.cpu.leaf7_features'] !== undefined) {
      const f = new Set(s['machdep.cpu.leaf7_features'].split(/\s+/));
      c.adx = f.has('ADX');
      c.bmi2 = f.has('BMI2');
    }
  }
  return c;
}

export function memory() {
  const m = { total: Number(process.env.CHECK_ZKIR_TOTALMEM ?? os.totalmem()), free: os.freemem() };
  if (PLATFORM === 'linux') {
    const cg = process.env.CHECK_ZKIR_CGROUP ?? '/sys/fs/cgroup';
    const v2 = readMaybe(path.join(cg, 'memory.max'));
    const v1 = readMaybe(path.join(cg, 'memory', 'memory.limit_in_bytes'));
    let events;
    if (v2 !== undefined) {
      if (v2.trim() !== 'max') m.limit = Number(v2.trim());
      events = readMaybe(path.join(cg, 'memory.events'));
    } else if (v1 !== undefined) {
      const n = Number(v1.trim());
      if (n < 2 ** 60) m.limit = n; // "no limit" is a huge number in cgroup v1
      events = readMaybe(path.join(cg, 'memory', 'memory.oom_control'));
    }
    const k = events && /^oom_kill (\d+)$/m.exec(events);
    if (k) m.oomKills = Number(k[1]);
  }
  m.available = Math.min(m.total, m.limit ?? Infinity);
  return m;
}

// The compiler: which version, and whether its install is complete. `compact update` keeps the
// archive it unpacked (artifact.zip) next to the files, so each file can be checked against it.
const COMPACT = process.env.CHECK_ZKIR_COMPACT ?? 'compact';
// Where compact keeps its versions: --directory, else COMPACT_DIRECTORY, else ~/.compact (as compact does).
const compactDir = () => opts.directory ?? process.env.COMPACT_DIRECTORY ?? path.join(os.homedir(), '.compact');
const dirArgs = () => (opts.directory ? ['--directory', opts.directory] : []);
function defaultVersion() {
  try {
    const v = execFileSync(COMPACT, [...dirArgs(), 'compile', '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  } catch { /* not on PATH */ }
  return undefined;
}

export function zipEntries(file) {
  let b;
  try { b = fs.readFileSync(file); } catch { return undefined; }
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > b.length) return undefined;
  const count = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  let p = eocd - cdSize; // the central directory ends where the end record starts, even with bytes prepended
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (p < 0 || p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return undefined;
    const usize = b.readUInt32LE(p + 24);
    const n = b.readUInt16LE(p + 28), x = b.readUInt16LE(p + 30), c = b.readUInt16LE(p + 32);
    const name = b.toString('utf8', p + 46, p + 46 + n);
    if (!name.endsWith('/')) out.set(name, usize);
    p += 46 + n + x + c;
  }
  return out;
}

export function install(version) {
  const r = { version, dir: path.join(compactDir(), 'versions', version ?? '?') };
  if (!version) return { ...r, unknown: true };
  let triples;
  try { triples = fs.readdirSync(r.dir).filter((t) => fs.statSync(path.join(r.dir, t)).isDirectory()); } catch { return { ...r, absent: true }; }
  if (!triples.length) return { ...r, absent: true };
  r.triple = triples[0];
  const td = path.join(r.dir, r.triple);
  r.problems = [];
  const zip = zipEntries(path.join(td, 'artifact.zip'));
  if (zip === undefined) r.noArchive = true;
  const expected = zip ?? new Map([['compactc.bin', undefined], ['zkir', undefined]]);
  for (const [name, bytes] of expected) {
    let st;
    try { st = fs.statSync(path.join(td, name)); } catch { r.problems.push(`${name} is missing`); continue; }
    if (bytes !== undefined && st.size !== bytes) r.problems.push(`${name} is ${st.size.toLocaleString('en-US')} bytes, the archive has ${bytes.toLocaleString('en-US')}`);
    else if (/^(?:compactc(?:\.bin)?|zkir(?:-v3)?)$/.test(name) && !(st.mode & 0o111)) r.problems.push(`${name} isn't executable`);
  }
  return r;
}

// The parameter cache, where zkir looks: $MIDNIGHT_PP, else $XDG_CACHE_HOME/midnight/zk-params,
// else $HOME/.cache/midnight/zk-params. An error that names a file also names its directory.
export function cacheDir() {
  const e = process.env;
  if (e.MIDNIGHT_PP) return { dir: e.MIDNIGHT_PP, from: 'MIDNIGHT_PP' };
  if (e.XDG_CACHE_HOME) return { dir: path.join(e.XDG_CACHE_HOME, 'midnight', 'zk-params'), from: 'XDG_CACHE_HOME' };
  return { dir: path.join(os.homedir(), '.cache', 'midnight', 'zk-params'), from: 'HOME' };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export async function cache(dirs) {
  const out = [];
  for (const { dir, from } of dirs) {
    const c = { dir, from, files: [], partial: [] };
    let names;
    try { names = fs.readdirSync(dir); } catch { c.absent = true; out.push(c); continue; }
    for (const name of names.sort((a, b) => (numK(a) ?? 0) - (numK(b) ?? 0))) {
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const full = /^bls_midnight_2p(\d+)$/.exec(name);
      const temp = /^\.bls_midnight_2p(\d+)\..+$/.exec(name) ?? /^bls_midnight_2p(\d+)\.part$/.exec(name);
      if (full) {
        const k = Number(full[1]);
        const f = { name, k, bytes: st.size };
        if (k >= PARAM_SHA256.length) f.state = 'not checked (no hash for this k)';
        else if (st.size !== paramBytes(k)) f.state = `wrong size: ${st.size.toLocaleString('en-US')} bytes, expected ${paramBytes(k).toLocaleString('en-US')}`;
        else {
          if (st.size > 200 * 1048576 && !opts.json) process.stderr.write(`hashing ${name} (${size(st.size)})…\n`);
          try { f.state = (await sha256(file)) === PARAM_SHA256[k] ? 'ok' : 'damaged: wrong SHA-256'; } catch (e) { f.state = `unreadable: ${e.message}`; }
        }
        c.files.push(f);
      } else if (temp) {
        const k = Number(temp[1]);
        c.partial.push({ name, k, bytes: st.size, of: paramBytes(k), ageS: Math.round((Date.now() - st.mtimeMs) / 1000) });
      }
    }
    out.push(c);
  }
  return out;
}

// The keys a compile left: one .prover and one .verifier per circuit in <out>/zkir. compactc writes
// contract/ only after zkir succeeds and doesn't delete it first, so after a failure an older
// contract/index.js can sit next to the new, empty keys.
export function keys(out, expected) {
  const r = { out, circuits: [] };
  if (!fs.existsSync(out)) return { ...r, missing: true };
  let names;
  // When zkir fails, compactc deletes what it wrote in this run (compiler/, zkir/*.zkir) and any
  // directory left empty, so a failed compile can leave keys/ without zkir/.
  try { names = fs.readdirSync(path.join(out, 'zkir')); } catch {
    let k;
    try { k = fs.readdirSync(path.join(out, 'keys')); } catch { return { ...r, noZkir: true }; }
    return { ...r, noZkir: true, keysOnly: true, keyFiles: k.length };
  }
  const circuits = [...new Set(names.filter((n) => /\.b?zkir$/.test(n)).map((n) => n.replace(/\.b?zkir$/, '')))].sort();
  r.keysDir = fs.existsSync(path.join(out, 'keys'));
  for (const c of circuits) {
    const one = (ext) => { try { return fs.statSync(path.join(out, 'keys', `${c}.${ext}`)).size; } catch { return undefined; } };
    r.circuits.push({ name: c, prover: one('prover'), verifier: one('verifier') });
  }
  r.good = r.circuits.filter((c) => c.prover > 0 && c.verifier > 0).length;
  // After a failure zkir/ only holds the circuits zkir reached; the compile output gives the total.
  r.total = Math.max(r.circuits.length, expected ?? 0);
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return undefined; } };
  const newestZkir = Math.max(...names.map((n) => mtime(path.join(out, 'zkir', n)) ?? 0));
  const js = mtime(path.join(out, 'contract', 'index.js'));
  if (js === undefined) r.noContract = true;
  else if (js < newestZkir - 1000) r.staleContract = true;
  return r;
}

// One parameter file (k = 12, 787 KB) from a host, for at most --timeout seconds: does it answer, how
// fast, and is the file right (when it all arrives in time).
const PROBE_K = 12;
async function probe(base) {
  const url = new URL(`bls_midnight_2p${PROBE_K}`, base.endsWith('/') ? base : `${base}/`);
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeout * 1000);
  let got = 0;
  const h = crypto.createHash('sha256');
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'check-zkir-crash' }, signal: ac.signal });
    if (!res.ok) return { base, status: res.status };
    for await (const chunk of res.body) { got += chunk.length; h.update(chunk); }
    const s = (performance.now() - t0) / 1000;
    return { base, status: res.status, seconds: s, rate: got / s, good: h.digest('hex') === PARAM_SHA256[PROBE_K] };
  } catch (e) {
    const s = (performance.now() - t0) / 1000;
    if (ac.signal.aborted && got > 0) return { base, status: 200, seconds: s, rate: got / s, partial: true };
    return { base, error: ac.signal.aborted ? `no answer in ${opts.timeout} s` : netWhy(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- running the compile (--compile) ----------
function compile() {
  const out = opts.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'check-zkir-'));
  opts.out = out;
  const args = [...dirArgs(), 'compile', ...(opts.compiler ? [`+${opts.compiler}`] : []), ...(opts.zkirV3 ? ['--feature-zkir-v3'] : []), opts.compile, out];
  if (!opts.json) process.stderr.write(`$ ${COMPACT} ${args.join(' ')}\n`);
  return new Promise((resolve) => {
    let text = '';
    const p = spawn(COMPACT, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (d) => { text += d; if (!opts.json) process.stderr.write(d); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', (e) => resolve({ error: `couldn't run ${COMPACT}: ${e.message}` }));
    p.on('close', (code, signal) => resolve({ text, code, signal }));
  });
}

// ---------- deciding ----------
function decide(inp, m) {
  const { cpu: c, mem, inst, caches, net, keys: k, version } = m;
  const d = { known: false, fix: [], refs: [] };
  const damaged = caches.flatMap((x) => x.files.filter((f) => f.state !== 'ok' && !f.state.startsWith('not checked')).map((f) => ({ ...f, file: path.join(x.dir, f.name) })));
  const where = caches[0]?.dir ?? cacheDir().dir;
  // To a .part file first, so a download that stops never leaves a short file under the name zkir
  // checks; -C - resumes it when the command is run again.
  const prefetch = (kk) => [
    `mkdir -p '${where}'`,
    `curl -fL --retry 5 -C - -o '${where}/bls_midnight_2p${kk}.part' ${SRS}bls_midnight_2p${kk} && mv '${where}/bls_midnight_2p${kk}.part' '${where}/bls_midnight_2p${kk}'`,
  ];
  const broken = inst.problems?.length ? inst : undefined;
  const dirFlag = opts.directory || process.env.COMPACT_DIRECTORY ? ` --directory '${compactDir()}'` : '';
  const reinstall = (v) => `Reinstall ${v}. \`compact update\` alone says "already installed", so remove the version first; its files are read-only, hence -f: \`rm -rf '${inst.dir}'\`, then \`compact${dirFlag} update ${v} --no-set-default\` (leave out --no-set-default to make ${v} the default).`;

  if (opts.machine) {
    const found = [];
    if (c.adx === false) found.push('this CPU has no ADX, so zkir stops with exit status -4 (SIGILL) on every contract');
    if (c.emulated) found.push(`this is ${c.emulated}: x86_64 zkir needs ADX, and whether the emulator provides it can't be read from here; use the native arm64 build`);
    if (broken) found.push(`the ${inst.version} install is incomplete: ${broken.problems.join('; ')}`);
    if (inst.absent) found.push(`compiler ${inst.version} isn't installed under ${inst.dir}`);
    for (const f of damaged) found.push(`${f.file} is ${f.state}; delete it and zkir downloads it again`);
    if (mem.available < 512 * 1048576) found.push(`only ${mb(mem.available)} of memory: compactc alone peaked at ${COMPACTC_MB} MB, so only small contracts will compile, and zkir needs more for larger circuits`);
    const src = process.env.MIDNIGHT_PARAM_SOURCE;
    if (src && hostOf(src) === SRS_HOST && version !== undefined && vless(version, '0.34.0') !== false) found.push(`MIDNIGHT_PARAM_SOURCE points at srs.midnight.network, and the zkir in ${version} sends no User-Agent, which srs refuses (HTTP 403): every parameter download will fail. Unset it, or fetch the files with curl. This check's own download test sends a User-Agent, so it passes.`);
    d.known = !found.length;
    d.summary = found.length ? 'Found:' : 'Nothing found on this machine that stops zkir.';
    d.fix = found;
    return d;
  }

  if (inp.compileError && inp.status === undefined) {
    d.summary = `Not a zkir failure: the compiler rejected the contract (${inp.compileError}).`;
    d.fix.push('See the Compact compile errors runbook: compact-ai-generated-compile-errors-runbook.md.');
    return d;
  }
  if (inp.internalError && inp.status === undefined) {
    d.summary = `Not a zkir failure: the compiler stopped with an internal error (${inp.internalError}).`;
    d.fix.push('That is a compiler bug: open an issue at LFDT-Minokawa/compact with the contract and the full message. It fails with --skip-zk too, which skips zkir.');
    return d;
  }

  if (inp.zkirMissing) {
    d.known = true;
    d.summary = 'The compile finished without keys: compactc didn\'t find zkir, printed "ZKIR not found; skipping final circuit compilation" and exited 0. The output has no keys/ directory, so it can\'t be deployed.';
    if (broken || inst.absent) d.fix.push(broken ? `The ${inst.version} install is incomplete (${broken.problems.join('; ')}). ${reinstall(inst.version)}` : `Compiler ${inst.version} isn't installed: \`compact${dirFlag} update ${inst.version} --no-set-default\`.`);
    else d.fix.push('Compile through `compact compile`, which runs the toolchain\'s own compactc wrapper: it puts its directory, with zkir, first on PATH. Running compactc.bin directly, or a wrapper of your own, skips that.');
    return d;
  }

  if (inp.toolchainSignal) {
    d.summary = 'The compiler itself (compactc), not zkir, was killed by a signal: the compact CLI prints "compiler toolchain was terminated by a signal".';
    if (broken) {
      d.known = true;
      d.summary += ` Its install is incomplete: ${broken.problems.join('; ')}. A truncated compactc.bin crashes like this, even with --skip-zk.`;
      d.fix.push(reinstall(inst.version));
    } else if (mem.available < 512 * 1048576) {
      d.known = true;
      d.summary += ` This machine or container has ${mb(mem.available)} of memory; compactc alone peaked at ${COMPACTC_MB} MB on small contracts, and the out-of-memory killer stops the biggest process.`;
      d.fix.push('Give the compile at least 1 GB (for example `docker run --memory 2g`), more for large circuits.');
    } else {
      d.summary += ` Its install is complete and this machine has ${mb(mem.available)}, so neither known cause fits.`;
      d.fix.push('If the compile ran in a different container or VM, run this check there. Otherwise run it again with `--compile` and open an issue at the servicedesk front door with the output.');
    }
    return d;
  }

  if (inp.hash) {
    d.known = true;
    d.summary = `zkir found ${path.basename(inp.hash.file)} in its cache, but the file's SHA-256 isn't the one zkir checks for: the file is damaged or incomplete. zkir stops (exit status 1) and doesn't download it again.`;
    d.fix.push(`Delete it and compile again; zkir downloads a new copy: \`rm '${inp.hash.file}'\`.`);
    const others = damaged.filter((f) => f.file !== inp.hash.file);
    if (others.length) d.fix.push(`These are damaged too: ${others.map((f) => `${f.file} (${f.state})`).join('; ')}.`);
    d.fix.push('If the download then fails, fetch it yourself (it is checked again when zkir reads it):', ...prefetch(inp.hash.k).map((l) => `  ${l}`));
    return d;
  }

  if (inp.fetch) {
    d.known = true;
    const kk = inp.fetch.k;
    const host = (() => { try { return new URL(inp.fetch.url).host; } catch { return inp.fetch.url; } })();
    d.summary = `zkir couldn't download the public parameters ${kk !== undefined ? `bls_midnight_2p${kk} (${size(paramBytes(kk))})` : ''} from ${host} after 3 tries, so it stopped (exit status 1) and left empty key files.`;
    // The default version only says what `compact compile` runs without +<version>.
    const old = version !== undefined && m.versionFrom === 'argument' ? vless(version, '0.34.0') : undefined;
    const have = kk !== undefined && caches.find((x) => x.files.some((f) => f.k === kk && f.state === 'ok'));
    if (have) d.summary += ` This check's cache (${have.dir}) already has an intact bls_midnight_2p${kk}, so the compile used a different cache: run this check with the compile's MIDNIGHT_PP, XDG_CACHE_HOME and HOME, or put the file in the compile's cache.`;
    if (host === SRS_HOST && old !== false) {
      d.summary += ` ${old ? `Compiler ${version}'s` : 'If this compile used 0.31.x or older (pass --compiler to be sure), its'} zkir sends no User-Agent, and srs.midnight.network refuses requests without one (HTTP 403), so this download can never work${process.env.MIDNIGHT_PARAM_SOURCE ? ' (MIDNIGHT_PARAM_SOURCE points it there)' : ''}.`;
      d.fix.push(`${process.env.MIDNIGHT_PARAM_SOURCE ? 'Unset MIDNIGHT_PARAM_SOURCE' : 'Remove MIDNIGHT_PARAM_SOURCE from the shell or CI job that compiles'} so zkir uses its own default host, or download the file with curl, which zkir then finds in its cache:`);
    } else if (net.length && net.every((p) => p.error)) {
      d.summary += ` This machine can't reach either host now: ${net.map((p) => `${new URL(p.base).host}: ${p.error}`).join('; ')}.`;
      d.fix.push('Fix the network (DNS, proxy or firewall), or download the file on a machine that has network and copy it into this cache:');
    } else {
      for (const p of net) d.summary += ` ${p.base}: ${p.error ?? (p.status !== 200 ? `HTTP ${p.status}` : `answers now, ${size(p.rate)}/s${p.good || p.partial ? '' : ', but sent a wrong file'}`)}.`;
      d.fix.push('Download the file with curl, which retries and can resume, and zkir then finds it in its cache:');
    }
    if (kk !== undefined) d.fix.push(...prefetch(kk).map((l) => `  ${l}`));
    d.fix.push('Then run this check with --machine to confirm the file\'s SHA-256, and compile again.');
    return d;
  }

  const status = inp.status;
  if (status !== undefined && status < 0) {
    const sig = SIGNALS[-status] ?? `signal ${-status}`;
    if (status === -4) {
      if (c.adx === false) {
        d.known = true;
        d.summary = `zkir was stopped by ${sig} (an illegal instruction). This CPU${c.model ? `, ${c.model},` : ''} doesn't have ADX, and zkir's BLS12-381 arithmetic (blst) uses ADX instructions (adcx, adox) with no fallback, in every x86_64 build checked (0.31.1, 0.34.0 and 0.35.0, default and zkir-v3).`;
        if (c.vm) d.summary += ' The CPU reports the hypervisor flag: this is a virtual machine, and its CPU model hides ADX. The generic models do: qemu64, kvm64, and the x86-64-v2, v3 and v4 levels, which include Proxmox\'s default x86-64-v2-AES.';
        d.fix.push(
          c.vm ? 'Give the VM the host\'s CPU model: Proxmox CPU type `host`, libvirt `<cpu mode=\'host-passthrough\'/>`, QEMU `-cpu host`. Then run this check with --machine in the VM: it should report ADX.' : 'Compile on a machine whose CPU has ADX. Intel Core and Xeon from Broadwell (2014) and AMD from Zen (2017) have it; Intel\'s Atom-class Celeron and Pentium chips up to Tremont (about 2021) and older AMD don\'t. Apple Silicon works with the native arm64 build. Check the machine first with --machine: it reads the flag.',
          'On this machine, `compact compile --skip-zk` still checks the contract and writes the TypeScript; only the keys need a machine with ADX.',
        );
        d.refs.push('midnightntwrk/compact#42');
      } else if (c.emulated) {
        d.known = true;
        d.summary = `zkir was stopped by ${sig} (an illegal instruction) while running as ${c.emulated}. x86_64 zkir needs ADX instructions, and the emulator doesn't seem to provide them (this can't be read from inside the emulation).`;
        d.fix.push(c.emulated === 'Rosetta 2' ? 'Use the native build: install compact from a terminal where `uname -m` prints arm64, then `compact update`.' : 'Use an arm64 image (drop `--platform linux/amd64`); the compact installer then picks the aarch64-unknown-linux-musl build.');
        d.refs.push('midnightntwrk/compact#42');
      } else {
        d.summary = `zkir was stopped by ${sig} (an illegal instruction), but ${c.adx ? 'this CPU has ADX' : 'this machine\'s CPU couldn\'t be read'}, so the known cause doesn't fit${c.platform === 'linux' || c.platform === 'darwin' ? '' : ` (${c.platform})`}.`;
        d.fix.push('If the compile ran on another machine, VM or container, run this check there with --machine. Otherwise open an issue at LFDT-Minokawa/compact with this output and the CPU model.');
      }
      return d;
    }
    if (status === -9) {
      d.known = true;
      d.summary = `zkir was stopped by ${sig}: it ran out of memory. zkir is the biggest process in a compile, and the out-of-memory killer stops it.`;
      d.summary += ` This ${mem.limit !== undefined ? 'container' : 'machine'} has ${mb(mem.available)}${mem.limit !== undefined ? ` (its memory limit; the machine has ${mb(mem.total)})` : ''}.`;
      if (mem.oomKills) d.summary += ` Its cgroup has recorded ${mem.oomKills} out-of-memory kill${mem.oomKills === 1 ? '' : 's'}.`;
      if (!mem.oomKills) d.summary += ' SIGKILL can also come from outside (a CI step timeout, `kill -9`); if neither happened, it was memory.';
      d.fix.push(
        'Give the compile more memory: a higher container limit (`docker run --memory 4g`; Docker Desktop: Settings, Resources), or close other programs. Swap helps too, slowly.',
        'zkir\'s peak grows with the largest circuit: splitting it into smaller circuits lowers the peak; fewer threads don\'t.',
        '`compact compile --skip-zk` needs far less memory and still checks the contract; only the keys need the memory.',
      );
      d.fix.push(`zkir's measured peak by circuit size: ${PEAK_MB.map((p) => `${p.what}, ${p.mb.toLocaleString('en-US')} MB`).join('; ')}. A circuit's k is in the name of the parameter file zkir fetched for it, bls_midnight_2p<k>.`);
      return d;
    }
    if (status === -15 || status === -2) {
      d.known = true;
      d.summary = `zkir was stopped from outside by ${sig}: Ctrl-C, \`timeout\`, or a CI job's time limit. Nothing is wrong with zkir.`;
      d.fix.push('Let it finish. Key generation for a large circuit takes minutes; the first compile also downloads the public parameters.');
      return d;
    }
    d.summary = `zkir crashed with ${sig}. That isn't a known cause.`;
    d.fix.push('Open an issue at LFDT-Minokawa/compact with the contract (or the smallest one that does it), the compiler version, this output and the --json output.');
    return d;
  }

  if (inp.panic || status === 101) {
    const p = inp.panic;
    for (const known of PANICS) {
      const mm = p && known.match.exec(p.message);
      if (!mm) continue;
      d.known = true;
      d.summary = `zkir panicked: ${known.what(mm)}`;
      d.fix.push(...known.fix);
      d.refs.push(known.issue);
      return d;
    }
    d.summary = p ? `zkir panicked at ${p.at}: ${p.message}. That isn't a known panic.` : 'zkir panicked (exit status 101), and the output doesn\'t include the panic message.';
    d.fix.push(
      'Try the other backend (with or without --feature-zkir-v3): three of the four known panics happen only with --feature-zkir-v3.',
      'Open an issue at LFDT-Minokawa/compact with the contract (or the smallest one that does it), the compiler version and the panic lines.',
    );
    return d;
  }

  if (status === 127 || inp.notFound) {
    d.known = true;
    d.summary = `compactc couldn't start ${inp.notFound ?? 'zkir'}: "exec: ${inp.notFound ?? 'zkir'}: not found" and exit status 127. compactc only checks that zkir exists, then runs zkir-v3 for --feature-zkir-v3, so an install without zkir-v3 fails like this.`;
    d.fix.push(broken ? `The ${inst.version} install is incomplete (${broken.problems.join('; ')}). ${reinstall(inst.version)}` : inst.absent ? `Compiler ${inst.version} isn't installed: \`compact${dirFlag} update ${inst.version} --no-set-default\`.` : `This check found the ${inst.version ?? ''} install complete: if the compile used another version or directory, run this again with --compiler and --directory to match, or reinstall that version.`);
    return d;
  }

  if (status === 1 && !inp.error) {
    if (damaged.length) {
      d.known = true;
      d.summary = `zkir stopped with exit status 1, and the input doesn't include the line before it. This check found damaged parameter files in the cache, which make zkir stop with status 1 ("Hash mismatch"): ${damaged.map((f) => `${f.file} (${f.state})`).join('; ')}.`;
      d.fix.push(`Delete ${damaged.length === 1 ? 'it' : 'them'} and compile again; zkir downloads new copies: ${damaged.map((f) => `\`rm '${f.file}'\``).join(', ')}.`);
      return d;
    }
    d.summary = 'zkir stopped with exit status 1, and the input doesn\'t include the line before it, which says why: "Failed to fetch data …" (a download that failed) or "Hash mismatch …" (a damaged cache file). The cache this check reads is intact.';
    for (const p of net) d.summary += ` ${p.base}: ${p.error ?? (p.status !== 200 ? `HTTP ${p.status}` : 'answers now')}.`;
    d.fix.push('Run this again with the whole compile output (--log, or pipe it in), or the two lines before the Exception.');
    return d;
  }

  if (status !== undefined || inp.error) {
    d.summary = `zkir stopped with exit status ${status ?? '?'}${inp.error ? `: ${inp.error}` : ''}. That isn't a known cause.`;
    d.fix.push('Open an issue at LFDT-Minokawa/compact with the contract, the compiler version and this output.');
    return d;
  }

  // No result in the output: it may still be running, or it ended without an error.
  const partial = caches.flatMap((x) => x.partial.map((p) => ({ ...p, dir: x.dir })));
  if ((m.run?.code === 0 && !k?.circuits.some((x) => !(x.prover > 0 && x.verifier > 0))) || (k?.circuits.length && k.good === k.circuits.length)) {
    d.known = true;
    d.ok = true;
    d.summary = k?.circuits.length ? 'No zkir failure: every circuit has its keys.' : 'No zkir failure: the compile finished.';
    return d;
  }
  if (partial.length && !(m.run && m.run.code !== null)) {
    const p = partial.sort((a, b) => a.ageS - b.ageS)[0];
    d.known = true;
    d.summary = `zkir ${p.ageS < 120 ? 'is downloading' : 'was downloading, and stopped,'} ${`bls_midnight_2p${p.k}`}: ${size(p.bytes)} of ${size(p.of)} so far (${path.join(p.dir, p.name)}, last written ${p.ageS} s ago).`;
    d.summary += ' zkir doesn\'t resume a download: each compile starts it again.';
    d.fix.push('Stop the compile, download the file with curl from srs.midnight.network, then compile again; zkir finds it in its cache:', ...prefetch(p.k).map((l) => `  ${l}`));
    return d;
  }
  d.summary = inp.circuits !== undefined
    ? 'The output ends after "Compiling … circuits:" with no error: the compile was still running, or it finished. Key generation for a large circuit takes minutes.'
    : 'No zkir failure in the input.';
  if (inp.circuits !== undefined && c.platform === 'linux' && c.vm) d.fix.push('If this is a Linux container on a Mac (Docker Desktop), key generation there was far slower in testing than with the native macOS build: compile natively instead (runbook, Root cause 6).');
  if (inp.circuits !== undefined && !opts.out) d.fix.push('Run this again with --out <the compile\'s output directory> to check the keys it wrote.');
  return d;
}

// ---------- main ----------
async function main() {
  let text;
  let run;
  if (opts.compile !== undefined) {
    if (!fs.existsSync(opts.compile)) fail(`${opts.compile}: no such file`);
    run = await compile();
    if (run.error) fail(run.error);
    text = run.text;
  } else if (opts.log !== undefined) {
    text = readMaybe(opts.log);
    if (text === undefined) fail(`can't read ${opts.log}`);
  } else if (opts.error !== undefined) {
    text = opts.error;
  } else if (!opts.machine && !process.stdin.isTTY) {
    text = fs.readFileSync(0, 'utf8');
  } else {
    opts.machine = true;
  }
  const inp = opts.machine ? {} : parse(text);

  const version = opts.compiler ?? defaultVersion();
  const versionFrom = opts.compiler ? 'argument' : version ? 'default' : undefined;
  const dirs = [cacheDir()];
  if (inp.hash && !dirs.some((x) => path.resolve(x.dir) === path.resolve(path.dirname(inp.hash.file)))) dirs.unshift({ dir: path.dirname(inp.hash.file), from: 'the error' });
  const m = { version, versionFrom, cpu: cpu(), mem: memory(), inst: install(version), caches: await cache(dirs), net: [], run };
  if (opts.out) m.keys = keys(opts.out, inp.circuits);

  // The download test: only when a download is involved, or for --machine.
  const downloading = opts.machine || inp.fetch || (inp.status === 1 && !inp.error && !inp.hash)
    || (inp.status === undefined && !inp.compileError && !inp.zkirMissing && !inp.toolchainSignal && run?.code !== 0);
  if (!opts.offline && downloading) {
    const hosts = new Set();
    if (inp.fetch) { try { const u = new URL(inp.fetch.url); hosts.add(`${u.origin}${u.pathname.replace(/[^/]*$/, '')}`); } catch { /* not a URL */ } }
    if (process.env.MIDNIGHT_PARAM_SOURCE) hosts.add(process.env.MIDNIGHT_PARAM_SOURCE);
    hosts.add(version !== undefined && vless(version, '0.34.0') ? S3 : SRS);
    hosts.add(SRS);
    m.net = await Promise.all([...hosts].map((h) => probe(h)));
  }

  const d = decide(inp, m);
  const exit = d.known ? 0 : 2;

  if (opts.json) {
    console.log(JSON.stringify({ input: inp, ...m, run: run && { code: run.code, signal: run.signal, out: opts.out }, mem: { ...m.mem, available: Number.isFinite(m.mem.available) ? m.mem.available : null }, result: { ...d, ok: d.ok === true, exit } }, null, 2));
    process.exit(exit);
  }

  const lines = [];
  if (!opts.machine) {
    const what = inp.status !== undefined ? `zkir stopped with exit status ${inp.status}${inp.status < 0 ? ` (${SIGNALS[-inp.status] ?? `signal ${-inp.status}`})` : inp.status === 101 ? ' (a Rust panic)' : ''}` : inp.zkirMissing ? 'compactc skipped zkir' : inp.toolchainSignal ? 'the compiler was killed by a signal' : run?.code === 0 ? 'finished' : 'no zkir exit status in the output';
    lines.push(`Compile: ${what}${inp.compiling ? `, after "${inp.compiling}"` : ''}${run ? `; compact exited ${run.code ?? run.signal}; output in ${opts.out}` : ''}`);
  }
  const c = m.cpu;
  const flag = (x) => (x === undefined ? '?' : x ? 'yes' : 'no');
  lines.push(`Machine: ${c.platform} ${c.arch}${c.model ? `, ${c.model}` : ''}${c.appleSilicon ? ', Apple Silicon' : ''}${c.adx !== undefined ? `; ADX ${flag(c.adx)}, BMI2 ${flag(c.bmi2)}` : ''}${c.vm ? '; virtual machine' : ''}${c.emulated ? `; running as ${c.emulated}` : ''}${c.unreadable ? `; couldn't read ${c.unreadable}` : ''}`);
  lines.push(`Memory: ${mb(m.mem.total)}${m.mem.limit !== undefined ? `, container limit ${mb(m.mem.limit)}` : ''}${m.mem.oomKills !== undefined ? `, out-of-memory kills in this cgroup: ${m.mem.oomKills}` : ''}`);
  const inst = m.inst;
  lines.push(`Compiler: ${version ?? 'unknown (pass --compiler)'}${versionFrom === 'default' ? ' (the default; pass --compiler if the compile used +<version>)' : ''}${inst.triple ? `, ${path.join(inst.dir, inst.triple)}` : ''}${inst.absent ? `, not installed under ${inst.dir}` : inst.problems ? (inst.problems.length ? `, install incomplete: ${inst.problems.join('; ')}` : `, install complete${inst.noArchive ? ' (no artifact.zip to compare; checked compactc.bin and zkir only)' : ''}`) : ''}`);
  for (const x of m.caches) {
    if (x.absent) { lines.push(`Parameter cache: ${x.dir} (${x.from}): empty`); continue; }
    const bad = x.files.filter((f) => f.state !== 'ok');
    lines.push(`Parameter cache: ${x.dir} (${x.from}): ${x.files.length ? `k = ${x.files.map((f) => f.k).join(', ')}` : 'no parameter files'}${x.files.length ? (bad.length ? `; ${bad.map((f) => `bls_midnight_2p${f.k} ${f.state}`).join('; ')}` : ', all intact') : ''}${x.partial.length ? `; unfinished downloads: ${x.partial.map((p) => `${p.name} ${size(p.bytes)} of ${size(p.of)}${p.ageS > 600 ? `, untouched for ${Math.round(p.ageS / 60)} min (safe to delete)` : ''}`).join(', ')}` : ''}`);
  }
  if (process.env.MIDNIGHT_PARAM_SOURCE) lines.push(`MIDNIGHT_PARAM_SOURCE: ${process.env.MIDNIGHT_PARAM_SOURCE}`);
  for (const n of m.net) lines.push(`Download test, ${n.base}: ${n.error ?? (n.status !== 200 ? `HTTP ${n.status}` : `ok, ${size(n.rate)}/s${n.partial ? ` (stopped after ${opts.timeout} s)` : n.good ? '' : ', but the file\'s SHA-256 is wrong'}`)}`);
  const k = m.keys;
  if (k) {
    if (k.missing) lines.push(`Keys: ${k.out} doesn't exist`);
    else if (k.keysOnly) lines.push(`Keys: ${k.out} has keys/ (${k.keyFiles} file${k.keyFiles === 1 ? '' : 's'}) but no zkir/: compactc deletes what it wrote when zkir fails, so this is a failed compile's output`);
    else if (k.noZkir) lines.push(`Keys: ${k.out} has no zkir/ directory (not a compile output, or compiled with --skip-zk)`);
    else {
      const bad = k.circuits.filter((x) => !(x.prover > 0 && x.verifier > 0));
      const unreached = k.total - k.circuits.length;
      lines.push(`Keys in ${path.join(k.out, 'keys')}: ${k.good} of ${k.total} circuit${k.total === 1 ? '' : 's'} complete${unreached ? ` (zkir didn't reach ${unreached} of them)` : ''}${bad.length ? `; ${bad.map((x) => `${x.name}: ${x.prover === undefined ? 'no prover' : x.prover === 0 ? 'empty prover' : 'prover ok'}, ${x.verifier === undefined ? 'no verifier' : x.verifier === 0 ? 'empty verifier' : 'verifier ok'}`).join('; ')}` : ''}`);
      if (k.staleContract) lines.push(`Contract: ${path.join(k.out, 'contract', 'index.js')} is older than zkir/: it is from an earlier compile, not this one`);
      else if (k.noContract) lines.push(`Contract: no contract/index.js (the compiler writes it only after zkir succeeds)`);
    }
  }
  lines.push('');
  lines.push(`${d.known && !d.ok && !opts.machine ? 'Known cause: ' : ''}${d.summary}`);
  if (d.fix.length) {
    if (!opts.machine) lines.push('Fix:');
    for (const f of d.fix) lines.push(f.startsWith('  ') ? `  ${f}` : `  - ${f}`);
  }
  if (k && !k.missing && (k.keysOnly || (!k.noZkir && (k.good < k.total || k.staleContract)))) lines.push(`Don't use this output: a deploy needs every circuit's verifier key, and proving needs the prover keys${k.staleContract ? '; its contract/ is from an earlier compile' : ''}. Compile again after the fix.`);
  if (d.refs.length) lines.push(`Issue: ${d.refs.join(', ')}`);
  lines.push('Runbook: compact-zkir-keygen-failures-runbook.md');
  console.log(lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n'));
  process.exit(exit);
}

main().catch((e) => fail(`check-zkir-crash: ${e.stack ?? e}`));
