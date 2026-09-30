#!/usr/bin/env node
// measure-deploy-cost.mjs — offline diagnostic: will this contract's deploy fit in one block?
//
// Reads the compiled verifier keys (<compiled-dir>/keys/*.verifier) produced by `compact compile`,
// builds a synthetic deploy transaction carrying every verifier key, and prices it with the
// ledger's own cost model against the network block limits. No wallet, node, indexer, proof
// server or API key needed. Nothing is signed or submitted.
//
// Setup (any empty directory):
//   npm i @midnight-ntwrk/ledger-v8@8.1.0      # match the ledger your SDK uses (midnight-js 4.1.x -> ledger-v8 8.1.x)
//   node measure-deploy-cost.mjs <compiled-dir> [--headroom 0.6] [--params ledger-parameters-config.json]
//
// <compiled-dir> is the compiler output directory (the one containing contract/, keys/, zkir/).
// --params takes a midnight-node `res/<network>/ledger-parameters-config.json` to read the block
// limits from; without it the mainnet values below are used (verified 2026-09-29).
//
// Headroom: a tx can't use a whole block. Normal txs get at most 75% of block weight, minus
// on-initialize/inherent weight; measured on node 0.22.1, 62.6% of bytesWritten was included and
// 68.1% was rejected ("1010: Transaction would exhaust the block limits"). Default 0.6.
// Caveat: the synthetic deploy has an empty initial ledger state and no fee inputs, so it slightly
// UNDER-estimates the real deploy (constructor ledger data; wallet balancing adds ~224 bytesWritten).

import fs from 'node:fs';
import path from 'node:path';
import * as L from '@midnight-ntwrk/ledger-v8';

const MAINNET_LIMITS = {
  transactionByteLimit: 1_048_576n,
  // Block limits from midnight-node res/mainnet/ledger-parameters-config.json (times in picoseconds).
  block: {
    readTime: 2_000_000_000_000n,
    computeTime: 2_000_000_000_000n,
    blockUsage: 1_000_000n,
    bytesWritten: 50_000n,
    bytesChurned: 50_000_000n,
  },
};

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const headroom = Number(flag('--headroom', '0.6'));
const paramsFile = flag('--params', undefined);
const compiledDir = args[0];
if (!compiledDir) {
  console.error('usage: node measure-deploy-cost.mjs <compiled-dir> [--headroom 0.6] [--params ledger-parameters-config.json]');
  process.exit(2);
}

const limits = structuredClone(MAINNET_LIMITS);
if (paramsFile) {
  const p = JSON.parse(fs.readFileSync(paramsFile, 'utf8')).limits;
  limits.transactionByteLimit = BigInt(p.transaction_byte_limit);
  for (const k of Object.keys(limits.block)) limits.block[k] = BigInt(p.block_limits[k]);
}

const keysDir = path.join(compiledDir, 'keys');
const vks = fs
  .readdirSync(keysDir)
  .filter((f) => f.endsWith('.verifier'))
  .map((f) => ({ id: f.slice(0, -'.verifier'.length), vk: new Uint8Array(fs.readFileSync(path.join(keysDir, f))) }))
  .sort((a, b) => b.vk.length - a.vk.length);
if (vks.length === 0) {
  console.error(`no *.verifier files in ${keysDir} — compile without --skip-zk first`);
  process.exit(2);
}

// Uses the ledger's initial parameters for the cost model only; limits are checked against `limits`.
const params = L.LedgerParameters.initialParameters();
const ttl = () => new Date(Date.now() + 3_600_000);

const deployTx = (subset) => {
  const state = new L.ContractState();
  for (const { id, vk } of subset) {
    const op = new L.ContractOperation();
    op.verifierKey = vk;
    state.setOperation(id, op);
  }
  state.maintenanceAuthority = new L.ContractMaintenanceAuthority(
    [L.signatureVerifyingKey(L.sampleSigningKey())],
    1,
    0n,
  );
  return L.Transaction.fromParts('undeployed', undefined, undefined, L.Intent.new(ttl()).addDeploy(new L.ContractDeploy(state)));
};

const insertTx = (subset) => {
  const sk = L.sampleSigningKey();
  const updates = subset.map(
    ({ id, vk }) => new L.VerifierKeyInsert(id, new L.ContractOperationVersionedVerifierKey('v3', vk)),
  );
  let mu = new L.MaintenanceUpdate(L.sampleContractAddress(), updates, 0n);
  mu = mu.addSignature(0n, L.signData(sk, mu.dataToSign));
  return L.Transaction.fromParts('undeployed', undefined, undefined, L.Intent.new(ttl()).addMaintenanceUpdate(mu));
};

const measure = (tx) => ({ bytes: BigInt(tx.serialize().length), cost: tx.cost(params) });

// Returns the dimensions that exceed `factor` × limit.
const over = ({ bytes, cost }, factor) => {
  const scale = (v) => (v * BigInt(Math.round(factor * 1000))) / 1000n;
  const bad = [];
  if (bytes > scale(limits.transactionByteLimit)) bad.push(`txBytes ${bytes} > ${scale(limits.transactionByteLimit)}`);
  for (const [k, lim] of Object.entries(limits.block)) {
    if (cost[k] > scale(lim)) bad.push(`${k} ${cost[k]} > ${scale(lim)}`);
  }
  return bad;
};

// Largest prefix of `list` (largest keys first) whose tx fits within headroom.
const maxFitting = (build) => {
  let n = 0;
  while (n < vks.length && over(measure(build(vks.slice(0, n + 1))), headroom).length === 0) n++;
  return n;
};

const totalVkBytes = vks.reduce((a, { vk }) => a + vk.length, 0);
console.log(`circuits with verifier keys: ${vks.length}, total VK bytes: ${totalVkBytes}`);
console.log(`largest VK: ${vks[0].id} (${vks[0].vk.length} B), smallest: ${vks.at(-1).id} (${vks.at(-1).vk.length} B)`);

const full = measure(deployTx(vks));
console.log('\nsingle deploy with ALL verifier keys:');
console.log(`  tx bytes     ${full.bytes} (limit ${limits.transactionByteLimit})`);
for (const [k, lim] of Object.entries(limits.block)) console.log(`  ${k.padEnd(12)} ${full.cost[k]} (block limit ${lim})`);
const hardFail = over(full, 1);
if (hardFail.length > 0) {
  console.log(`\nRESULT: DOES NOT FIT in one block — exceeds: ${hardFail.join('; ')}`);
  console.log('        Fee computation (wallet balancing) fails with "exceeded block limit in transaction fee computation".');
} else if (over(full, headroom).length > 0) {
  console.log(`\nRESULT: under the raw block limit but over ${headroom * 100}% of it — the node will likely reject it with 1010 "Transaction would exhaust the block limits". Batch it.`);
} else {
  console.log('\nRESULT: fits in one block — a normal deployContract() should work.');
}

const d = maxFitting(deployTx);
const m = maxFitting(insertTx);
const one = measure(insertTx([vks[0]]));
console.log(`\nbatch plan at ${headroom * 100}% of limits (worst case: largest keys first):`);
console.log(`  first deploy can carry up to ${d} verifier keys`);
console.log(`  a single-insert maintenance tx (submitInsertVerifierKeyTx) costs bytesWritten ${one.cost.bytesWritten}`);
console.log(`  a multi-insert MaintenanceUpdate could carry up to ${m} keys per tx`);
const remaining = Math.max(0, vks.length - d);
console.log(`  => 1 deploy tx + ${remaining} single-insert txs (SDK path used by batch-deploy.ts)`);
process.exit(over(full, headroom).length > 0 ? 1 : 0);
