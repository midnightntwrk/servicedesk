#!/usr/bin/env node
/**
 * test-check-test-funds.mjs: offline test of check-test-funds.mjs's address check.
 *
 * The address check decides which branch of the runbook a reader takes, so a wrong "ok" sends them
 * after the wrong cause. Each case runs the script as a reader would and checks the first line it
 * prints and its exit code. Accepted addresses run with --offline, and every other case stops before
 * any request, so no case needs the network or a token.
 *
 * Requirements: Node >= 22. No npm install. It writes nothing.
 *
 *   node test-check-test-funds.mjs
 *
 * Exit code: 0 = every case passed, 2 = at least one failed, 1 = it could not run.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof WebSocket !== 'function') { console.error(`Node >= 22 is required (this is ${process.version}).`); process.exit(1); }

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-test-funds.mjs');
const PREVIEW = 'mn_addr_preview1mrjdllf9muv893llnkmzakdw88apw9anv45wwfwjhcdcy0vwa6psxutlx5';
const PREPROD = 'mn_addr_preprod1mrjdllf9muv893llnkmzakdw88apw9anv45wwfwjhcdcy0vwa6psxa404f';
const MAINNET = 'mn_addr1ykuv8pkm79dqr98kn8arz7fg2fjrmjuf58cfzq6pxf2560mjdmxs5aw45s';

// [name, args, first line must start with, exit code]
const CASES = [
  ['a Preview address is accepted', [PREVIEW, '--offline'], 'ADDRESS ok: an unshielded preview address', 0],
  ['a Preprod address is accepted', [PREPROD, '--offline'], 'ADDRESS ok: an unshielded preprod address', 0],
  ['an all-uppercase address is accepted', [PREVIEW.toUpperCase(), '--offline'], 'ADDRESS ok: an unshielded preview address', 0],
  ['a mainnet address is refused', [MAINNET], 'ADDRESS FINDING: this is a mainnet address', 2],
  ['a shielded address is refused', ['mn_shield-addr_preview1qqqqqq'], 'ADDRESS FINDING: this is a shielded address', 2],
  ['a DUST address is refused', ['mn_dust_preprod1qqqqqq'], 'ADDRESS FINDING: this is a DUST address', 2],
  ['one changed character is refused', [`${PREVIEW.slice(0, -1)}q`], 'ADDRESS FINDING: the checksum is wrong', 2],
  ['a truncated address is refused', [PREVIEW.slice(0, 40)], 'ADDRESS FINDING: the checksum is wrong', 2],
  ['a mixed-case address is refused', [`M${PREVIEW.slice(1)}`], 'ADDRESS FINDING: the checksum is wrong', 2],
  ['whitespace inside the address is refused', [`${PREVIEW.slice(0, 20)} ${PREVIEW.slice(20)}`], 'ADDRESS FINDING: the address contains whitespace', 2],
  ['a valid checksum on a 5-byte payload is refused', ['mn_addr_preview1lu608teqj0gc45'], 'ADDRESS FINDING: the address is the wrong length', 2],
  ['an address split by a space in the shell is a usage error', [PREVIEW.slice(0, 20), PREVIEW.slice(20)], 'a second address part', 1],
  ['an unknown prefix is refused', ['mn_addr_devnet1qqqqqqqqqqqq'], 'ADDRESS FINDING: the prefix "mn_addr_devnet"', 2],
  ['a Preprod address with no project id stops before any request', [PREPROD], 'ADDRESS ok: an unshielded preprod address', 1, { BLOCKFROST_PROJECT_ID: '' }],
  ['--drip without --faucet is a usage error', [PREVIEW, '--drip', 'a539eb57-6ef7-4343-9762-49e6bf02c37f'], '--drip needs --faucet', 1],
  ['an empty --tx is a usage error', [PREVIEW, '--tx', ''], '--tx needs a value', 1],
];

let failed = 0;
for (const [name, args, want, exit, env] of CASES) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  if (r.error) { console.error(`could not run ${SCRIPT}: ${r.error.message}`); process.exit(1); }
  const first = `${r.stdout}${r.stderr}`.trim().split('\n')[0] ?? '';
  const ok = first.startsWith(want) && r.status === exit;
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : `\n      expected exit ${exit} and "${want}…"\n      got exit ${r.status} and "${first}"`}`);
}
console.log(`\n${CASES.length - failed} of ${CASES.length} passed.`);
process.exit(failed ? 2 : 0);
