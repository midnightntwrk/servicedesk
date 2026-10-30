#!/usr/bin/env node
/**
 * check-project-setup.mjs: why do npm, yarn or Node fail in this Midnight project before any Midnight code runs?
 *
 * It answers, for one project folder (the current folder unless you name one):
 *   1. Is there a package.json here, and is it valid JSON? If there is none, which folders below have one?
 *   2. With --script, is that script here, or only in a workspace?
 *   3. Does the Node running this match the project's engines field and .nvmrc, and npm its devEngines?
 *   4. On WSL, are node, npm and npx the Linux ones, or Windows' from /mnt/c?
 *   5. If the project uses Yarn, is yarn on PATH, is it Corepack's when the project pins Yarn 2 or newer,
 *      and can `corepack enable` write its shims?
 *   6. Can `npm install -g` write to npm's global folder without root?
 *   7. Does a workspace depend on a local package under a name that differs only in case?
 *   8. Is the project's GitHub repo, or the template it was made from, archived? Did create-mn-app make it?
 *   9. Does the project still configure midnight-mcp?
 *  10. How much disk space is free?
 *
 * It reads the project's files, runs `npm --version` and `npm config get prefix` (not on Windows), and asks the GitHub API
 * whether the repo is archived (no token needed; --offline skips it). It installs nothing, changes nothing and signs nothing.
 *
 * Requirements: Node >= 18.15. No npm install. Run it with the same `node` you run npm with.
 *
 * Usage:
 *   node check-project-setup.mjs [<project-folder>]
 *   add --script <name>   the script npm or yarn said is missing
 *   add --offline         to skip the GitHub API
 *
 * Exit code: 0 = nothing found (NOTE lines may still say something),
 *            2 = a finding (each FINDING line names the runbook step),
 *            1 = it could not run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GITHUB_API = 'https://api.github.com';
// Below this, npm can run out of room unpacking a project's dependencies. A judgment call, not a measurement.
const LOW_DISK_BYTES = 2 * 1024 ** 3;
// How far below the folder to look for a package.json when it has none, and how many folders to read at most.
const SEARCH_DEPTH = 3;
const SEARCH_MAX_DIRS = 2000;
const SKIP_DIRS = new Set(['node_modules', '.git']);
// Where editors and agents keep their MCP servers, relative to the project folder.
const MCP_CONFIGS = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.claude/settings.json'];
// create-mn-app writes this into the package.json description of every project it makes.
const CREATE_MN_APP_MARK = 'created with create-mn-app';

const say = (s = '') => console.log(s);
const fail = (s) => { console.error(s); process.exit(1); };

function parseArgs(argv) {
  const out = { dir: '.', offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') out.offline = true;
    else if (a === '--script') {
      out.script = argv[++i];
      if (!out.script) fail('--script needs the script name, for example --script setup');
    } else if (a === '-h' || a === '--help') {
      say('usage: node check-project-setup.mjs [<project-folder>] [--script <name>] [--offline]');
      process.exit(0);
    } else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else out.dir = a;
  }
  return out;
}

// --- versions ---------------------------------------------------------------------------------

const parseVersion = (v) => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function comparator(c, v) {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(c);
  if (!m) return undefined;
  const [, op = '', ...raw] = m;
  const wild = (p) => p === undefined || /[xX*]/.test(p);
  const first = raw.findIndex(wild); // the first part left open, -1 when all three are given
  if (first === 0) return true;
  const lo = raw.map((p) => (wild(p) ? 0 : Number(p)));
  // The first version past a partial one: 22 -> 23.0.0, 22.1 -> 22.2.0.
  const next = first === 1 ? [lo[0] + 1, 0, 0] : first === 2 ? [lo[0], lo[1] + 1, 0] : undefined;
  switch (op) {
    case '>=': return cmp(v, lo) >= 0;
    case '<': return cmp(v, lo) < 0;
    case '>': return next ? cmp(v, next) >= 0 : cmp(v, lo) > 0;
    case '<=': return next ? cmp(v, next) < 0 : cmp(v, lo) <= 0;
    case '~': return cmp(v, lo) >= 0 && cmp(v, next ?? [lo[0], lo[1] + 1, 0]) < 0;
    case '^': return cmp(v, lo) >= 0 && cmp(v, lo[0] > 0 || first === 1 ? [lo[0] + 1, 0, 0] : [0, lo[1] + 1, 0]) < 0;
    default: return next ? cmp(v, lo) >= 0 && cmp(v, next) < 0 : cmp(v, lo) === 0;
  }
}

// Does a Node version satisfy an engines range? true, false, or undefined for a range this small parser
// does not read (hyphen ranges, prerelease tags). It reads >=, >, <=, <, =, ^, ~, x and ||.
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return undefined;
  let unread = false;
  for (const set of String(range).split('||')) {
    const parts = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const results = (parts.length ? parts : ['*']).map((p) => comparator(p, v));
    if (results.every((r) => r === true)) return true;
    // One part this parser can't read (a hyphen range's "-") leaves the whole set unread.
    if (results.includes(undefined)) unread = true;
  }
  return unread ? undefined : false;
}

// .nvmrc names a version (22, v24.11.1) or an alias (lts/*, node). Only a version is compared:
// 'same' when every part it names matches, 'major' when only the major does, 'other' otherwise.
export function nvmrcMatch(version, nvmrc) {
  const want = /^v?(\d+(?:\.\d+){0,2})$/.exec(String(nvmrc).trim());
  if (!want) return undefined;
  const parts = want[1].split('.');
  const have = String(version).replace(/^v/, '').split('.');
  if (parts.every((p, i) => p === have[i])) return 'same';
  return parts[0] === have[0] ? 'major' : 'other';
}

// --- the folder -------------------------------------------------------------------------------

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  try { return { json: JSON.parse(text) }; } catch (e) { return { error: e.message }; }
}

function projectsBelow(dir) {
  const found = [];
  let read = 0;
  const walk = (d, left) => {
    if (++read > SEARCH_MAX_DIRS) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, 'package.json'))) found.push(sub);
      else if (left > 1) walk(sub, left - 1);
    }
  };
  walk(dir, SEARCH_DEPTH);
  return found;
}

// The folders a package.json's workspaces field names. Reads plain paths and * segments; a pattern with
// ** or a partial * (pkg-*) is skipped.
function workspaceDirs(dir, pkg) {
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const out = [];
  for (const pattern of patterns) {
    let dirs = [dir];
    for (const seg of String(pattern).replace(/\/+$/, '').split('/')) {
      if (seg === '*') {
        dirs = dirs.flatMap((d) => {
          try {
            return fs.readdirSync(d, { withFileTypes: true })
              .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
              .map((e) => path.join(d, e.name));
          } catch { return []; }
        });
      } else if (seg.includes('*')) { dirs = []; break; } else dirs = dirs.map((d) => path.join(d, seg));
    }
    out.push(...dirs.filter((d) => fs.existsSync(path.join(d, 'package.json'))));
  }
  return [...new Set(out)];
}

function gitRemote(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const dotGit = path.join(d, '.git');
    try {
      const gitDir = fs.statSync(dotGit).isDirectory() ? dotGit : path.resolve(d, fs.readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim());
      const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
      return /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
    } catch {
      if (path.dirname(d) === d) return undefined;
    }
  }
}

export const githubRepo = (url) => /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? '')?.slice(1).join('/');

// A workspace inherits its package manager from the repo root, so look up to the nearest lockfile or
// packageManager field.
function usesYarn(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'yarn.lock'))) return true;
    if (fs.existsSync(path.join(d, 'package-lock.json'))) return false;
    const pm = readJson(path.join(d, 'package.json'))?.json?.packageManager;
    if (pm) return String(pm).startsWith('yarn@');
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) return false;
  }
}

// The Yarn the nearest packageManager field pins, and whether that folder's .yarnrc.yml sets yarnPath to a
// checked-in release, which any yarn on PATH hands over to.
function yarnPin(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const pm = readJson(path.join(d, 'package.json'))?.json?.packageManager;
    if (pm) {
      let yarnrc = '';
      try { yarnrc = fs.readFileSync(path.join(d, '.yarnrc.yml'), 'utf8'); } catch { /* none */ }
      const m = /^yarn@(\d+)/.exec(String(pm));
      return m ? { version: String(pm).replace(/^yarn@/, '').replace(/\+.*/, ''), major: Number(m[1]), yarnPath: /^yarnPath:/m.test(yarnrc) } : undefined;
    }
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) return undefined;
  }
}

// The npm range the nearest devEngines field names, at or above the folder: a workspace inherits the root's.
function npmWanted(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const pm = readJson(path.join(d, 'package.json'))?.json?.devEngines?.packageManager;
    const npm = [pm].flat().find((e) => e?.name === 'npm' && e.version);
    if (npm) return npm.version;
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) return undefined;
  }
}

const depsOf = (pkg) => ({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });

// --- the machine ------------------------------------------------------------------------------

// Everything gatherFacts reads from the machine, so the test can replace it.
export const realSystem = {
  platform: process.platform,
  nodeVersion: process.version,
  execPath: process.execPath,
  env: process.env,
  home: os.homedir(),
  procVersion: () => { try { return fs.readFileSync('/proc/version', 'utf8'); } catch { return ''; } },
  isExecutable: (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } },
  exists: (p) => fs.existsSync(p),
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
  // Can this user create files in p? For a folder that does not exist yet, the nearest one that does.
  writable: (p) => {
    let d = p;
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; }
  },
  run: (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 }),
  freeBytes: (dir) => { const s = fs.statfsSync(dir); return s.bavail * s.bsize; },
  fetch: (...a) => fetch(...a),
};

function which(cmd, sys) {
  const win = sys.platform === 'win32';
  const exts = win ? (sys.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (sys.env.PATH || '').split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (sys.isExecutable(p)) return p;
    }
  }
  return undefined;
}

async function repoState(full, sys) {
  const res = await sys.fetch(`${GITHUB_API}/repos/${full}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'servicedesk-check-project-setup' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`the GitHub API answered HTTP ${res.status}`);
  const j = await res.json();
  const t = j.template_repository;
  return { archived: Boolean(j.archived), template: t ? { full: t.full_name, archived: Boolean(t.archived) } : undefined };
}

// --- report -----------------------------------------------------------------------------------

const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const list = (xs, max = 12) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));

// The report for the facts gathered, and the exit code it gives. Exported so the test can feed it
// facts gathered from folders it builds.
export function report(f) {
  const lines = [];
  const findings = [];
  const finding = (s) => { findings.push(s); lines.push(s); };
  const rel = (d) => path.relative(f.dir, d) || '.';

  lines.push(`NODE ${f.node.version} at ${f.node.execPath}${f.node.wsl ? ', on WSL' : ''}`);
  if (f.node.windowsOnWsl) finding(`WSL FINDING: this is Windows' Node running in a WSL folder (${f.dir}). Windows' npm and npx can't use a \\\\wsl path, so they fall back to C:\\Windows. Remediation 4.`);
  if (f.node.wsl) {
    const windows = Object.entries(f.tools).filter(([k, p]) => ['node', 'npm', 'npx'].includes(k) && p?.startsWith('/mnt/'));
    if (windows.length) finding(`WSL FINDING: ${windows.map(([k, p]) => `${k} is Windows' (${p})`).join(', ')}. Run in WSL, they treat the project as a Windows path. Remediation 4.`);
    if (f.dir.startsWith('/mnt/')) lines.push('WSL NOTE: the project is on the Windows drive (/mnt/...). Microsoft recommends keeping it in the WSL file system, such as under ~.');
  }

  const pkg = f.pkg?.json;
  if (!f.pkg) {
    const below = f.below.map((d) => rel(d));
    finding(below.length
      ? `PROJECT FINDING: no package.json in ${f.dir}, so npm has nothing to read. Folders below with one: ${list(below)}. If one is the project you meant, Remediation 1; if none is, Remediation 2.`
      : `PROJECT FINDING: no package.json in ${f.dir} or in the folders below it. The project was never created or cloned here. Remediation 2.`);
  } else if (f.pkg.error) {
    finding(`PROJECT FINDING: package.json is not valid JSON (${f.pkg.error}). Fix it where the message points, often a missing comma: npm reports this as EJSONPARSE.`);
  } else {
    const pm = f.usesYarn ? 'yarn' : 'npm';
    lines.push(`PROJECT ${pkg.name ?? '(no name)'} in ${f.dir}, run with ${pm}${f.workspaces.length ? `, ${f.workspaces.length} workspace(s)` : ''}`);
    const scripts = Object.keys(pkg.scripts ?? {});
    if (f.script) {
      const run = f.usesYarn ? 'yarn' : 'npm run';
      if (scripts.includes(f.script)) lines.push(`SCRIPT ok: "${f.script}" is in this package.json. Run it here with ${run} ${f.script}.`);
      else {
        const inWs = f.workspaces.filter((w) => Object.keys(w.scripts).includes(f.script));
        if (inWs.length) {
          const w = inWs[0];
          const how = f.usesYarn ? `yarn workspace ${w.name} run ${f.script}` : `npm run ${f.script} --workspace ${w.name}`;
          finding(`SCRIPT FINDING: "${f.script}" is not in this package.json, only in workspace ${list(inWs.map((x) => `${x.name} (${rel(x.dir)})`), 4)}. Run it in the one you mean: cd ${rel(w.dir)} first, or ${how}. Remediation 1.`);
        } else {
          finding(`SCRIPT FINDING: no "${f.script}" script here or in any workspace. This project's scripts: ${list(scripts) || 'none'}. The command came from another project's guide. Remediation 2.`);
        }
      }
    } else {
      lines.push(`SCRIPTS here: ${list(scripts) || 'none'}${f.workspaces.length ? '. Workspaces have their own; add --script <name> to search them' : ''}`);
    }
  }

  if (pkg) {
    const range = pkg.engines?.node;
    const ok = range ? satisfies(f.node.version, range) : undefined;
    const nvm = f.tools.nvm ? '' : ' nvm is not installed, so start with its install step.';
    if (range && ok === false) finding(`NODE FINDING: this project wants Node ${range} (package.json engines) and this is ${f.node.version}.${f.nvmrc ? ` Its .nvmrc says ${f.nvmrc}.` : ''}${nvm} Remediation 3.`);
    else if (range) lines.push(`ENGINES ${ok ? 'ok' : 'unread'}: Node ${f.node.version}, the project wants ${range}`);
    if (f.nvmrc && ok !== false) {
      const m = nvmrcMatch(f.node.version, f.nvmrc);
      // With no engines field, .nvmrc is the only version the project names.
      if (m === 'other' && !range) finding(`NODE FINDING: this project pins Node ${f.nvmrc} in .nvmrc and this is ${f.node.version}.${nvm} Remediation 3.`);
      else if (m === 'other' || m === 'major') lines.push(`NVMRC NOTE: the project is pinned to Node ${f.nvmrc} and this is ${f.node.version}. If an install or build fails, switch first: Remediation 3.`);
      else if (m === 'same') lines.push(`NVMRC ok: ${f.nvmrc}`);
    }
  }

  if (f.npmWanted && f.npmVersion && satisfies(f.npmVersion, f.npmWanted) === false) finding(`NPM FINDING: this project wants npm ${f.npmWanted} (package.json devEngines) and npm here is ${f.npmVersion}. Remediation 3.`);

  if (f.usesYarn) {
    const pin = f.yarnPin;
    // A global Yarn 1 refuses a project that pins Yarn 2 or newer; Corepack's shim runs the pinned one.
    if (f.tools.yarn && pin?.major >= 2 && !pin.yarnPath && f.yarnViaCorepack === false) finding(`YARN FINDING: yarn at ${f.tools.yarn} is a global install, not Corepack's, and this project pins yarn@${pin.version}, so yarn stops with "However the current global version of Yarn is …". Remediation 5.`);
    else if (f.tools.yarn) lines.push(`YARN ok at ${f.tools.yarn}`);
    else if (!f.tools.corepack) finding('YARN FINDING: the project runs with yarn, and neither yarn nor corepack is on PATH. Remediation 5.');
    else if (!f.corepackWritable) finding(`YARN FINDING: yarn is not on PATH, and corepack enable would fail with EACCES: it writes next to ${f.tools.corepack}, which this user can't write. Remediation 5.`);
    else finding('YARN FINDING: yarn is not on PATH. Run corepack enable once, then open a new shell: Remediation 5.');
  }
  if (f.globalDir && !f.globalWritable) lines.push(`GLOBAL NOTE: npm install -g writes to ${f.globalDir}, which this user can't write, so it fails with EACCES. Don't use sudo: Remediation 5.`);

  for (const w of f.caseMismatches) finding(`WORKSPACE FINDING: ${w.from} depends on "${w.wanted}", but the workspace is named "${w.actual}". Names match exactly, so the install asks the npm registry for "${w.wanted}" and gets a 404. Use one spelling in both package.json files.`);

  for (const r of f.repos) {
    if (r.error) lines.push(`REPO ${r.full} (${r.source}): could not check: ${r.error}`);
    else if (r.missing) lines.push(`REPO ${r.full} (${r.source}): not a public GitHub repo, not checked`);
    else if (r.archived) finding(`ARCHIVED FINDING: ${r.full} (${r.source}) is archived and won't be updated. Its README names what replaced it: https://github.com/${r.full}#readme. Remediation 2.`);
    else lines.push(`REPO ok: ${r.full} (${r.source}) is not archived`);
  }
  if (f.createMnApp) finding('CREATE-MN-APP FINDING: package.json says create-mn-app made this project. create-mn-app is archived and won\'t be updated for new SDK releases. Remediation 2.');
  for (const file of f.mcp) finding(`MCP FINDING: ${file} still uses midnight-mcp, which is deprecated. Remediation 6.`);

  if (f.freeBytes !== undefined) {
    if (f.freeBytes < LOW_DISK_BYTES) finding(`DISK FINDING: only ${gb(f.freeBytes)} free here. npm fails with ENOSPC when it runs out while unpacking. Free some space (df -h and docker system df show what uses it), then install again.`);
    else lines.push(`DISK ${gb(f.freeBytes)} free`);
  }

  if (findings.length) lines.push(`RESULT ${findings.length} finding(s). Fix the first, then run this again.`);
  else if (f.globalDir && !f.globalWritable) lines.push('RESULT no finding in this project, but the GLOBAL NOTE explains EACCES from npm install -g or corepack enable: Remediation 5. Anything else: Diagnose 2.');
  else lines.push('RESULT nothing here explains an npm, yarn or Node failure. Diagnose 2.');
  return { lines, code: findings.length ? 2 : 0 };
}

// Everything report() needs. sys is the machine, replaced in the test.
export async function gatherFacts({ dir, script, offline }, sys = realSystem) {
  const wsl = sys.platform === 'linux' && (Boolean(sys.env.WSL_DISTRO_NAME) || /microsoft/i.test(sys.procVersion()));
  const node = {
    version: sys.nodeVersion,
    execPath: sys.execPath,
    wsl,
    windowsOnWsl: sys.platform === 'win32' && /^\\\\wsl(\$|\.localhost)\\/i.test(dir),
  };
  const tools = Object.fromEntries(['node', 'npm', 'npx', 'yarn', 'corepack'].map((t) => [t, which(t, sys)]));
  // nvm is a shell function, so it is not on PATH. Its install folder is the sign.
  tools.nvm = Boolean(sys.env.NVM_DIR) || sys.exists(path.join(sys.home, '.nvm', 'nvm.sh'));

  const facts = { dir, script, node, tools, below: [], workspaces: [], caseMismatches: [], repos: [], mcp: [], createMnApp: false };
  facts.pkg = readJson(path.join(dir, 'package.json'));
  if (!facts.pkg) facts.below = projectsBelow(dir);
  const pkg = facts.pkg?.json;

  if (pkg) {
    // nvm use reads the nearest .nvmrc at or above the folder, so this does too.
    for (let d = dir; ; d = path.dirname(d)) {
      try { facts.nvmrc = fs.readFileSync(path.join(d, '.nvmrc'), 'utf8').trim() || undefined; break; } catch { /* look higher */ }
      if (path.dirname(d) === d) break;
    }
    facts.usesYarn = usesYarn(dir);
    facts.yarnPin = yarnPin(dir);
    facts.npmWanted = npmWanted(dir);
    facts.workspaces = workspaceDirs(dir, pkg).map((d) => {
      const w = readJson(path.join(d, 'package.json'))?.json ?? {};
      return { dir: d, name: w.name ?? path.basename(d), scripts: w.scripts ?? {}, deps: depsOf(w) };
    });
    const names = new Map(facts.workspaces.map((w) => [w.name.toLowerCase(), w.name]));
    for (const from of [{ name: pkg.name ?? 'the root', deps: depsOf(pkg) }, ...facts.workspaces]) {
      for (const wanted of Object.keys(from.deps)) {
        const actual = names.get(wanted.toLowerCase());
        if (actual && actual !== wanted) facts.caseMismatches.push({ from: from.name, wanted, actual });
      }
    }
    facts.createMnApp = String(pkg.description ?? '').includes(CREATE_MN_APP_MARK);
    const usesMcp = (deps) => Object.keys(deps).includes('midnight-mcp');
    if (usesMcp(depsOf(pkg)) || facts.workspaces.some((w) => usesMcp(w.deps))) facts.mcp.push('package.json');
  }
  for (const rel of MCP_CONFIGS) {
    try { if (fs.readFileSync(path.join(dir, rel), 'utf8').includes('midnight-mcp')) facts.mcp.push(rel); } catch { /* not there */ }
  }

  if (tools.corepack) facts.corepackWritable = sys.writable(path.dirname(tools.corepack));
  // Corepack's yarn shim resolves into corepack/dist/yarn.js. Windows' .cmd shims don't resolve, so it isn't judged there.
  if (tools.yarn && sys.platform !== 'win32') facts.yarnViaCorepack = /[\\/]corepack[\\/]/.test(sys.realpath(tools.yarn));
  // Windows' npm under WSL would answer for Windows, so it is not asked. Nor is npm on Windows: there it is a
  // .cmd file, which only runs through a shell, and a root-owned global folder is a Unix problem.
  if (tools.npm && sys.platform !== 'win32' && !(wsl && tools.npm.startsWith('/mnt/'))) {
    const v = sys.run(tools.npm, ['--version']);
    if (v.status === 0 && v.stdout.trim()) facts.npmVersion = v.stdout.trim();
    const r = sys.run(tools.npm, ['config', 'get', 'prefix']);
    const prefix = r.status === 0 ? r.stdout.trim() : '';
    if (prefix) {
      facts.globalDir = sys.platform === 'win32' ? prefix : path.join(prefix, 'lib', 'node_modules');
      facts.globalWritable = sys.writable(facts.globalDir);
    }
  }

  if (!offline) {
    const targets = [];
    const fromRemote = githubRepo(gitRemote(dir));
    if (fromRemote) targets.push({ full: fromRemote, source: 'git remote' });
    else {
      // A download without git: midnightntwrk's examples are named after their repos.
      const m = /^@midnight-ntwrk\/(example-[\w.-]+)$/.exec(pkg?.name ?? '');
      if (m) targets.push({ full: `midnightntwrk/${m[1]}`, source: 'package name' });
    }
    for (const t of targets) {
      try {
        const s = await repoState(t.full, sys);
        facts.repos.push({ ...t, ...s });
        if (s.template) facts.repos.push({ ...s.template, source: `template of ${t.full}` });
      } catch (e) {
        facts.repos.push({ ...t, error: e.message });
      }
    }
  }

  try { facts.freeBytes = sys.freeBytes(fs.existsSync(dir) ? dir : '.'); } catch { /* statfs unavailable */ }
  return facts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`could not run: ${dir} is not a folder`);
  const r = report(await gatherFacts({ ...args, dir }));
  for (const line of r.lines) say(line);
  process.exit(r.code);
}

// Run only when called directly, not when the test imports report.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((e) => fail(`could not run: ${e.message}`));
}
