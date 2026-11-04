#!/usr/bin/env node
/**
 * check-versions.mjs: read-only diagnostic. Do this project's Midnight toolchain and package
 * versions match what the target network supports, and do the contract and midnight-js load
 * the same on-chain runtime?
 *
 * Run it against the DApp repo (the directory with node_modules). It reads files, runs
 * `compact --version` and `compact compile --version`, and fetches the docs support matrix.
 * With --proof-server / --rpc it also asks those for their versions. Nothing is written,
 * signed or submitted.
 *
 * Requirements: Node >= 20 (global fetch). No npm install. npm, pnpm and Yarn classic layouts;
 * Yarn Plug'n'Play is detected and its package checks are skipped.
 *
 * Usage:
 *   node check-versions.mjs --network preprod --project <dapp dir> --compiled <out>
 *   export BLOCKFROST_PROJECT_ID=<your project token>          # never pass it as an argument
 *   node check-versions.mjs --network mainnet --project <dapp dir> --compiled <out> \
 *     --proof-server http://localhost:6300 --rpc https://rpc.midnight-mainnet.blockfrost.io
 *
 *   --network       preview | preprod | mainnet (required)
 *   --project       directory containing node_modules (default: current directory)
 *   --compiled      compiler output directory: the second argument you gave `compact compile`,
 *                   the one containing contract/, keys/ and zkir/. Needed for the contract checks.
 *   --proof-server  proof server base URL; reads GET /version
 *   --rpc           node RPC URL; reads midnight_ledgerVersion and system_version
 *   --matrix        support-matrix.json path or URL (default: midnight-docs main, on purpose,
 *                   because the matrix changes with every release)
 *
 * Status words: OK; MISMATCH (a combination shown to break, or one that cannot load);
 * DIFFERS (not the tested version, not shown to break); WARN; INFO; SKIP.
 *
 * Exit code: 0 = no mismatch found, 2 = at least one MISMATCH,
 *            1 = could not run (bad arguments, unreadable matrix, or a crash). 1 is never a verdict.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MATRIX_URL =
  'https://raw.githubusercontent.com/midnightntwrk/midnight-docs/main/docs/relnotes/support-matrix.json';
const NETWORKS = ['preview', 'preprod', 'mainnet'];
const USAGE =
  'usage: node check-versions.mjs --network <preview|preprod|mainnet> [--project <dir>] [--compiled <dir>] [--proof-server <url>] [--rpc <url>] [--matrix <file|url>]';
const RUNTIME = '@midnight-ntwrk/compact-runtime';
const ONCHAIN = '@midnight-ntwrk/onchain-runtime-v3';
// compact-runtime 0.19+ (compilers 0.34+) is built on this package instead, a 4.0.0 release
// candidate that no network runs.
const ONCHAIN_V4 = '@midnightntwrk/onchain-runtime-v4';
const COMPACT_JS = '@midnight-ntwrk/compact-js';
const PROTOCOL = '@midnight-ntwrk/midnight-js-protocol';

// Blockfrost: the key comes from the environment, never from an argument, and is redacted
// from every line printed.
const KEY = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? '';
const redact = (s) => (KEY ? String(s).split(encodeURIComponent(KEY)).join('<key>').split(KEY).join('<key>') : String(s));
const fail = (msg) => {
  console.error(redact(msg));
  process.exit(1);
};

if (Number(process.versions.node.split('.')[0]) < 20) fail(`Node >= 20 is required (this is ${process.version})`);

// ---------- arguments ----------
const args = process.argv.slice(2);
const opts = {};
const known = ['--network', '--project', '--compiled', '--proof-server', '--rpc', '--matrix'];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (!known.includes(a)) fail(`unknown argument '${a}'\n${USAGE}`);
  const v = args[i + 1];
  if (v === undefined || v === '' || v.startsWith('--')) fail(`${a} needs a value\n${USAGE}`);
  opts[a.slice(2)] = v;
  i++;
}
if (!opts.network) fail(USAGE);
if (!NETWORKS.includes(opts.network)) fail(`--network must be one of ${NETWORKS.join(', ')}, got '${opts.network}'`);
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const real = (p) => fs.realpathSync.native(p);
if (!isDir(opts.project ?? '.')) fail(`--project ${opts.project} is not a directory`);
const projectDir = real(path.resolve(opts.project ?? '.'));
let compiledDir;
if (opts.compiled) {
  if (!fs.existsSync(path.join(opts.compiled, 'contract', 'index.js'))) {
    fail(`--compiled ${opts.compiled} has no contract/index.js: pass the compiler output directory (the one with contract/, keys/, zkir/)`);
  }
  compiledDir = real(path.resolve(opts.compiled));
}
for (const k of ['proof-server', 'rpc']) {
  if (opts[k] && !/^https?:\/\//.test(opts[k])) fail(`--${k} must be an http(s) URL, got '${opts[k]}'`);
  if (opts[k]) {
    try {
      new URL(opts[k]);
    } catch {
      fail(`--${k} is not a valid URL: '${opts[k]}'`);
    }
  }
}
const withKey = (url) => {
  if (!KEY || url.includes('project_id=')) return url;
  if (!new URL(url).hostname.endsWith('blockfrost.io')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(KEY)}`;
};

// ---------- version helpers ----------
// Full version including any prerelease, e.g. "0.16.0" or "0.16.0-rc.0"; for tags like
// "compact-runtime-0.16.0" the version at the end.
const fullVer = (s) => String(s ?? '').match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/)?.[1] ?? String(s ?? '').match(/\d+\.\d+\.\d+/)?.[0];
const nums = (v) => String(v).split('-')[0].split('.').map(Number);
// The compiled contract's own rule (compact-runtime dist/version.js, checkRuntimeVersion):
// same major; while major is 0 the same minor; never an older minor; same minor needs a patch at
// least as new. Prerelease suffixes are ignored.
const runtimeAccepts = (expected, actual) => {
  const [e0, e1, e2] = nums(expected);
  const [a0, a1, a2] = nums(actual);
  return !(e0 !== a0 || (a0 === 0 && e1 !== a1) || e1 > a1 || (e1 === a1 && e2 > a2));
};

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};

async function loadMatrix(src) {
  let raw;
  try {
    if (/^https?:\/\//.test(src)) {
      const res = await fetch(src, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.text();
    } else {
      raw = fs.readFileSync(src, 'utf8');
    }
    const m = JSON.parse(raw);
    if (!Array.isArray(m?.components)) throw new Error('no "components" array');
    return m;
  } catch (e) {
    fail(`could not read the support matrix from ${src}: ${e.message}\n(offline? pass --matrix <file>)`);
  }
}

// ---------- package discovery ----------
const unreadable = new Set();
// Every physical copy of every package reachable from <dir>/node_modules: nested copies,
// workspace and `file:` links (symlinks are followed to their real path), pnpm's .pnpm store and
// Yarn's .store. Each real directory is visited once, so copies aren't double counted and
// symlink cycles end.
function scanNodeModules(root) {
  const found = new Map(); // name -> [{ version, dir }]
  const seen = new Set();
  const readdir = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') unreadable.add(d);
      return [];
    }
  };
  const target = (parent, ent) => {
    const p = path.join(parent, ent.name);
    if (!ent.isSymbolicLink()) return ent.isDirectory() ? p : undefined;
    try {
      return isDir(p) ? real(p) : undefined;
    } catch {
      return undefined;
    }
  };
  const walk = (nm, depth) => {
    if (depth > 20) return;
    let key;
    try {
      key = real(nm);
    } catch {
      return;
    }
    if (seen.has(`nm:${key}`)) return;
    seen.add(`nm:${key}`);
    for (const e of readdir(nm)) {
      if (e.name === '.bin' || e.name === '.cache') continue;
      const dir = target(nm, e);
      if (!dir) continue;
      if (e.name === '.pnpm') {
        for (const s of readdir(dir)) {
          const d = target(dir, s);
          if (d) walk(path.join(d, 'node_modules'), depth + 1);
        }
      } else if (e.name === '.store') {
        for (const s of readdir(dir)) {
          const d = target(dir, s);
          if (d) visit(path.join(d, 'package'), depth);
        }
      } else if (e.name.startsWith('@')) {
        for (const s of readdir(dir)) {
          const d = target(dir, s);
          if (d) visit(d, depth);
        }
      } else {
        visit(dir, depth);
      }
    }
  };
  const visit = (dir, depth) => {
    let key;
    try {
      key = real(dir);
    } catch {
      return;
    }
    if (seen.has(`pkg:${key}`)) return;
    seen.add(`pkg:${key}`);
    const pjPath = path.join(key, 'package.json');
    if (fs.existsSync(pjPath)) {
      const pkg = readJson(pjPath);
      if (!pkg) unreadable.add(pjPath);
      else if (pkg.name?.startsWith('@midnight') && pkg.version) {
        if (!found.has(pkg.name)) found.set(pkg.name, []);
        found.get(pkg.name).push({ version: pkg.version, dir: key });
      }
    }
    walk(path.join(key, 'node_modules'), depth + 1);
  };
  walk(path.join(root, 'node_modules'), 0);
  return found;
}

// The copy of `name` that Node would load for code in `fromDir`: walk up from the real path,
// checking each node_modules, and follow the link to the package's real directory. A directory
// that can't be read stops the walk with { unreadable: true }, so it isn't mistaken for "missing".
function resolveFrom(fromDir, name) {
  let d;
  try {
    d = real(fromDir);
  } catch {
    return undefined;
  }
  for (;;) {
    const p = path.join(d, 'node_modules', name);
    try {
      fs.statSync(p);
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        unreadable.add(path.dirname(p));
        return { unreadable: true, dir: p };
      }
    }
    if (isDir(p)) {
      const dir = real(p);
      const pkg = readJson(path.join(dir, 'package.json'));
      if (!pkg) unreadable.add(path.join(dir, 'package.json'));
      return { version: pkg?.version, dir };
    }
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

// The on-chain runtime a compact-runtime copy actually loads: whichever onchain-runtime package
// its package.json depends on (v3 for 0.16, v4 for 0.19+), resolved from its own directory.
function onchainOf(runtimeCopy) {
  if (!runtimeCopy || runtimeCopy.unreadable) return undefined;
  const deps = readJson(path.join(runtimeCopy.dir, 'package.json'))?.dependencies ?? {};
  const name = Object.keys(deps).find((n) => /onchain-runtime/.test(n)) ?? ONCHAIN;
  const r = resolveFrom(runtimeCopy.dir, name);
  return r ? { ...r, name } : undefined;
}

function findPnp(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.pnp.cjs')) || fs.existsSync(path.join(d, '.pnp.js'))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

function run(cmd, cmdArgs) {
  try {
    const out = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
    return { out: out.trim() };
  } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    return { error: e.signal === 'SIGTERM' ? 'timed out' : `exit ${e.status ?? e.code}` };
  }
}

async function rpc(url, method) {
  let res;
  try {
    res = await fetch(withKey(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw Object.assign(new Error(e.message), { unreachable: true });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body !== 'object') throw new Error('not a JSON-RPC response');
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  return body.result;
}

// ---------- checks ----------
const rows = []; // { component, installed, expected, status, note }
const fixes = [];
const add = (component, installed, expected, status, note = '') =>
  rows.push({ component, installed, expected: expected ?? '', status, note });
const fix = (s) => fixes.push(s);
const rel = (d) => path.relative(projectDir, d) || '.';
const listVersions = (cs) => [...new Set(cs.map((c) => c.version))].join(', ');

async function main() {
  const matrixSrc = opts.matrix ?? MATRIX_URL;
  const matrix = await loadMatrix(matrixSrc);
  // Each network entry has `version` (since midnight-docs f0d3fdc, 2026-10-09; `tag` is often null
  // now). Older copies of the matrix only have `tag`, e.g. `toolchain-0.31.1`.
  const expectedFor = (component) => {
    const c = matrix.components.find((x) => x.component === component);
    const v = c?.versions?.[opts.network];
    return fullVer(v?.version) ?? fullVer(v?.tag);
  };
  // These two decide MISMATCH rows. If the matrix no longer has them, stop rather than compare
  // against nothing.
  const expToolchain = expectedFor('Compact toolchain');
  const expRuntime = expectedFor('Compact runtime');
  for (const [name, v] of [['Compact toolchain', expToolchain], ['Compact runtime', expRuntime]]) {
    if (!v) fail(`the support matrix has no '${name}' version for ${opts.network}: its format may have changed. Pass --matrix <file> with a known-good copy, or check the docs page.`);
  }

  // 1. Compact devtools and the default compiler.
  const expDevtools = expectedFor('Compact devtools');
  const dt = run('compact', ['--version']);
  if (dt.missing) {
    add('Compact devtools', 'not found', expDevtools, 'SKIP', '`compact` is not on PATH');
  } else if (dt.error) {
    add('Compact devtools', 'unavailable', expDevtools, 'WARN', `\`compact --version\` ${dt.error}`);
  } else {
    const v = fullVer(dt.out);
    add('Compact devtools', v, expDevtools, !expDevtools ? 'WARN' : v === expDevtools ? 'OK' : 'DIFFERS', expDevtools ? '' : 'not in matrix');
    const tc = run('compact', ['compile', '--version']);
    if (tc.out) {
      // Only the default; a build can still pin another version with `compact compile +X`.
      // The compiled-contract rows are the authoritative check.
      const tv = fullVer(tc.out);
      const ok = tv === expToolchain;
      add('Compact compiler (default)', tv, expToolchain, ok ? 'OK' : 'WARN', ok ? '' : 'default only; your build may pin another');
      if (!ok) fix(`Your default compiler is ${tv}; ${opts.network} needs ${expToolchain}. Build with \`compact compile +${expToolchain} …\` (install it side by side with \`compact update ${expToolchain} --no-set-default\` if missing).`);
    } else {
      add('Compact compiler (default)', 'unavailable', expToolchain, 'WARN', `\`compact compile --version\` ${tc.error ?? 'failed'}`);
    }
  }

  // 2. Installed packages.
  const pnpRoot = findPnp(projectDir);
  const hasNodeModules = isDir(path.join(projectDir, 'node_modules'));
  if (pnpRoot) {
    add('Packages', 'Yarn Plug\'n\'Play', '', 'SKIP', 'package checks need node_modules; use `yarn why`');
    fix(`This project uses Yarn Plug'n'Play (${path.join(pnpRoot, '.pnp.cjs')}), which this script can't read. Check versions with \`yarn why @midnight-ntwrk/compact-runtime\` and \`yarn why @midnight-ntwrk/onchain-runtime-v3\`, or run it on a copy installed with \`nodeLinker: node-modules\`.`);
  } else if (!hasNodeModules) {
    // Every package check needs node_modules; carrying on would print a false "no mismatch".
    fail(`no node_modules in ${projectDir}: pass --project <the DApp directory that has node_modules>`);
  }
  const pkgs = !pnpRoot ? scanNodeModules(projectDir) : new Map();
  const copies = (name) => pkgs.get(name) ?? [];
  const checkPackages = !pnpRoot;

  // The copies midnight-js actually loads: the compact-runtime (and the on-chain runtime it
  // brings) reached from each midnight-js-protocol copy and from the compact-js each of those uses.
  const sdkRuntimes = [];
  const sdkSources = copies(PROTOCOL).length ? copies(PROTOCOL) : copies(COMPACT_JS);
  for (const p of sdkSources) {
    for (const from of [p.dir, resolveFrom(p.dir, COMPACT_JS)?.dir].filter(Boolean)) {
      const cr = resolveFrom(from, RUNTIME);
      if (cr && !cr.unreadable && !sdkRuntimes.some((x) => x.dir === cr.dir)) sdkRuntimes.push(cr);
    }
  }

  // The copies the contract loads (Node resolves from the importing file's directory).
  const contractFrom = compiledDir ? path.join(compiledDir, 'contract') : undefined;
  const contractRuntime = contractFrom ? resolveFrom(contractFrom, RUNTIME) : undefined;

  if (checkPackages) {
    // compact-runtime: what's loaded decides. A wrong version that midnight-js, the project root
    // or the contract loads is a MISMATCH; other copies are only listed.
    const rootRuntime = resolveFrom(projectDir, RUNTIME);
    const loaded = [];
    for (const c of [rootRuntime, contractRuntime, ...sdkRuntimes]) {
      if (c && !c.unreadable && !loaded.some((x) => x.dir === c.dir)) loaded.push(c);
    }
    // Copies found by the scan plus any loaded copy outside it (e.g. a contract package that
    // isn't linked into node_modules).
    const all = [...copies(RUNTIME)];
    for (const c of loaded) if (!all.some((x) => x.dir === c.dir)) all.push(c);
    const loadedDirs = new Set(loaded.map((c) => c.dir));
    const badLoaded = loaded.filter((c) => c.version && !runtimeAccepts(expRuntime, c.version));
    const others = all.filter((c) => !loadedDirs.has(c.dir));
    const shown = all.length > 1 ? `${all.length} copies: ${listVersions(all)}` : all[0]?.version;
    if (all.length === 0) {
      add('Compact runtime', 'not installed', expRuntime, 'SKIP');
    } else if (badLoaded.length) {
      add('Compact runtime', shown, expRuntime, 'MISMATCH', 'a loaded copy is the wrong version');
      fix(`${RUNTIME} ${listVersions(badLoaded)} is loaded (${badLoaded.map((c) => rel(c.dir)).join('; ')}); ${opts.network} needs ${expRuntime}. A contract compiled for one runtime fails on another with "Version mismatch: compiled code expects X, runtime is Y". Pin ${RUNTIME}@${expRuntime} exactly (an unpinned install takes npm's latest), reinstall, and check with \`npm ls ${RUNTIME}\` (or \`pnpm why\` / \`yarn why\`).`);
    } else if (others.some((c) => !runtimeAccepts(expRuntime, c.version))) {
      add('Compact runtime', shown, expRuntime, 'WARN', 'an unused copy is another version');
      fix(`Other ${RUNTIME} copies are installed but not loaded by the contract or midnight-js: ${others.map((c) => `${c.version} at ${rel(c.dir)}`).join('; ')}. Harmless today; remove them if nothing needs them.`);
    } else {
      add('Compact runtime', shown, expRuntime, 'OK', all.length > 1 ? 'all copies acceptable' : '');
    }

    // onchain-runtime-v3: a standard install of the matrix set already has two copies
    // (midnight-js pins 3.0.0, compact-runtime accepts ^3.0.0); that works. What has to match is
    // checked below, with --compiled.
    const oc = copies(ONCHAIN);
    const expOnchain = expectedFor('On-chain runtime');
    if (oc.length === 0) {
      add('On-chain runtime (v3)', 'not installed', expOnchain, 'SKIP');
    } else {
      add('On-chain runtime (v3)', oc.length > 1 ? `${oc.length} copies: ${listVersions(oc)}` : oc[0].version, expOnchain, !expOnchain ? 'WARN' : oc.every((c) => c.version === expOnchain) ? 'OK' : 'DIFFERS', !expOnchain ? 'not in matrix' : oc.length > 1 ? 'two copies are usual' : '');
    }
    const v4 = copies(ONCHAIN_V4);
    if (v4.length) {
      add('On-chain runtime (v4)', listVersions(v4), 'not used by networks', 'WARN', 'comes with compact-runtime 0.19+');
      fix(`${ONCHAIN_V4} ${listVersions(v4)} is installed (${v4.map((c) => rel(c.dir)).join('; ')}). It comes with compact-runtime 0.19 and later (compilers 0.34+), which target an on-chain runtime no network runs yet. Recompile with \`compact compile +${expToolchain} …\` and pin ${RUNTIME}@${expRuntime}.`);
    }

    // Other matrix components: a different version is reported, not counted as a mismatch.
    for (const [component, names, note] of [
      ['Compact JS', [COMPACT_JS]],
      ['Platform JS', ['@midnight-ntwrk/platform-js']],
      ['Midnight.js', ['@midnight-ntwrk/midnight-js-contracts', PROTOCOL]],
      ['testkit-js', ['@midnight-ntwrk/testkit-js']],
      ['DApp Connector API', ['@midnight-ntwrk/dapp-connector-api']],
      ['Wallet SDK', ['@midnight-ntwrk/wallet-sdk', '@midnightntwrk/wallet-sdk']],
    ]) {
      const exp = expectedFor(component);
      const cs = names.flatMap((n) => copies(n));
      if (cs.length === 0) {
        add(component, 'not installed', exp, 'SKIP');
        continue;
      }
      const vs = listVersions(cs);
      // "copies" only when one package is installed more than once.
      const dup = names.some((n) => copies(n).length > 1);
      const shownV = dup ? `${cs.length} copies: ${vs}` : vs;
      if (!exp) add(component, shownV, '', 'WARN', 'not in matrix');
      else add(component, shownV, exp, cs.every((c) => c.version === exp) ? 'OK' : 'DIFFERS', note ?? '');
    }

    // testkit-js 4.1.1 pins wallet-sdk 1.1.0 while the matrix says 1.2.0: expected, say so.
    const tk = copies('@midnight-ntwrk/testkit-js');
    if (tk.length && copies('@midnight-ntwrk/wallet-sdk').some((c) => c.version === '1.1.0')) {
      add('Wallet SDK via testkit-js', '1.1.0', expectedFor('Wallet SDK'), 'INFO', 'testkit-js 4.1.1 pins wallet-sdk 1.1.0');
    }

    // midnight-js packages should all be one release.
    const mjsVersions = [...new Set([...pkgs.entries()].filter(([n]) => n.startsWith('@midnight-ntwrk/midnight-js')).flatMap(([, cs]) => cs.map((c) => c.version)))];
    if (mjsVersions.length > 1) {
      add('midnight-js-* packages', mjsVersions.join(', '), 'one version', 'WARN', 'mixed releases');
      fix(`midnight-js packages are on mixed versions (${mjsVersions.join(', ')}). Install every @midnight-ntwrk/midnight-js-* package at the same version.`);
    }

    // Wallet SDK: two scopes publish parallel packages.
    if (copies('@midnight-ntwrk/wallet-sdk').length && copies('@midnightntwrk/wallet-sdk').length) {
      add('Wallet SDK scopes', 'both installed', 'one scope', 'WARN', '@midnight-ntwrk and @midnightntwrk');
      fix('Both @midnight-ntwrk/wallet-sdk and @midnightntwrk/wallet-sdk are installed. Use one scope for every wallet-sdk-* package.');
    }

    // Wallet SDK: facade 4.1.0 needs utilities >= 1.2.1 ("does not provide an export named 'Clock'").
    for (const scope of ['@midnight-ntwrk', '@midnightntwrk']) {
      for (const f of copies(`${scope}/wallet-sdk-facade`)) {
        if (f.version !== '4.1.0') continue;
        const u = resolveFrom(f.dir, `${scope}/wallet-sdk-utilities`);
        if (u?.version === '1.2.0') {
          add('wallet-sdk-utilities', u.version, '>= 1.2.1', 'MISMATCH', 'facade 4.1.0 imports Clock');
          fix(`${scope}/wallet-sdk-facade 4.1.0 (${rel(f.dir)}) loads ${scope}/wallet-sdk-utilities 1.2.0, which has no Clock export ("does not provide an export named 'Clock'"). Update utilities to 1.2.1 or later; remove any lockfile pin or override holding it at 1.2.0.`);
        }
      }
    }

    // Ledger: not in the matrix (it ships with the node). Copies are reported.
    const lc = copies('@midnight-ntwrk/ledger-v8');
    if (lc.length) {
      const multi = new Set(lc.map((c) => c.version)).size > 1;
      add('Ledger (ledger-v8)', lc.length > 1 ? `${lc.length} copies: ${listVersions(lc)}` : lc[0].version, 'not in matrix', multi ? 'WARN' : 'INFO', multi ? 'more than one version' : '');
    }
  }

  // 3. Compiled contract.
  if (compiledDir) {
    let src = '';
    try {
      src = fs.readFileSync(path.join(compiledDir, 'contract', 'index.js'), 'utf8');
    } catch (e) {
      add('Compiled contract', 'unreadable', '', 'WARN', e.code ?? e.message);
    }
    const wants = src.match(/checkRuntimeVersion\(\s*(['"`])([^'"`]+)\1\s*\)/)?.[2];
    if (src && !wants) add('Compiled contract wants runtime', 'no runtime pin found', expRuntime, 'WARN', 'unexpected compiler output');
    if (wants) {
      const supported = runtimeAccepts(wants, expRuntime);
      add('Compiled contract wants runtime', wants, expRuntime, supported ? 'OK' : 'MISMATCH', supported ? '' : 'built by an unsupported compiler');
      if (!supported) {
        fix(`The contract in ${rel(compiledDir)} was compiled for runtime ${wants}, but ${opts.network}'s stack (midnight-js) uses ${expRuntime}. Installing runtime ${wants} won't help: midnight-js then fails with "Failed to configure constructor context with coin public key". Recompile with \`compact compile +${expToolchain} …\` and keep ${RUNTIME} at ${expRuntime}.`);
      }
    }
    if (!pnpRoot) {
      if (!contractRuntime) {
        add('Runtime the contract loads', 'none found', wants ?? expRuntime, 'MISMATCH', 'contract cannot load');
        fix(`No ${RUNTIME} is reachable from ${compiledDir}. Install ${RUNTIME}@${expRuntime} in the package that imports the contract.`);
      } else if (contractRuntime.unreadable) {
        add('Runtime the contract loads', 'could not read', wants ?? expRuntime, 'WARN', rel(path.dirname(contractRuntime.dir)));
      } else if (!contractRuntime.version) {
        add('Runtime the contract loads', 'unreadable', wants ?? expRuntime, 'WARN', rel(contractRuntime.dir));
      } else if (wants) {
        const ok = runtimeAccepts(wants, contractRuntime.version);
        add('Runtime the contract loads', contractRuntime.version, wants, ok ? 'OK' : 'MISMATCH');
        if (!ok) fix(`The contract loads ${RUNTIME} ${contractRuntime.version} (${rel(contractRuntime.dir)}) but was compiled for ${wants}: "Version mismatch: compiled code expects ${wants}, runtime is ${contractRuntime.version}".`);
      }
      // The on-chain runtime owns the classes checked with instanceof. The contract (through its
      // compact-runtime) and midnight-js (through compact-js's compact-runtime) must reach the same
      // physical copy, or deploys fail with "expected instance of ContractMaintenanceAuthority".
      if (contractRuntime && !contractRuntime.unreadable) {
        const cOn = onchainOf(contractRuntime);
        const sdkOn = sdkRuntimes.map(onchainOf).filter(Boolean);
        if (!sdkRuntimes.length) {
          add('Contract and midnight-js share the on-chain runtime', 'midnight-js not found', 'yes', 'SKIP');
        } else if (!sdkOn.length) {
          add('Contract and midnight-js share the on-chain runtime', 'on-chain runtime not found', 'yes', 'SKIP');
        } else if (cOn && sdkOn.every((o) => o.dir === cOn.dir)) {
          add('Contract and midnight-js share the on-chain runtime', 'yes', 'yes', 'OK');
        } else {
          const other = sdkOn.find((o) => o.dir !== cOn?.dir);
          const desc = (o) => (o ? `${o.name.split('/')[1]} ${o.version} at ${rel(o.dir)}` : '(none)');
          add('Contract and midnight-js share the on-chain runtime', 'no', 'yes', 'MISMATCH', `${cOn ? `${cOn.name.split('/')[1]} ${cOn.version}` : 'none'} vs ${other.name.split('/')[1]} ${other.version}`);
          if (cOn && cOn.name !== other.name) {
            fix(`The contract's runtime loads ${desc(cOn)}, midnight-js loads ${desc(other)}: different on-chain runtimes. A compact-runtime 0.19+ copy brings onchain-runtime-v4: an unpinned runtime install, or a contract compiled by 0.34+. See the Compact runtime and compiled-contract rows.`);
          } else {
            fix(`The contract reaches the on-chain runtime at ${desc(cOn)}, midnight-js at ${desc(other)}. Deploys fail with "expected instance of ContractMaintenanceAuthority" even when both are the same version. Install ${RUNTIME}@${expRuntime} once where both resolve it (usually the workspace root), not inside the contract package, then reinstall.`);
          }
        }
      }
    }
    // ZKIR v3 is rejected by proof servers 8.1.0 and 8.1.3: "bad input" on /check and /prove.
    // Compilers before 0.36 write v3 only with --feature-zkir-v3; 0.36 always writes it.
    const zkirDir = path.join(compiledDir, 'zkir');
    let bz = [];
    let zkirReadable = true;
    try {
      bz = isDir(zkirDir) ? fs.readdirSync(zkirDir).filter((f) => f.endsWith('.bzkir')) : [];
    } catch {
      zkirReadable = false;
      unreadable.add(zkirDir);
    }
    if (zkirReadable && !bz.length) add('ZKIR format', 'no .bzkir', 'v2', 'SKIP', 'built with --skip-zk?');
    let v3 = 0;
    let unread = 0;
    for (const f of bz) {
      try {
        const fd = fs.openSync(path.join(zkirDir, f), 'r');
        const head = Buffer.alloc(40);
        const n = fs.readSync(fd, head, 0, 40, 0);
        fs.closeSync(fd);
        if (head.subarray(0, n).toString('latin1').includes('ir-source[v3')) v3++;
      } catch {
        unread++;
      }
    }
    if (v3) {
      const ps = expectedFor('Proof server');
      add('ZKIR format', `v3 (${v3} circuits)`, 'v2', 'MISMATCH', 'compiler 0.36+, or --feature-zkir-v3');
      fix(`The circuits were compiled to ZKIR v3: compiler 0.36 and later always write it, older ones with --feature-zkir-v3. Proof server ${ps ?? '8.1.x'} rejects them: midnight-js gets HTTP 400 "bad input" from /check. Recompile with \`compact compile +${expToolchain} …\` and without --feature-zkir-v3.`);
    } else if (bz.length > unread) {
      add('ZKIR format', 'v2', 'v2', 'OK');
    }
    if (unread) add('ZKIR format', `${unread} unreadable .bzkir`, '', 'WARN', rel(zkirDir));
  }

  // 4. Proof server.
  const expProof = expectedFor('Proof server');
  if (opts['proof-server']) {
    const base = opts['proof-server'].replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/version`, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      add('Proof server', 'unreachable', expProof, 'WARN', e.message);
    }
    if (res && !res.ok) {
      add('Proof server', 'error', expProof, 'WARN', `HTTP ${res.status}`);
    } else if (res) {
      const v = fullVer(await res.text().catch(() => ''));
      if (!v) {
        add('Proof server', 'no version', expProof, 'WARN', 'answered without a version (wrong URL or port?)');
      } else {
        add('Proof server', v, expProof, !expProof ? 'WARN' : v === expProof ? 'OK' : 'DIFFERS', expProof ? '' : 'not in matrix');
        if (expProof && v !== expProof) fix(`The proof server is ${v}; ${opts.network} is tested with ${expProof}. Run midnightntwrk/proof-server:${expProof}.`);
      }
    }
  } else {
    add('Proof server', 'not checked', expProof, 'SKIP', 'pass --proof-server');
  }

  // 5. Node: report what it runs. A version label alone doesn't identify a build, so print the
  // build commit and ledger version.
  if (opts.rpc) {
    try {
      const nodeLedger = fullVer(await rpc(opts.rpc, 'midnight_ledgerVersion'));
      if (!nodeLedger) throw new Error('no ledger version in the RPC response');
      const build = await rpc(opts.rpc, 'system_version');
      add('Node build', build, '', 'INFO');
      add('Node ledger', nodeLedger, '', 'INFO');
      const [nma, nmi] = nums(nodeLedger);
      const differing = [...new Set(copies('@midnight-ntwrk/ledger-v8').map((c) => c.version))].filter((v) => {
        const [ma, mi] = nums(v);
        return ma !== nma || mi !== nmi;
      });
      if (differing.length) {
        add('Ledger vs node', `${differing.join(', ')} vs ${nodeLedger}`, 'same minor', 'WARN', 'different minor version');
        fix(`ledger-v8 ${differing.join(', ')} and the node's ledger ${nodeLedger} differ in minor version. Use the midnight-js release the matrix lists for ${opts.network}; it brings a compatible ledger.`);
      }
    } catch (e) {
      add('Node', e.unreachable ? 'unreachable' : 'bad response', '', 'WARN', e.message);
    }
  } else {
    add('Node', 'not checked', '', 'SKIP', 'pass --rpc');
  }

  if (unreadable.size) {
    add('Unreadable paths', String(unreadable.size), '', 'WARN', 'results may be incomplete');
    fix(`Could not read: ${[...unreadable].slice(0, 5).join('; ')}${unreadable.size > 5 ? ' …' : ''}. Check permissions; copies in those places weren't checked.`);
  }

  // ---------- report ----------
  const cols = ['component', 'installed', 'expected', 'status'];
  const width = Object.fromEntries(cols.map((k) => [k, Math.min(Math.max(k.length, ...rows.map((r) => String(r[k]).length)), k === 'installed' ? 44 : 60)]));
  const cell = (s, n) => {
    const t = String(s ?? '');
    return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n);
  };
  const out = (s) => console.log(redact(s));
  out(`check-versions: network ${opts.network}, project ${projectDir}`);
  out(`matrix: ${matrixSrc === MATRIX_URL ? 'midnight-docs main' : matrixSrc}\n`);
  out(`${cell('component', width.component)}  ${cell('installed', width.installed)}  ${cell('matrix', width.expected)}  ${cell('status', width.status)}  note`);
  for (const r of rows) out(`${cell(r.component, width.component)}  ${cell(r.installed, width.installed)}  ${cell(r.expected, width.expected)}  ${cell(r.status, width.status)}  ${r.note}`);
  const mismatches = rows.filter((r) => r.status === 'MISMATCH').length;
  if (fixes.length) {
    out('\nWhat to do:');
    for (const f of fixes) out(`  - ${f}`);
  }
  out(
    mismatches
      ? `\nRESULT: ${mismatches} mismatch(es). See the runbook for the matching error text.`
      : '\nRESULT: no mismatch found. DIFFERS and WARN rows are worth a look but were not shown to break.',
  );
  return mismatches;
}

try {
  const mismatches = await main();
  process.exit(mismatches ? 2 : 0);
} catch (e) {
  fail(`check-versions failed: ${e?.message ?? e}`);
}
