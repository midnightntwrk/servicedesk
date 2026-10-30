#!/usr/bin/env node
/**
 * test-check-project-setup.mjs: offline test of check-project-setup.mjs's findings.
 *
 * Each case builds a small project folder the way a user's looked in the reports behind the runbook
 * (no package.json, another guide's script, a Node below engines, Windows npm under WSL, a yarn project
 * with no yarn, an archived repo...), gives gatherFacts() a stand-in for the machine, and checks the
 * line report() prints and its exit code. The GitHub answers are stand-ins too, so no case needs the network.
 *
 * Requirements: Node >= 18.15. No npm install. It writes only temporary folders and removes them.
 *
 *   node test-check-project-setup.mjs
 *
 * Exit code: 0 = every case passed, 2 = at least one failed, 1 = it could not run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, 'check-project-setup.mjs');
const { report, gatherFacts, satisfies, nvmrcMatch, githubRepo } = await import(pathToFileURL(SCRIPT).href);

const NVM_BIN = '/home/u/.nvm/versions/node/v24.11.1/bin';
const BINS = ['node', 'npm', 'npx', 'corepack'].map((b) => `${NVM_BIN}/${b}`);
const GB = 1024 ** 3;

// A stand-in for the machine: Linux, Node from nvm, everything writable, plenty of disk.
const machine = (over = {}) => ({
  platform: 'linux',
  nodeVersion: 'v24.11.1',
  execPath: `${NVM_BIN}/node`,
  env: { PATH: `${NVM_BIN}:/usr/bin`, NVM_DIR: '/home/u/.nvm' },
  home: '/home/u',
  procVersion: () => 'Linux version 6.8.0-generic',
  isExecutable: (p) => (over.bins ?? BINS).includes(p),
  exists: () => false,
  // Corepack's yarn shim, the way nvm and Homebrew install it.
  realpath: (p) => (p.endsWith('/yarn') ? '/home/u/.nvm/versions/node/v24.11.1/lib/node_modules/corepack/dist/yarn.js' : p),
  writable: (p) => !(over.readOnly ?? []).some((r) => p.startsWith(r)),
  run: (cmd, args) => ({ status: 0, stdout: args[0] === '--version' ? '11.6.2\n' : '/home/u/.nvm/versions/node/v24.11.1\n' }),
  freeBytes: () => 50 * GB,
  fetch: async () => { throw new Error('no network in this case'); },
  ...over,
});

const github = (answers) => async (url) => {
  const a = answers[url.replace('https://api.github.com/repos/', '')];
  if (!a) return { ok: false, status: 404, json: async () => ({}) };
  if (a.status) return { ok: false, status: a.status, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => a };
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'check-project-setup-'));
let n = 0;
// Build a folder from { 'path/in/folder': string | object }; objects are written as JSON.
function folder(files) {
  const d = path.join(ROOT, `case${++n}`);
  fs.mkdirSync(d, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return d;
}

const BBOARD = {
  'package.json': { name: '@midnight-ntwrk/example-bboard', private: true, engines: { node: '>=24.11.1' }, workspaces: { packages: ['bboard-cli', 'contract'] } },
  '.nvmrc': '24.11.1\n',
  'package-lock.json': '{}',
  'bboard-cli/package.json': { name: '@midnight-ntwrk/bboard-cli', scripts: { standalone: 'x', 'preprod-remote': 'x' } },
  'contract/package.json': { name: '@midnight-ntwrk/bboard-contract', scripts: { compact: 'x' } },
};
const YARN_PROJECT = { 'package.json': { name: 'hello', packageManager: 'yarn@4.18.0', scripts: { compile: 'x', 'env:up': 'x' } } };
const GIT = (url) => ({ '.git/config': `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` });

// [name, files, options, machine overrides, a line that must start with this, exit code, text the line must also contain]
const CASES = [
  ['npm run in the home folder, project one level down', { 'demo1/package.json': { name: 'demo1' } }, {}, {}, 'PROJECT FINDING: no package.json in', 2, 'demo1'],
  ['nothing was created here', { 'notes.txt': 'x' }, {}, {}, 'PROJECT FINDING: no package.json in', 2, 'never created or cloned here. Remediation 2.'],
  ['a hand-edited package.json with a missing comma', { 'package.json': '{ "name": "x",\n  "engines": { "node": ">=22.0.0" }\n  "scripts": {} }' }, {}, {}, 'PROJECT FINDING: package.json is not valid JSON', 2, 'EJSONPARSE'],
  ['create-mn-app\'s setup run in example-bboard', BBOARD, { script: 'setup' }, {}, 'SCRIPT FINDING: no "setup" script here or in any workspace', 2, 'Remediation 2'],
  ['a workspace script run from the root', BBOARD, { script: 'standalone' }, {}, 'SCRIPT FINDING: "standalone" is not in this package.json, only in workspace @midnight-ntwrk/bboard-cli', 2, 'npm run standalone --workspace @midnight-ntwrk/bboard-cli'],
  ['a script that is there', YARN_PROJECT, { script: 'env:up' }, { bins: [...BINS, `${NVM_BIN}/yarn`] }, 'SCRIPT ok: "env:up"', 0, 'yarn env:up'],
  ['Node 22 on a project that wants >=24.11.1', BBOARD, {}, { nodeVersion: 'v22.23.2' }, 'NODE FINDING: this project wants Node >=24.11.1', 2, 'Its .nvmrc says 24.11.1'],
  ['the same without nvm', BBOARD, {}, { nodeVersion: 'v22.23.2', env: { PATH: '/usr/bin' }, bins: ['/usr/bin/node', '/usr/bin/npm', '/usr/bin/npx'] }, 'NODE FINDING: this project wants Node >=24.11.1', 2, 'nvm is not installed'],
  ['only .nvmrc, another major', { 'package.json': { name: 'x' }, '.nvmrc': '22\n' }, {}, { nodeVersion: 'v25.6.0' }, 'NODE FINDING: this project pins Node 22 in .nvmrc', 2, 'Remediation 3'],
  ['engines met, .nvmrc names another major', { 'package.json': { name: 'x', engines: { node: '>=22.0.0' } }, '.nvmrc': '22\n' }, {}, {}, 'NVMRC NOTE: the project is pinned to Node 22', 0, 'v24.11.1'],
  ['.nvmrc in the repo root, run in a workspace', { ...BBOARD, '.git/HEAD': 'x' }, { sub: 'bboard-cli' }, { nodeVersion: 'v22.23.2' }, 'NODE FINDING: this project pins Node 24.11.1 in .nvmrc', 2, 'Remediation 3'],
  ['Windows Node run in a WSL folder', {}, { dirAs: '\\\\wsl.localhost\\Ubuntu\\home\\u\\demo2' }, { platform: 'win32', nodeVersion: 'v25.6.0', execPath: 'C:\\Program Files\\nodejs\\node.exe' }, 'WSL FINDING: this is Windows\' Node running in a WSL folder', 2, 'C:\\Windows'],
  ['Windows npm and npx on PATH under WSL', { 'package.json': { name: 'x' } }, {}, { env: { PATH: '/usr/bin:/mnt/c/Program Files/nodejs', WSL_DISTRO_NAME: 'Ubuntu' }, bins: ['/usr/bin/node', '/mnt/c/Program Files/nodejs/npm', '/mnt/c/Program Files/nodejs/npx'], execPath: '/usr/bin/node' }, 'WSL FINDING: npm is Windows\' (/mnt/c/Program Files/nodejs/npm), npx is Windows\'', 2, 'Remediation 4'],
  ['WSL found from /proc/version', { 'package.json': { name: 'x' } }, {}, { procVersion: () => 'Linux version 5.15.167.4-microsoft-standard-WSL2', env: { PATH: '/mnt/c/Program Files/nodejs' }, bins: ['/mnt/c/Program Files/nodejs/npm'] }, 'WSL FINDING: npm is Windows\'', 2, 'Remediation 4'],
  ['a yarn project, no yarn, corepack in a root-owned folder', YARN_PROJECT, {}, { bins: ['/usr/bin/node', '/usr/bin/npm', '/usr/bin/corepack'], env: { PATH: '/usr/bin' }, readOnly: ['/usr'] }, 'YARN FINDING: yarn is not on PATH, and corepack enable would fail with EACCES', 2, '/usr/bin/corepack'],
  ['a yarn project, neither yarn nor corepack', YARN_PROJECT, {}, { bins: ['/usr/bin/node', '/usr/bin/npm'], env: { PATH: '/usr/bin' } }, 'YARN FINDING: the project runs with yarn, and neither yarn nor corepack', 2, 'Remediation 5'],
  ['a yarn project, corepack can enable', YARN_PROJECT, {}, {}, 'YARN FINDING: yarn is not on PATH. Run corepack enable', 2, 'Remediation 5'],
  ['a yarn workspace below the lockfile', { ...YARN_PROJECT, 'yarn.lock': '', 'examples/a/package.json': { name: 'a', scripts: { 'env:up': 'x' } } }, { sub: 'examples/a' }, { bins: [...BINS, `${NVM_BIN}/yarn`] }, 'PROJECT a in', 0, 'run with yarn'],
  ['npm install -g into a root-owned folder', { 'package.json': { name: 'x' } }, {}, { run: (cmd, args) => ({ status: 0, stdout: args[0] === '--version' ? '10.9.3\n' : '/usr/local\n' }), readOnly: ['/usr/local'] }, 'GLOBAL NOTE: npm install -g writes to /usr/local/lib/node_modules', 0, 'sudo'],
  ['...and the verdict says the note explains EACCES', { 'package.json': { name: 'x' } }, {}, { run: (cmd, args) => ({ status: 0, stdout: args[0] === '--version' ? '10.9.3\n' : '/usr/local\n' }), readOnly: ['/usr/local'] }, 'RESULT no finding in this project, but the GLOBAL NOTE explains EACCES', 0, 'Remediation 5'],
  ['a global Yarn 1 in a project that pins Yarn 4 (node:22 image)', YARN_PROJECT, {}, { bins: [...BINS, '/usr/local/bin/yarn'], env: { PATH: `${NVM_BIN}:/usr/local/bin` }, realpath: (p) => (p === '/usr/local/bin/yarn' ? '/opt/yarn-v1.22.22/bin/yarn' : p) }, 'YARN FINDING: yarn at /usr/local/bin/yarn is a global install, not Corepack\'s, and this project pins yarn@4.18.0', 2, 'However the current global version of Yarn is'],
  ['Corepack\'s yarn in a project that pins Yarn 4', YARN_PROJECT, {}, { bins: [...BINS, `${NVM_BIN}/yarn`] }, 'YARN ok at', 0, '/yarn'],
  ['a global Yarn 1 in a project that pins Yarn 1', { 'package.json': { name: 'hello', packageManager: 'yarn@1.22.22' } }, {}, { bins: [...BINS, '/usr/local/bin/yarn'], env: { PATH: `${NVM_BIN}:/usr/local/bin` }, realpath: (p) => p }, 'YARN ok at /usr/local/bin/yarn', 0, 'yarn'],
  ['a global Yarn 1 in a project with yarnPath', { ...YARN_PROJECT, '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.18.0.cjs\n' }, {}, { bins: [...BINS, '/usr/local/bin/yarn'], env: { PATH: `${NVM_BIN}:/usr/local/bin` }, realpath: (p) => p }, 'YARN ok at /usr/local/bin/yarn', 0, 'yarn'],
  ['a workspace dependency spelled with another case', { 'package.json': { name: 'surfchat', workspaces: ['contract', 'cli'] }, 'contract/package.json': { name: 'surfChat-contract' }, 'cli/package.json': { name: 'cli', dependencies: { 'surfchat-contract': '*' } } }, {}, {}, 'WORKSPACE FINDING: cli depends on "surfchat-contract", but the workspace is named "surfChat-contract"', 2, '404'],
  ['a clone of an archived repo', { ...BBOARD, ...GIT('https://github.com/midnightntwrk/example-bboard.git') }, { online: true }, { fetch: github({ 'midnightntwrk/example-bboard': { archived: true } }) }, 'ARCHIVED FINDING: midnightntwrk/example-bboard (git remote) is archived', 2, 'example-bboard#readme'],
  ['a repo made from an archived template', { 'package.json': { name: 'mydapp' }, ...GIT('git@github.com:someone/mydapp.git') }, { online: true }, { fetch: github({ 'someone/mydapp': { archived: false, template_repository: { full_name: 'midnightntwrk/example-bboard', archived: true } } }) }, 'ARCHIVED FINDING: midnightntwrk/example-bboard (template of someone/mydapp)', 2, 'Remediation 2'],
  ['a download with no git, named after an archived example', BBOARD, { online: true }, { fetch: github({ 'midnightntwrk/example-bboard': { archived: true } }) }, 'ARCHIVED FINDING: midnightntwrk/example-bboard (package name)', 2, 'Remediation 2'],
  ['a maintained repo', { 'package.json': { name: 'x' }, ...GIT('https://github.com/midnightntwrk/midnight-examples') }, { online: true }, { fetch: github({ 'midnightntwrk/midnight-examples': { archived: false } }) }, 'REPO ok: midnightntwrk/midnight-examples (git remote) is not archived', 0, 'git remote'],
  ['GitHub rate-limits the check', { 'package.json': { name: 'x' }, ...GIT('https://github.com/midnightntwrk/midnight-examples') }, { online: true }, { fetch: github({ 'midnightntwrk/midnight-examples': { status: 403 } }) }, 'REPO midnightntwrk/midnight-examples (git remote): could not check', 0, 'HTTP 403'],
  ['a create-mn-app project', { 'package.json': { name: 'demo2', description: 'A Midnight Network application created with create-mn-app', scripts: { setup: 'x' } } }, {}, {}, 'CREATE-MN-APP FINDING', 2, 'Remediation 2'],
  ['midnight-mcp in .mcp.json', { 'package.json': { name: 'x' }, '.mcp.json': { mcpServers: { midnight: { command: 'npx', args: ['-y', 'midnight-mcp@0.2.21'] } } } }, {}, {}, 'MCP FINDING: .mcp.json still uses midnight-mcp', 2, 'Remediation 6'],
  ['midnight-mcp as a dependency', { 'package.json': { name: 'x', dependencies: { 'midnight-mcp': '^0.2.21' } } }, {}, {}, 'MCP FINDING: package.json still uses midnight-mcp', 2, 'deprecated'],
  ['the disk is nearly full', { 'package.json': { name: 'x' } }, {}, { freeBytes: () => 0.3 * GB }, 'DISK FINDING: only 0.3 GB free', 2, 'ENOSPC'],
  ['npm 10 on a project whose devEngines wants npm 11.10 (midnight-examples)', { 'package.json': { name: 'mn-examples', devEngines: { packageManager: { name: 'npm', version: '>=11.10.0', onFail: 'warn' } } } }, {}, { run: (cmd, args) => ({ status: 0, stdout: args[0] === '--version' ? '10.9.3\n' : '/home/u/.nvm/versions/node/v22.19.0\n' }) }, 'NPM FINDING: this project wants npm >=11.10.0 (package.json devEngines) and npm here is 10.9.3', 2, 'Remediation 3'],
  ['devEngines in the repo root, run in a workspace', { 'package.json': { name: 'mn-examples', devEngines: { packageManager: { name: 'npm', version: '>=11.10.0' } }, workspaces: ['examples/*'] }, 'examples/a/package.json': { name: 'a' }, '.git/HEAD': 'x' }, { sub: 'examples/a' }, { run: (cmd, args) => ({ status: 0, stdout: args[0] === '--version' ? '10.9.3\n' : '/home/u/.nvm/versions/node/v22.19.0\n' }) }, 'NPM FINDING: this project wants npm >=11.10.0', 2, '10.9.3'],
  ['npm new enough for devEngines', { 'package.json': { name: 'mn-examples', devEngines: { packageManager: { name: 'npm', version: '>=11.10.0' } } } }, {}, { run: (cmd, args) => ({ status: 0, stdout: args[0] === '--version' ? '11.21.0\n' : '/home/u/.nvm/versions/node/v22.19.0\n' }) }, 'RESULT nothing here explains', 0, 'Diagnose 2'],
  ['a project with nothing wrong', { 'package.json': { name: 'x', engines: { node: '>=22.0.0' }, scripts: { build: 'x' } } }, {}, {}, 'RESULT nothing here explains', 0, 'Diagnose 2'],
];

// [range, version, expected]
const RANGES = [
  ['>=24.11.1', 'v22.23.2', false], ['>=24.11.1', 'v24.11.1', true], ['>=22.0.0', 'v25.6.0', true],
  ['^22 || ^24', 'v23.5.0', false], ['^22 || ^24', 'v24.0.0', true], ['22.x', 'v22.19.0', true], ['22', 'v24.1.0', false],
  ['>=22 <23', 'v22.9.0', true], ['>= 22', 'v20.0.0', false], ['~24.11', 'v24.12.0', false], ['>22', 'v22.5.0', false],
  ['<=22', 'v22.5.0', true], ['*', 'v18.0.0', true], ['18 - 22', 'v20.0.0', undefined],
];
const NVMRCS = [['22', 'v22.19.0', 'same'], ['v24.11.1', 'v24.20.0', 'major'], ['22', 'v25.6.0', 'other'], ['lts/*', 'v22.0.0', undefined]];
const REMOTES = [['https://github.com/midnightntwrk/example-bboard.git', 'midnightntwrk/example-bboard'], ['git@github.com:someone/my.dapp.git', 'someone/my.dapp'], ['https://gitlab.com/a/b.git', undefined]];

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`ok    ${name}`);
  else { failed++; console.log(`FAIL  ${name}\n${detail}`); }
};

try {
  for (const [name, files, opts, over, start, code, contains] of CASES) {
    const d = folder(files);
    const dir = opts.dirAs ?? path.join(d, opts.sub ?? '');
    const facts = await gatherFacts({ dir, script: opts.script, offline: !opts.online }, machine(over));
    const r = report(facts);
    const line = r.lines.find((l) => l.startsWith(start));
    check(name, line && line.includes(contains) && r.code === code, `  wanted a line starting "${start}" containing "${contains}", exit ${code}\n  got exit ${r.code}:\n    ${r.lines.join('\n    ')}`);
  }
  for (const [range, version, want] of RANGES) check(`satisfies("${version}", "${range}") is ${want}`, satisfies(version, range) === want, `  got ${satisfies(version, range)}`);
  for (const [nvmrc, version, want] of NVMRCS) check(`.nvmrc ${nvmrc} with ${version} is ${want}`, nvmrcMatch(version, nvmrc) === want, `  got ${nvmrcMatch(version, nvmrc)}`);
  for (const [url, want] of REMOTES) check(`remote ${url}`, githubRepo(url) === want, `  got ${githubRepo(url)}`);

  // As a reader runs it: arguments and a folder that isn't there.
  const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const help = cli(['--help']);
  check('--help prints the usage', help.status === 0 && help.stdout.startsWith('usage:'), `  got ${help.status}: ${help.stdout}${help.stderr}`);
  const missing = cli([path.join(ROOT, 'not-there'), '--offline']);
  check('a folder that is not there cannot run', missing.status === 1 && missing.stderr.includes('is not a folder'), `  got ${missing.status}: ${missing.stderr}`);
  const unknown = cli(['--nope']);
  check('an unknown option cannot run', unknown.status === 1 && unknown.stderr.includes('unknown option --nope'), `  got ${unknown.status}: ${unknown.stderr}`);
  const real = cli([folder({ 'package.json': { name: 'x' } }), '--offline']);
  check('a real run prints NODE first and RESULT last', /^NODE v/.test(real.stdout) && /\nRESULT .*\n$/.test(real.stdout) && [0, 2].includes(real.status), `  got ${real.status}: ${real.stdout}${real.stderr}`);
} catch (e) {
  console.error(`could not run: ${e.stack}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

if (process.exitCode !== 1) {
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 2 : 0;
}
