#!/usr/bin/env node
/**
 * test-check-dust-registration.mjs: offline test of check-dust-registration.mjs's address check and verdicts.
 *
 * The address check decides which network and which key the script reads, so a wrong "ok" checks the
 * wrong registration. Each address case runs the script as a reader would and checks the lines it
 * prints and its exit code. Every one stops before any request.
 *
 * The verdict cases feed report() real answers, recorded on Mainnet, Preprod and Preview in
 * test-check-dust-registration.recorded.json, or a copy changed the way each failure would change it.
 * So no case needs the network or a project id.
 *
 * Requirements: Node >= 18. No npm install. It writes nothing.
 *
 *   node test-check-dust-registration.mjs
 *
 * Exit code: 0 = every case passed, 2 = at least one failed, 1 = it could not run.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, 'check-dust-registration.mjs');
const { report, bech32Decode, bech32Encode } = await import(pathToFileURL(SCRIPT).href);

const MAINNET = 'stake1uxv0zkpvpw48r72pxl3fuwmr8ype3yme45adk4jhthynejq5k9nk5';
const TESTNET = 'stake_test1uq4hpm9qnaxpq8kgf8u8famp3pq5awph5982g7j6e2qtdqqnnwpdj';
const MAINNET_DUST = 'mn_dust1ww2znd5hr8naxeakujwfw4mtt2fh7adrace88tefa0gev8f87qwpclxj768';
// The same stake key as MAINNET, as a script credential.
const SCRIPT_STAKE = bech32Encode('stake', Buffer.from([0xf1, ...bech32Decode(MAINNET).bytes.slice(1)]));

// [name, args, a line that must start with this, exit code, env]
const CASES = [
  ['an enterprise address has no stake key', ['addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7'], 'ADDRESS FINDING: this is an enterprise address', 2],
  ['a Midnight address is refused', ['mn_addr1ykuv8pkm79dqr98kn8arz7fg2fjrmjuf58cfzq6pxf2560mjdmxs5aw45s'], 'ADDRESS FINDING: this is a Midnight address', 2],
  ['a Byron address is refused', ['DdzFFzCqrhsjZHKn8Y9Txr4B9PaEtYcYp8TGa4gQTfJfjvuNLqvB'], 'ADDRESS FINDING: this is a Byron address', 2],
  ['one changed character is refused', [`${MAINNET.slice(0, -1)}q`], 'ADDRESS FINDING: the checksum is wrong', 2],
  ['a mixed-case address is refused', [`S${MAINNET.slice(1)}`], 'ADDRESS FINDING: the checksum is wrong', 2],
  ['a script stake address is refused', [SCRIPT_STAKE], 'ADDRESS FINDING: this stake address is a script', 2],
  ['a Mainnet address with --network preprod is refused', [MAINNET, '--network', 'preprod'], 'ADDRESS FINDING: this is a Mainnet address, not preprod', 2],
  ['a testnet address with --network mainnet is refused', [TESTNET, '--network', 'mainnet'], 'ADDRESS FINDING: this is a testnet address', 2],
  ['a testnet address needs --network', [TESTNET], 'a testnet address works on Preprod and Preview', 1],
  ['an unknown network is a usage error', [MAINNET, '--network', 'devnet'], '--network is mainnet, preprod or preview', 1],
  ['an address split by a space in the shell is a usage error', [MAINNET.slice(0, 20), MAINNET.slice(20)], 'a second address part', 1],
  ['a DUST address for another network is refused', [TESTNET, '--network', 'preprod', '--dust', MAINNET_DUST], 'ADDRESS FINDING: the --dust address is for mainnet, not preprod', 2],
  ['an unshielded address given as --dust is refused', [MAINNET, '--dust', 'mn_addr1ykuv8pkm79dqr98kn8arz7fg2fjrmjuf58cfzq6pxf2560mjdmxs5aw45s'], 'ADDRESS FINDING: the --dust address is not a DUST address', 2],
  ['a mistyped --dust is refused', [MAINNET, '--dust', `${MAINNET_DUST.slice(0, -1)}q`], 'ADDRESS FINDING: the --dust address checksum is wrong', 2],
  ['Mainnet with no project id stops before any request', [MAINNET], 'mainnet reads the Midnight indexer on Blockfrost', 1, { BLOCKFROST_PROJECT_ID: '' }],
];

let failed = 0;
for (const [name, args, want, exit, env] of CASES) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  if (r.error) { console.error(`could not run ${SCRIPT}: ${r.error.message}`); process.exit(1); }
  const lines = `${r.stdout}${r.stderr}`.trim().split('\n');
  const ok = lines.some((l) => l.startsWith(want)) && r.status === exit;
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : `\n      expected exit ${exit} and a line "${want}…"\n      got exit ${r.status} and\n      ${lines.join('\n      ')}`}`);
}

const recorded = JSON.parse(readFileSync(path.join(DIR, 'test-check-dust-registration.recorded.json'), 'utf8')).cases;
const revive = (v) => JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === 'string' && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));
const copy = (name, change = (f) => f) => change(revive(recorded[name]));
const hoursLater = (h) => (f) => { f.now += h * 3600; return f; };
const otherDust = recorded.previewGenerating.live[0].dust.replace(/^../, 'ff');

// [name, facts, a line that must start with this, exit code, optional check of all lines]
const REPORTS = [
  ['a removed registration names the removal', copy('removed'), 'REGISTRATION FINDING: nothing is registered now. The last registration', 2],
  ['a removed registration explains "Registration Syncing"', copy('removed'), 'REGISTRATION FINDING:', 2, (l) => l.some((x) => x.includes('"Registration Syncing" is showing the removed registration'))],
  ['the history lists registrations and removals', copy('removed'), 'HISTORY ', 2, (l) => l.filter((x) => /^HISTORY \S+ +removed /.test(x)).length === 2],
  ['a fresh registration says wait', copy('fresh'), 'WAIT FINDING: registered', 2, (l) => l.some((x) => x.includes('Do not register again'))],
  ['13 hours on, it is later than usual', copy('fresh', hoursLater(13)), 'WAIT FINDING: registered', 2, (l) => l.some((x) => x.includes('later than usual'))],
  ['25 hours on, it escalates', copy('fresh', hoursLater(25)), 'ESCALATE FINDING: registered', 2],
  ['cNIGHT received in the last 12 hours is explained', copy('recentNight'), 'NIGHT note: Midnight counts', 0, (l) => l.some((x) => x.includes('received in the last 12 hours is not counted yet'))],
  ['a shortfall older than 12 hours is reported', copy('recentNight', (f) => { f.cnight.recent = 0n; return f; }), 'NIGHT note: Midnight counts', 0, (l) => l.some((x) => x.includes('less than the'))],
  ['the DApp figures are flagged when they count one UTXO', copy('dappShort'), 'DAPP note: the DUST DApp\'s Generation Rate shows', 0],
  ['no DApp note when the figures agree', copy('previewGenerating'), 'DUST ok:', 0, (l) => !l.some((x) => x.startsWith('DAPP note'))],
  ['Midnight registered with no UTXO reference counts as picked up', copy('dappShort'), 'DUST ok: registered once', 0],
  ['duplicates go to the duplicates runbook', copy('duplicates'), 'REGISTRATION FINDING: 6 live registrations for one stake key', 2],
  ['a key that never registered', copy('never'), 'REGISTRATION FINDING: this stake key has no registration on Cardano mainnet', 2],
  ['a key registered only on another network', copy('otherNetwork'), 'REGISTRATION FINDING: this key has no registration on Cardano mainnet, only on preview', 2],
  ['a single registration on Preprod is ok', copy('preprodSingle'), 'DUST ok: registered once', 0],
  ['the right --dust address is ok', copy('preprodSingle', (f) => { f.expectDust = f.live[0].dust; return f; }), 'DUST ok: registered once', 0],
  ['a different --dust address is a finding', copy('previewGenerating', (f) => { f.expectDust = otherDust; return f; }), 'DUST ADDRESS FINDING: DUST is generated for', 2],
  ['registered with no cNIGHT on the key', copy('noNight'), 'NIGHT FINDING: registered, but this stake key holds no cNIGHT', 2],
  ['a single registration on Preview is ok', copy('previewGenerating'), 'DUST ok: registered once', 0],
  ['Preview waits 2.5 hours, not 12', copy('previewGenerating', (f) => { f.midnight.status.registered = false; f.live[0].time = f.now - 3600; return f; }), 'WAIT FINDING: registered 1.0 h ago and Midnight has not picked it up yet. It takes about 2.5 hours', 2],
  ['Midnight following an older registration says wait', copy('previewGenerating', (f) => { f.midnight.status.utxoTxHash = 'ab'.repeat(32); f.live[0].time = f.now - 3600; return f; }), 'WAIT FINDING: registered 1.0 h ago and Midnight still follows an older registration', 2],
  ['different DUST addresses on the two chains escalate', copy('previewGenerating', (f) => { f.live[0].dust = otherDust; return f; }), 'ESCALATE FINDING: the DUST address on Cardano', 2],
  ['nothing counted yet, all cNIGHT new: wait', copy('previewGenerating', (f) => { f.midnight.registrations[0].nightBalance = '0'; f.cnight.recent = f.cnight.total; return f; }), 'WAIT FINDING: registered, but all', 2],
  ['nothing counted, cNIGHT old: escalate', copy('previewGenerating', (f) => { f.midnight.registrations[0].nightBalance = '0'; f.cnight.recent = 0n; return f; }), 'ESCALATE FINDING: registered, but Midnight counts no NIGHT', 2],
  ['--cardano-only stops after Cardano', copy('previewGenerating', (f) => { f.midnight = undefined; f.midnightSkipped = true; return f; }), 'REGISTRATION ok: registered once', 0, (l) => l.includes('MIDNIGHT not checked (--cardano-only)')],
  ['--cardano-only still catches a key with no cNIGHT', copy('noNight', (f) => { f.midnight = undefined; f.midnightSkipped = true; return f; }), 'NIGHT FINDING: registered once, but this stake key holds no cNIGHT', 2],
];
for (const [name, facts, want, exit, check = () => true] of REPORTS) {
  const r = report(facts);
  const ok = r.lines.some((l) => l.startsWith(want)) && r.code === exit && check(r.lines);
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : `\n      expected exit ${exit} and a line "${want}…"\n      got exit ${r.code} and\n      ${r.lines.join('\n      ')}`}`);
}

const total = CASES.length + REPORTS.length;
console.log(`\n${total - failed} of ${total} passed.`);
process.exit(failed ? 2 : 0);
