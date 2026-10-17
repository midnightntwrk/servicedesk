#!/usr/bin/env node
/**
 * test-check-zkir-crash.mjs: runs check-zkir-crash.mjs on recorded compile output and checks what it
 * says and the exit code. No network and no compiler: the machine (CPU, memory, compiler install,
 * parameter cache) is faked through the checker's CHECK_ZKIR_* variables, the download hosts are a
 * local mock, and --compile runs a fake `compact`.
 *
 * The compile outputs are real: each was captured on 2026-10-17 from the compiler version in its
 * name (see check-zkir-crash.NOTES.md), with local paths replaced.
 *
 *   node test-check-zkir-crash.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-zkir-crash.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'test-check-zkir-'));

// ---------- recorded compile output ----------
const LOG = {
  panic757: `Compiling 1 circuits:

thread 'main' (1559197) panicked at /nix/var/nix/builds/nix-15970-4075347429/cargo-vendor-dir/midnight-proofs-0.8.1/src/dev/cost_model.rs:286:44:
called \`Result::unwrap()\` on an \`Err\` value: Synthesis("Relation::circuit error: Synthesis(\\"Unsupported test_eq: JubjubScalar == JubjubScalar\\")")
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
Exception: zkir returned a non-zero exit status 101
`,
  panic616: `Compiling 1 circuits:

thread 'main' (1558873) panicked at /nix/var/nix/builds/nix-2896-2019762533/cargo-vendor-dir/midnight-zk-stdlib-2.3.5/src/lib.rs:753:35:
ZkStdLibArch must enable jubjub
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
Exception: zkir returned a non-zero exit status 101
`,
  panic299: `Compiling 1 circuits:

thread 'main' (1559334) panicked at /nix/var/nix/builds/nix-5199-3780227706/cargo-vendor-dir/midnight-circuits-6.0.0/src/field/native/native_gadget.rs:174:13:
Trying to convert Fq(0x0000000000000000000000000000000000000000000000000000000000000100) to an AssignedBounded less than 2^8!
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
Exception: zkir returned a non-zero exit status 101
`,
  panic280: `Compiling 1 circuits:

thread 'main' (1559572) panicked at /nix/var/nix/builds/nix-5199-3780227705/cargo-vendor-dir/midnight-proofs-0.7.0/src/dev/cost_model.rs:272:44:
called \`Result::unwrap()\` on an \`Err\` value: Synthesis("cannot convert JubjubPoint to \\"Native\\"")
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
Exception: zkir returned a non-zero exit status 101
`,
  hash: (file) => `Compiling 1 circuits:
Error: Hash mismatch in data stored at ${file}. Found hash 900bdfd597f96e59c0b4aebdfc3f3f26e4379a55dc8ae5a50865acd96e732510, but expected 0a1c9229f315fc1868ff25f668fb83aec4d09f4f23a706b5197c692c619d72c6. Please try removing this file to force a re-fetch. If that does not work, you may be subject to an attack.
Exception: zkir returned a non-zero exit status 1
`,
  fetch: (base) => `Compiling 1 circuits:
Error: Failed to fetch data from ${base}bls_midnight_2p5 after 3 attempts. Giving up.
Exception: zkir returned a non-zero exit status 1
`,
  sigill: `Compiling 1 circuits:
Exception: zkir returned a non-zero exit status -4
`,
  oom: `Compiling 1 circuits:
Exception: zkir returned a non-zero exit status -9
`,
  compactcKilled: `Error: Failed to run compactc

Caused by:
    compiler toolchain was terminated by a signal
`,
  noZkir: 'Warning: ZKIR not found; skipping final circuit compilation.\n',
  ok: 'Compiling 1 circuits:\n',
};
const S3_URL = 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/';
const SRS_URL = 'https://srs.midnight.network/';

// ---------- fake machines ----------
const write = (rel, data) => { const f = path.join(TMP, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const cpuinfo = (flags, model = 'Intel(R) Xeon(R) CPU E5-2680 v3 @ 2.50GHz') => `processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: ${model}\nflags\t\t: ${flags}\n\n`;
const HASWELL_VM = write('cpu/haswell-vm', cpuinfo('fpu vme sse4_2 avx avx2 bmi1 bmi2 hypervisor'));
const STONEY = write('cpu/stoney', cpuinfo('fpu vme sse4_2 avx avx2 bmi1 bmi2', 'AMD A6-9225 RADEON R4, 5 COMPUTE CORES 2C+2G'));
const ICELAKE = write('cpu/icelake', cpuinfo('fpu vme sse4_2 avx avx2 bmi1 bmi2 adx'));
const ARM = write('cpu/arm', 'processor\t: 0\nBogoMIPS\t: 48.00\nFeatures\t: fp asimd evtstrm aes pmull sha1 sha2 crc32\nCPU implementer\t: 0x61\n\n');
const SYSCTL_ROSETTA = write('sysctl/rosetta.json', JSON.stringify({ 'machdep.cpu.brand_string': 'Apple M2', 'hw.optional.arm64': '1', 'sysctl.proc_translated': '1' }));
const SYSCTL_INTEL = write('sysctl/intel.json', JSON.stringify({ 'machdep.cpu.brand_string': 'Intel(R) Core(TM) i5-1038NG7 CPU @ 2.00GHz', 'machdep.cpu.leaf7_features': 'SMEP BMI2 ERMS ADX SMAP', 'hw.optional.arm64': undefined }));
const cgroup = (name, max, oomKill) => {
  write(`cg/${name}/memory.max`, `${max}\n`);
  write(`cg/${name}/memory.events`, `low 0\nhigh 0\nmax 3\noom 1\noom_kill ${oomKill}\noom_group_kill 0\n`);
  return path.join(TMP, 'cg', name);
};
const CG_500M_KILLED = cgroup('500m', 524288000, 1);
const CG_96M = cgroup('96m', 100663296, 0);
const CG_NONE = cgroup('none', 'max', 0);
// cgroup v1: no memory.max; the limit and the kill count are under memory/.
write('cg/v1/memory/memory.limit_in_bytes', '1073741824\n');
write('cg/v1/memory/memory.oom_control', 'oom_kill_disable 0\nunder_oom 0\noom_kill 2\n');
const CG_V1 = path.join(TMP, 'cg', 'v1');
write('cg/v1-unlimited/memory/memory.limit_in_bytes', '9223372036854771712\n');
const CG_V1_UNLIMITED = path.join(TMP, 'cg', 'v1-unlimited');

// A compiler install, with the artifact.zip it was unpacked from (stored, no compression).
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name), d = Buffer.from(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, n, d); central.push(ch, n);
    off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const TOOLCHAIN = { compactc: '#!/bin/sh\n', 'compactc.bin': 'x'.repeat(5000), zkir: 'z'.repeat(3000), 'zkir-v3': 'v'.repeat(3000) };
function compactDir(name, { truncate, drop, prepend } = {}) {
  const td = path.join(TMP, 'compact', name, 'versions', '0.31.1', 'x86_64-unknown-linux-musl');
  fs.mkdirSync(td, { recursive: true });
  const z = zip(TOOLCHAIN);
  fs.writeFileSync(path.join(td, 'artifact.zip'), prepend ? Buffer.concat([Buffer.alloc(prepend, 7), z]) : z);
  for (const [f, data] of Object.entries(TOOLCHAIN)) {
    if (f === drop) continue;
    fs.writeFileSync(path.join(td, f), f === truncate ? data.slice(0, 1000) : data, { mode: 0o755 });
  }
  return path.join(TMP, 'compact', name);
}
const COMPACT_OK = compactDir('ok');
const COMPACT_TRUNCATED = compactDir('truncated', { truncate: 'compactc.bin', prepend: 4096 });
const COMPACT_NO_ZKIR = compactDir('nozkir', { drop: 'zkir' });
const COMPACT_NO_ZKIR_V3 = compactDir('nozkirv3', { drop: 'zkir-v3' });

// A parameter cache. P0 is the real bls_midnight_2p0, 580 bytes (both hosts serve the same bytes, and
// its SHA-256 is the checker's PARAM_SHA256[0]).
const P0 = Buffer.from(
  'AAAAABfx06cxl9eUJpVjjE+prA/DaIxPl3S5BaFOOj8XG6xYbFXoP/l6Gu/7OvAK2yLGuwiz9IHjqqDxoJ4w7XQdiuT89eCV' +
  '1dAK9gDbGMssBLPt0DzHRKKIiuQMqiMpRsXn4Rfx06cxl9eUJpVjjE+prA/DaIxPl3S5BaFOOj8XG6xYbFXoP/l6Gu/7OvAK' +
  '2yLGuwiz9IHjqqDxoJ4w7XQdiuT89eCV1dAK9gDbGMssBLPt0DzHRKKIiuQMqiMpRsXn4RPgK2BScZ9gfazToIgnT2VZa9DQ' +
  'mSC2GrXaYbvcf1BJM0zxEhOUXVflrH0FXQQrfgJKorLwjwqRJggFJy3FEFHG5HrU+kA7ArRRC2R649F3C6wDJqgFu+/UgFbI' +
  'wSG9uAYGxKAupzTMMqzSsCvCi5nLPih+hadjryZ0kqtXLpmrPzcNJ1zsHaGqqQdf8F95vgzl1SdyfW4RjMnNxtouNRqt/Zuq' +
  'jL3Tp21CmmlRYNEskjrJzDusoonhk1SGCLgoAQS74aJPzE+YjG7yaNDBFg6sCgxPU9gL1089LkZnvidAhiWoOCU1TifHCFmI' +
  'MQLrQwestWmzGHwP0Zk5gKpSpuniCAuWl/q5ar1cXxw7mIJW8tmTZvG7zPE88OIHAv7hjA8IF5YEq+jBggu+0REnQI3LUHKt' +
  'yrhXdKMtUYtoI1CwaiKoe/F4h3MqCvRd38y/+BDhsiHipZEdb5aDo29Of+fUQoHehqGGzBBsMzb1j+zgHnZtxBR9OOMZNhBa' +
  'SUTLWQ==',
  'base64',
);
function cacheDir(name, files) {
  const d = path.join(TMP, 'cache', name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, data] of Object.entries(files)) fs.writeFileSync(path.join(d, f), data);
  return d;
}
const CACHE_GOOD = cacheDir('good', { bls_midnight_2p0: P0 });
const damaged = Buffer.from(P0); damaged[100] ^= 0xff;
const CACHE_DAMAGED = cacheDir('damaged', { bls_midnight_2p0: P0, bls_midnight_2p5: Buffer.alloc(6532, 1), bls_midnight_2p1: damaged.subarray(0, 300) });
const CACHE_PARTIAL = cacheDir('partial', { bls_midnight_2p0: P0, '.bls_midnight_2p19.7DFGtS': Buffer.alloc(138851) });
const CACHE_PART = cacheDir('part', { bls_midnight_2p0: P0, 'bls_midnight_2p6.part': Buffer.alloc(5000) });
const CACHE_OLD_PARTIAL = cacheDir('old-partial', { bls_midnight_2p0: P0, '.bls_midnight_2p17.Ab12Cd': Buffer.alloc(4096) });
fs.utimesSync(path.join(CACHE_OLD_PARTIAL, '.bls_midnight_2p17.Ab12Cd'), new Date(Date.now() - 7200e3), new Date(Date.now() - 7200e3));
const XDG = path.join(TMP, 'xdg');
fs.mkdirSync(path.join(XDG, 'midnight', 'zk-params'), { recursive: true });
fs.writeFileSync(path.join(XDG, 'midnight', 'zk-params', 'bls_midnight_2p0'), damaged);
fs.mkdirSync(path.join(TMP, 'home', '.cache', 'midnight', 'zk-params'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'home', '.cache', 'midnight', 'zk-params', 'bls_midnight_2p0'), P0);

// A compile output directory.
function outDir(name, circuits, prover, verifier) {
  const d = path.join(TMP, 'out', name);
  fs.mkdirSync(path.join(d, 'zkir'), { recursive: true });
  fs.mkdirSync(path.join(d, 'keys'), { recursive: true });
  for (const c of circuits) {
    fs.writeFileSync(path.join(d, 'zkir', `${c}.zkir`), '{}');
    fs.writeFileSync(path.join(d, 'zkir', `${c}.bzkir`), 'ir-source');
    if (prover !== undefined) fs.writeFileSync(path.join(d, 'keys', `${c}.prover`), Buffer.alloc(prover));
    if (verifier !== undefined) fs.writeFileSync(path.join(d, 'keys', `${c}.verifier`), Buffer.alloc(verifier));
  }
  return d;
}
const OUT_EMPTY_KEYS = outDir('empty', ['increment'], 0, 0);
const OUT_GOOD = outDir('good', ['increment', 'decrement'], 14071, 1351);
const OUT_NONE = outDir('none', ['grind']);
// After -4, compactc has deleted zkir/ and compiler/: only an empty keys/ is left.
const OUT_KEYS_ONLY = path.join(TMP, 'out', 'keys-only');
fs.mkdirSync(path.join(OUT_KEYS_ONLY, 'keys'), { recursive: true });
// A failed compile into a directory that held an earlier build: contract/ is older than zkir/.
const OUT_STALE = outDir('stale', ['increment'], 0, 0);
write('out/stale/contract/index.js', 'export {}');
fs.utimesSync(path.join(OUT_STALE, 'contract', 'index.js'), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
write('out/good/contract/index.js', 'export {}');

// A fake `compact` for --compile: prints a recorded output and exits like compact does.
const FAKE_COMPACT = write('bin/compact', `#!/bin/sh
case " $* " in *" --version "*) echo 0.31.1; exit 0;; esac
printf 'Compiling 1 circuits:\\nException: zkir returned a non-zero exit status -4\\n' >&2
exit 255
`);
fs.chmodSync(FAKE_COMPACT, 0o755);
const FAKE_COMPACT_OK = write('bin/compact-ok', `#!/bin/sh
echo "$*" >> "\${CHECK_ZKIR_TEST_ARGS:-/dev/null}"
case " $* " in *" --version "*) echo 0.31.1; exit 0;; esac
printf 'Compiling 1 circuits:\\n' >&2
exit 0
`);
fs.chmodSync(FAKE_COMPACT_OK, 0o755);

// ---------- the mock download hosts ----------
// /srs/ serves a file with the wrong bytes (the checker must say so), /s3/ answers 403, /slow/ never
// answers, /drip/ sends 64 KB and then nothing.
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/srs/')) { res.writeHead(200, { 'content-type': 'binary/octet-stream' }); res.end(Buffer.alloc(786820, 3)); return; }
  if (req.url.startsWith('/drip/')) { res.writeHead(200, { 'content-length': '786820' }); res.write(Buffer.alloc(65536, 3)); return; }
  if (req.url.startsWith('/s3/')) { res.writeHead(403); res.end('forbidden'); return; }
  if (req.url.startsWith('/slow/')) return; // leave it hanging
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
// A port nothing listens on: bind one, then close it.
const CLOSED = await new Promise((r) => { const t = http.createServer(); t.listen(0, '127.0.0.1', () => { const { port } = t.address(); t.close(() => r(`http://127.0.0.1:${port}`)); }); });

// ---------- running the checker ----------
function run(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHECK, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: path.join(TMP, 'home'),
        CHECK_ZKIR_PLATFORM: 'linux',
        CHECK_ZKIR_ARCH: 'x64',
        CHECK_ZKIR_CPUINFO: ICELAKE,
        CHECK_ZKIR_CGROUP: CG_NONE,
        CHECK_ZKIR_TOTALMEM: String(16 * 2 ** 30),
        CHECK_ZKIR_COMPACT: FAKE_COMPACT,
        COMPACT_DIRECTORY: COMPACT_OK,
        MIDNIGHT_PP: CACHE_GOOD,
        CHECK_ZKIR_SRS: `${BASE}/srs/`,
        CHECK_ZKIR_S3: `${BASE}/s3/`,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input ?? '');
  });
}

const cases = [
  // panics with an issue
  { name: 'panic #757, 0.34.0 zkir-v3', args: ['--compiler', '0.34.0', '--offline'], input: LOG.panic757, exit: 0, has: ['exit status 101 (a Rust panic)', 'after "Compiling 1 circuits:"', 'JubjubScalar', 'Upgrade to compiler 0.35.0', '(r as Field) != (0 as Field)', 'LFDT-Minokawa/compact#757'] },
  { name: 'panic #616, 0.35.0 zkir-v3', args: ['--compiler', '0.35.0', '--offline'], input: LOG.panic616, exit: 0, has: ['Jubjub gadgets', 'Build without --feature-zkir-v3', '(0.34.0 and 0.35.0)', 'LFDT-Minokawa/compact#616'] },
  { name: 'panic #299, constant out of range', args: ['--compiler', '0.31.1', '--offline'], input: LOG.panic299, exit: 0, has: ['fixed at compile time, 256,', 'type of 8 bits', 'LFDT-Minokawa/compact#299'] },
  { name: 'panic #280, 0.31.1 zkir-v3', args: ['--compiler', '0.31.1', '--offline'], input: LOG.panic280, exit: 0, has: ["can't compare JubjubPoint", 'LFDT-Minokawa/compact#280'] },
  { name: 'unknown panic', args: ['--offline'], input: LOG.panic616.replace('ZkStdLibArch must enable jubjub', 'index out of bounds: the len is 3 but the index is 7'), exit: 2, has: ["isn't a known panic", 'index out of bounds', 'Try the other backend'] },
  { name: 'exit 101 without the panic lines', args: ['--error', 'Exception: zkir returned a non-zero exit status 101', '--offline'], exit: 2, has: ["doesn't include the panic message"] },
  { name: 'an unknown zkir error after colour codes', args: ['--offline'], input: 'Compiling 1 circuits:\n\x1b[2K\x1b[1GError: Custom { kind: Other, error: "boom" }\nException: zkir returned a non-zero exit status 1\n', exit: 2, has: ['exit status 1: Error: Custom { kind: Other, error: "boom" }', "isn't a known cause"] },
  { name: 'panic under a terminal progress bar', args: ['--offline'], input: `Compiling 1 circuits:\r\n  circuit "test" |\x1b[2K\r\x1b[32m  circuit "test"\x1b[0m |\r\n${LOG.panic299.split('\n').slice(2).join('\n')}`, exit: 0, has: ['LFDT-Minokawa/compact#299'] },

  // public parameters
  { name: 'hash mismatch: names the file and the rm', args: ['--offline'], input: LOG.hash(path.join(CACHE_DAMAGED, 'bls_midnight_2p5')), env: { MIDNIGHT_PP: CACHE_DAMAGED }, exit: 0, has: ["SHA-256 isn't the one zkir checks for", `rm '${path.join(CACHE_DAMAGED, 'bls_midnight_2p5')}'`, 'bls_midnight_2p5 damaged: wrong SHA-256', 'bls_midnight_2p1 wrong size: 300 bytes, expected 772', 'These are damaged too', `curl -fL --retry 5 -C - -o '${CACHE_DAMAGED}/bls_midnight_2p5.part'`] },
  { name: 'hash mismatch in a cache the checker doesn\'t use', args: ['--offline'], input: LOG.hash(path.join(CACHE_DAMAGED, 'bls_midnight_2p5')), exit: 0, has: [`${CACHE_DAMAGED} (the error)`, `${CACHE_GOOD} (MIDNIGHT_PP): k = 0, all intact`] },
  { name: 'download failed from S3, both hosts tested', args: ['--compiler', '0.31.1'], input: LOG.fetch(`${BASE}/s3/`), exit: 0, has: ["couldn't download the public parameters bls_midnight_2p5 (7 KB)", `${BASE}/s3/: HTTP 403`, `Download test, ${BASE}/srs/: ok`, "the file's SHA-256 is wrong", 'curl -fL --retry 5'] },
  { name: 'srs with 0.31.1: no User-Agent', args: ['--compiler', '0.31.1', '--offline'], input: LOG.fetch(SRS_URL), exit: 0, has: ["Compiler 0.31.1's zkir sends no User-Agent", 'HTTP 403', 'Remove MIDNIGHT_PARAM_SOURCE from the shell or CI job'] },
  { name: 'srs with 0.31.1 and MIDNIGHT_PARAM_SOURCE set here', args: ['--compiler', '0.31.1', '--offline'], input: LOG.fetch(SRS_URL), env: { MIDNIGHT_PARAM_SOURCE: SRS_URL }, exit: 0, has: ['Unset MIDNIGHT_PARAM_SOURCE', 'MIDNIGHT_PARAM_SOURCE points it there', `MIDNIGHT_PARAM_SOURCE: ${SRS_URL}`] },
  { name: 'srs with 0.35.0 is not the User-Agent case', args: ['--compiler', '0.35.0', '--offline'], input: LOG.fetch(SRS_URL), exit: 0, has: ['after 3 tries', 'Download the file with curl'], not: ['User-Agent'] },
  { name: 'srs with an unknown version', args: ['--offline'], input: LOG.fetch(SRS_URL), env: { CHECK_ZKIR_COMPACT: '/nonexistent/compact' }, exit: 0, has: ['If this compile used 0.31.x or older', 'Compiler: unknown (pass --compiler)'] },
  { name: 'srs with only the default version', args: ['--offline'], input: LOG.fetch(SRS_URL), exit: 0, has: ['If this compile used 0.31.x or older (pass --compiler to be sure)', '(the default; pass --compiler if the compile used +<version>)'] },
  { name: 'a failed download the checker\'s cache already has', args: ['--compiler', '0.35.0', '--offline'], input: LOG.fetch(SRS_URL).replace('2p5', '2p0'), exit: 0, has: ['already has an intact bls_midnight_2p0, so the compile used a different cache'] },
  { name: 'status 1 alone, with a damaged cache', args: ['--error', 'Exception: zkir returned a non-zero exit status 1', '--offline'], env: { MIDNIGHT_PP: CACHE_DAMAGED }, exit: 0, has: ["the input doesn't include the line before it", 'bls_midnight_2p5', `rm '${path.join(CACHE_DAMAGED, 'bls_midnight_2p5')}'`], not: ['Open an issue'] },
  { name: 'status 1 alone, intact cache', args: ['--error', 'Exception: zkir returned a non-zero exit status 1', '--compiler', '0.31.1'], exit: 2, has: ['which says why', 'the two lines before the Exception', `Download test, ${BASE}/s3/`], not: ['Open an issue'] },
  { name: 'a host that sends a little and stalls', args: ['--compiler', '0.31.1', '--timeout', '3'], input: LOG.fetch(`${BASE}/drip/`), exit: 0, has: [`${BASE}/drip/: ok,`, '(stopped after 3 s)'] },
  { name: 'neither host reachable', args: ['--compiler', '0.31.1', '--timeout', '2'], input: LOG.fetch(`${CLOSED}/s3/`), env: { CHECK_ZKIR_SRS: `${CLOSED}/srs/`, CHECK_ZKIR_S3: `${CLOSED}/s3/` }, exit: 0, has: ["This machine can't reach either host now", 'the connection was refused (ECONNREFUSED)', 'copy it into this cache', '.part'] },
  { name: 'a curl .part file counts as unfinished', args: ['--machine', '--compiler', '0.31.1', '--offline'], env: { MIDNIGHT_PP: CACHE_PART }, exit: 0, has: ['unfinished downloads: bls_midnight_2p6.part 5 KB of 13 KB'] },
  { name: 'a host that never answers', args: ['--compiler', '0.31.1', '--timeout', '1'], input: LOG.fetch(`${BASE}/slow/`), exit: 0, has: [`${BASE}/slow/: no answer in 1 s`] },

  // the CPU
  { name: '-4 in a VM that hides ADX', args: ['--offline'], input: LOG.sigill, env: { CHECK_ZKIR_CPUINFO: HASWELL_VM }, exit: 0, has: ['exit status -4 (SIGILL)', "doesn't have ADX", 'hypervisor flag', 'x86-64-v2-AES', "host-passthrough", 'midnightntwrk/compact#42', 'ADX no, BMI2 yes; virtual machine'] },
  { name: '-4 on a CPU without ADX', args: ['--offline'], input: LOG.sigill, env: { CHECK_ZKIR_CPUINFO: STONEY }, exit: 0, has: ['AMD A6-9225', 'Broadwell', 'Atom-class', '--skip-zk'], not: ['hypervisor'] },
  { name: '-4 on a CPU with ADX', args: ['--offline'], input: LOG.sigill, exit: 2, has: ['this CPU has ADX', "doesn't fit"] },
  { name: '-4, x86_64 emulated on ARM', args: ['--offline'], input: LOG.sigill, env: { CHECK_ZKIR_CPUINFO: ARM }, exit: 0, has: ['an x86_64 program on an ARM machine', 'arm64 image', 'aarch64-unknown-linux-musl'] },
  { name: '-4 under Rosetta 2', args: ['--offline'], input: LOG.sigill, env: { CHECK_ZKIR_PLATFORM: 'darwin', CHECK_ZKIR_SYSCTL: SYSCTL_ROSETTA }, exit: 0, has: ['Rosetta 2', 'uname -m', 'Apple Silicon'] },
  { name: '-4 on an Intel Mac reads sysctl', args: ['--offline'], input: LOG.sigill, env: { CHECK_ZKIR_PLATFORM: 'darwin', CHECK_ZKIR_SYSCTL: SYSCTL_INTEL }, exit: 2, has: ['ADX yes, BMI2 yes', 'this CPU has ADX'] },
  { name: '-4 where /proc/cpuinfo can\'t be read', args: ['--offline'], input: LOG.sigill, env: { CHECK_ZKIR_CPUINFO: '/nonexistent' }, exit: 2, has: ["couldn't be read"] },

  // memory and signals
  { name: '-9 in a container that recorded an OOM kill', args: ['--offline'], input: LOG.oom, env: { CHECK_ZKIR_CGROUP: CG_500M_KILLED }, exit: 0, has: ['exit status -9 (SIGKILL)', 'ran out of memory', 'This container has 500 MB', 'recorded 1 out-of-memory kill.', 'docker run --memory 4g', 'container limit 500 MB'], not: ['can also come from outside'] },
  { name: '-9 with no OOM record', args: ['--offline'], input: LOG.oom, exit: 0, has: ['This machine has 16,384 MB', 'can also come from outside', 'k = 19, 2,808 MB'] },
  { name: '-9 under cgroup v1', args: ['--offline'], input: LOG.oom, env: { CHECK_ZKIR_CGROUP: CG_V1 }, exit: 0, has: ['This container has 1,024 MB', 'recorded 2 out-of-memory kills.'] },
  { name: 'cgroup v1 with no limit', args: ['--offline'], input: LOG.oom, env: { CHECK_ZKIR_CGROUP: CG_V1_UNLIMITED }, exit: 0, has: ['This machine has 16,384 MB'], not: [', container limit'] },
  { name: 'macOS has no cgroup', args: ['--offline'], input: LOG.oom, env: { CHECK_ZKIR_PLATFORM: 'darwin', CHECK_ZKIR_SYSCTL: SYSCTL_INTEL, CHECK_ZKIR_CGROUP: CG_500M_KILLED }, exit: 0, has: ['This machine has 16,384 MB'], not: [', container limit', 'out-of-memory kills in this cgroup', 'recorded'] },
  { name: '-6 without an allocation message', args: ['--offline'], input: 'Compiling 1 circuits:\nException: zkir returned a non-zero exit status -6\n', exit: 2, has: ["crashed with SIGABRT. That isn't a known cause"] },
  { name: '-11', args: ['--offline'], input: 'Compiling 1 circuits:\nException: zkir returned a non-zero exit status -11\n', exit: 2, has: ['SIGSEGV', 'Open an issue at LFDT-Minokawa/compact'] },
  { name: '-15 from outside', args: ['--offline'], input: 'Compiling 2 circuits:\nException: zkir returned a non-zero exit status -15\n', exit: 0, has: ['stopped from outside by SIGTERM', 'Let it finish'] },

  // the compiler install
  { name: 'compactc killed, truncated install', args: ['--compiler', '0.31.1', '--offline'], input: LOG.compactcKilled, env: { COMPACT_DIRECTORY: COMPACT_TRUNCATED }, exit: 0, has: ['compactc.bin is 1,000 bytes, the archive has 5,000', 'already installed', `rm -rf '${path.join(COMPACT_TRUNCATED, 'versions', '0.31.1')}'`, `compact --directory '${COMPACT_TRUNCATED}' update 0.31.1 --no-set-default`, 'leave out --no-set-default to make 0.31.1 the default', 'install incomplete'], not: ['add `--no-set-default` only'] },
  { name: 'compactc killed in 96 MB', args: ['--compiler', '0.31.1', '--offline'], input: LOG.compactcKilled, env: { CHECK_ZKIR_CGROUP: CG_96M }, exit: 0, has: ['has 96 MB of memory', 'compactc alone peaked at 228 MB', 'install complete'] },
  { name: 'compactc killed, no known cause', args: ['--compiler', '0.31.1', '--offline'], input: LOG.compactcKilled, exit: 2, has: ['neither known cause fits'] },
  { name: 'ZKIR not found, zkir missing from the install', args: ['--compiler', '0.31.1', '--offline'], input: LOG.noZkir, env: { COMPACT_DIRECTORY: COMPACT_NO_ZKIR }, exit: 0, has: ['finished without keys', 'zkir is missing', 'rm -r'] },
  { name: 'ZKIR not found, install complete', args: ['--compiler', '0.31.1', '--offline'], input: LOG.noZkir, exit: 0, has: ['compactc.bin directly'] },
  { name: 'status 127: zkir-v3 missing from the install', args: ['--compiler', '0.31.1', '--offline'], input: 'sh: line 0: exec: zkir-v3: not found\nException: zkir returned a non-zero exit status 127\n', env: { COMPACT_DIRECTORY: COMPACT_NO_ZKIR_V3 }, exit: 0, has: ["couldn't start zkir-v3", 'zkir-v3 is missing', 'rm -rf'] },
  { name: 'another positive status', args: ['--offline'], input: 'Compiling 1 circuits:\nException: zkir returned a non-zero exit status 2\n', exit: 2, has: ["exit status 2. That isn't a known cause"], not: ['No zkir failure'] },
  { name: 'compiler not installed', args: ['--compiler', '0.29.0', '--offline'], input: LOG.noZkir, exit: 0, has: [`isn't installed: \`compact --directory '${COMPACT_OK}' update 0.29.0 --no-set-default\``] },

  // not zkir, or no failure
  { name: 'a compile error is not this runbook', args: ['--offline'], input: 'Exception: counter.compact line 4 char 25:\n  unbound identifier JubjubScalar\n', exit: 2, has: ['Not a zkir failure', 'unbound identifier JubjubScalar', 'compact-ai-generated-compile-errors-runbook.md'] },
  { name: 'an internal compiler error', args: ['--offline'], input: 'Internal error (please report): Exception: failed assertion cannot-happen\nat line 558, char 20 of compiler/zkir-v3-passes.ss\n', exit: 2, has: ['internal error', '--skip-zk'] },
  { name: 'no failure, all keys written', args: ['--out', OUT_GOOD, '--offline'], input: LOG.ok, exit: 0, has: ['2 of 2 circuits complete', 'every circuit has its keys'], not: ["Don't use this output", 'Contract:'] },
  { name: 'empty keys after a failed download', args: ['--out', OUT_EMPTY_KEYS, '--compiler', '0.31.1', '--offline'], input: LOG.fetch(S3_URL), exit: 0, has: ['0 of 1 circuit complete; increment: empty prover, empty verifier', "Don't use this output"] },
  { name: 'stale contract/ next to empty keys', args: ['--out', OUT_STALE, '--compiler', '0.31.1', '--offline'], input: LOG.fetch(S3_URL), exit: 0, has: ['index.js is older than zkir/', 'its contract/ is from an earlier compile'] },
  { name: 'no keys after a panic', args: ['--out', OUT_NONE, '--offline'], input: LOG.panic299, exit: 0, has: ['grind: no prover, no verifier', 'no contract/index.js'] },
  { name: 'circuits zkir never reached are counted', args: ['--out', OUT_NONE, '--offline'], input: LOG.panic299.replace('Compiling 1 circuits:', 'Compiling 3 circuits:'), exit: 0, has: ["0 of 3 circuits complete (zkir didn't reach 2 of them)", "Don't use this output"] },
  { name: 'only keys/ left after -4', args: ['--out', OUT_KEYS_ONLY, '--offline'], input: LOG.sigill, env: { CHECK_ZKIR_CPUINFO: STONEY }, exit: 0, has: ["has keys/ (0 files) but no zkir/", "failed compile's output", "Don't use this output"], not: ['not a compile output'] },
  { name: 'a --out that does not exist', args: ['--out', path.join(TMP, 'out', 'nope'), '--offline'], input: LOG.panic299, exit: 0, has: ["doesn't exist"], not: ['has no zkir/ directory', "Don't use this output"] },
  { name: 'output ends at Compiling, a download unfinished', args: [], input: LOG.ok, env: { MIDNIGHT_PP: CACHE_PARTIAL }, exit: 0, has: ['zkir is downloading bls_midnight_2p19: 136 KB of 96 MB', `curl -fL --retry 5 -C - -o '${CACHE_PARTIAL}/bls_midnight_2p19.part'`, 'unfinished downloads'] },
  { name: 'an old unfinished download is safe to delete', args: ['--machine', '--compiler', '0.31.1', '--offline'], env: { MIDNIGHT_PP: CACHE_OLD_PARTIAL }, exit: 0, has: ['.bls_midnight_2p17.Ab12Cd 4 KB of 24 MB, untouched for ', ' min (safe to delete)'] },
  { name: 'output ends at Compiling, nothing else known', args: ['--offline'], input: LOG.ok, exit: 2, has: ['still running, or it finished', '--out'], not: ['Docker Desktop'] },
  { name: 'output ends at Compiling in a Linux VM', args: ['--offline'], input: LOG.ok, env: { CHECK_ZKIR_CPUINFO: write('cpu/icelake-vm', cpuinfo('fpu vme sse4_2 avx avx2 bmi1 bmi2 adx hypervisor')) }, exit: 2, has: ['Docker Desktop', 'Root cause 6'] },
  { name: 'empty input', args: ['--offline'], input: '', exit: 2, has: ['No zkir failure in the input'] },

  // --machine, --compile, --json, arguments
  { name: '--machine on a CPU without ADX', args: ['--machine', '--compiler', '0.31.1', '--offline'], env: { CHECK_ZKIR_CPUINFO: STONEY, MIDNIGHT_PP: CACHE_DAMAGED }, exit: 2, has: ['this CPU has no ADX', 'bls_midnight_2p5 is damaged'] },
  { name: 'cache from XDG_CACHE_HOME', args: ['--machine', '--compiler', '0.31.1', '--offline'], env: { MIDNIGHT_PP: '', XDG_CACHE_HOME: XDG }, exit: 2, has: [`${path.join(XDG, 'midnight', 'zk-params')} (XDG_CACHE_HOME)`, 'bls_midnight_2p0 damaged: wrong SHA-256'] },
  { name: 'cache from HOME', args: ['--machine', '--compiler', '0.31.1', '--offline'], env: { MIDNIGHT_PP: '' }, exit: 0, has: [`${path.join(TMP, 'home', '.cache', 'midnight', 'zk-params')} (HOME): k = 0, all intact`] },
  { name: '--machine with 0.31.1 pointed at srs', args: ['--machine', '--compiler', '0.31.1', '--offline'], env: { MIDNIGHT_PARAM_SOURCE: SRS_URL }, exit: 2, has: ['sends no User-Agent', 'every parameter download will fail'], not: ['Found:\n\n'] },
  { name: '--machine with 0.35.0 pointed at srs is fine', args: ['--machine', '--compiler', '0.35.0', '--offline'], env: { MIDNIGHT_PARAM_SOURCE: SRS_URL }, exit: 2, has: ["compiler 0.35.0 isn't installed"], not: ['User-Agent'] },
  { name: '--machine in a 500 MB container', args: ['--machine', '--compiler', '0.31.1', '--offline'], env: { CHECK_ZKIR_CGROUP: CG_500M_KILLED }, exit: 2, has: ['only 500 MB of memory'] },
  { name: '--machine in a 1 GB container', args: ['--machine', '--compiler', '0.31.1', '--offline'], env: { CHECK_ZKIR_CGROUP: CG_V1 }, exit: 0, has: ['Nothing found'] },
  { name: '--machine, nothing wrong', args: ['--machine', '--compiler', '0.31.1', '--offline'], exit: 0, has: ['Nothing found on this machine that stops zkir', 'k = 0, all intact'] },
  { name: '--machine runs the download test', args: ['--machine', '--compiler', '0.31.1'], exit: 0, has: [`Download test, ${BASE}/s3/: HTTP 403`, `Download test, ${BASE}/srs/: ok`] },
  { name: '--compile runs compact and reads its output', args: ['--compile', write('src/c.compact', 'export circuit f(): [] {}'), '--compiler', '0.31.1', '--offline'], env: { CHECK_ZKIR_CPUINFO: HASWELL_VM }, exit: 0, has: ['compact exited 255', "doesn't have ADX"] },
  { name: '--compile that succeeds', args: ['--compile', path.join(TMP, 'src', 'c.compact')], env: { CHECK_ZKIR_COMPACT: FAKE_COMPACT_OK }, exit: 0, has: ['Compile: finished, after "Compiling 1 circuits:"; compact exited 0; output in', 'No zkir failure: the compile finished.'], not: ['Known cause', 'Download test'] },
  { name: '--directory reaches compact and the install check', args: ['--compile', path.join(TMP, 'src', 'c.compact'), '--directory', COMPACT_TRUNCATED, '--offline'], env: { CHECK_ZKIR_COMPACT: FAKE_COMPACT_OK, CHECK_ZKIR_TEST_ARGS: path.join(TMP, 'compact-args.log') }, exit: 0, has: ['install incomplete', path.join(COMPACT_TRUNCATED, 'versions', '0.31.1')], after: () => { const a = fs.readFileSync(path.join(TMP, 'compact-args.log'), 'utf8'); return a.includes(`--directory ${COMPACT_TRUNCATED} compile`) ? '' : `compact was run as: ${a}`; } },
  { name: 'the default version comes from compact', args: ['--offline'], input: LOG.sigill, exit: 2, has: ['Compiler: 0.31.1 (the default; pass --compiler if the compile used +<version>), ', 'x86_64-unknown-linux-musl, install complete'] },
  { name: '--json', args: ['--json', '--compiler', '0.31.1', '--offline'], input: LOG.oom, env: { CHECK_ZKIR_CGROUP: CG_500M_KILLED }, exit: 0, json: (j) => j.input.status === -9 && j.mem.oomKills === 1 && j.mem.limit === 524288000 && j.result.known === true && j.result.ok === false && j.result.exit === 0 && j.inst.problems.length === 0 },
  { name: '--json on a clean compile', args: ['--json', '--out', OUT_GOOD, '--offline'], input: LOG.ok, exit: 0, json: (j) => j.result.ok === true && j.result.exit === 0 },
  { name: 'unknown argument', args: ['--nope'], exit: 1, err: ['unknown argument --nope'] },
  { name: 'two inputs', args: ['--log', 'a', '--error', 'b'], exit: 1, err: ['use one of --log, --error and --compile'] },
  { name: 'bad --compiler', args: ['--compiler', 'latest'], exit: 1, err: ['--compiler takes a version'] },
];

// Four at a time; results print in order.
const results = new Array(cases.length);
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < cases.length) {
    const i = next++;
    const t0 = Date.now();
    results[i] = { ...(await run(cases[i].args, { input: cases[i].input, env: cases[i].env })), ms: Date.now() - t0 };
  }
}));
let failed = 0;
for (const [i, c] of cases.entries()) {
  const r = results[i];
  const ms = r.ms;
  const problems = [];
  if (r.code !== c.exit) problems.push(`exit ${r.code}, expected ${c.exit}`);
  if (/Download test, https:/.test(r.out)) problems.push('the download test reached a real host; the test must stay offline');
  for (const s of c.has ?? []) if (!r.out.includes(s)) problems.push(`missing: ${s}`);
  for (const s of c.not ?? []) if (r.out.includes(s)) problems.push(`unexpected: ${s}`);
  for (const s of c.err ?? []) if (!r.err.includes(s)) problems.push(`stderr missing: ${s}`);
  if (c.after) { const why = c.after(); if (why) problems.push(why); }
  if (c.json) { try { if (!c.json(JSON.parse(r.out))) problems.push('JSON check failed'); } catch (e) { problems.push(`not JSON: ${e.message}`); } }
  if (problems.length) {
    failed++;
    console.log(`FAIL ${c.name}\n  ${problems.join('\n  ')}\n  --- stdout ---\n${r.out.replace(/^/gm, '  ')}${r.err ? `  --- stderr ---\n${r.err.replace(/^/gm, '  ')}` : ''}`);
  } else {
    console.log(`ok   ${c.name} (${ms} ms)`);
  }
}
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${cases.length - failed} of ${cases.length} passed`);
process.exit(failed ? 1 : 0);
