#!/usr/bin/env node
/**
 * check-compact.mjs: read-only checker for Compact mistakes that AI-written (or copied) contracts
 * make, and an explainer for the compiler's error messages.
 *
 * Static scan (always): flags known mistake patterns line by line, with the fix. Every pattern was
 * reproduced against the real compilers (0.31.1, 0.35.0 and 0.36.1) before it was added.
 * --compile: also runs `compact compile +0.36.1 --skip-zk` on each contract (0.36.1 is the compiler
 * every network needs) and explains the error the compiler prints. If 0.36.1 fails and 0.31.1 is
 * installed, it tries 0.31.1 too, to spot code written for older Compact. Output goes to a
 * temporary directory; nothing in your project is written.
 *
 * Requirements: Node >= 20, no npm install. --compile needs the `compact` CLI.
 *
 * Usage:
 *   node check-compact.mjs contracts/                 # static scan of every .compact file
 *   node check-compact.mjs --compile contracts/counter.compact
 *   node check-compact.mjs --compile --compiler 0.36.1 src/   # 0.36.1 is the default
 *   node check-compact.mjs --compile --timeout 900 big.compact  # seconds per compile (default 300)
 *   node check-compact.mjs --explain 'operation get undefined for ledger field type Map<Field, Field>'
 *   node check-compact.mjs --json contracts/
 *
 * Exit code: 0 = nothing found (and it compiles, with --compile), 2 = at least one problem,
 *            1 = could not run (bad arguments, unreadable files, no compiler). 1 is never a verdict.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`Node >= 20 is required (this is ${process.version})`);
  process.exit(1);
}

const USAGE = 'usage: node check-compact.mjs [--compile] [--compiler <version>] [--timeout <seconds>] [--json] <file|dir> …\n       node check-compact.mjs --explain "<compiler message>"';

// ---------- data, from the compiler source (LFDT-Minokawa/compact, tags compactc-v0.31.1 and
// compactc-v0.36.1: compiler/standard-library.compact, zkir-v3-library.compact, midnight-natives.ss,
// zkir-v3-natives.ss, midnight-ledger.ss, standard-library-aliases.ss) ----------
const NETWORK_COMPILER = '0.36.1';
// The compiler most older code was written for; --compile tries it when the network compiler fails.
const OLD_COMPILER = '0.31.1';
const LANGUAGE = { '0.31.1': '0.23.0', '0.34.0': '0.26.0', '0.35.0': '0.27.0', '0.36.0': '0.28.0', '0.36.1': '0.28.0' };

// Old name → new name. 0.31.1 recognises all of these and names the replacement; 0.35.0 and 0.36.1
// still recognise the circuit and ledger-operation names but not the two type names.
const RENAMED = {
  transient_hash: 'transientHash', transient_commit: 'transientCommit', persistent_hash: 'persistentHash',
  persistent_commit: 'persistentCommit', degrade_to_transient: 'degradeToTransient',
  upgrade_from_transient: 'upgradeFromTransient', ec_add: 'ecAdd', ec_mul: 'ecMul',
  ec_mul_generator: 'ecMulGenerator', hash_to_curve: 'hashToCurve', merkle_tree_path_root: 'merkleTreePathRoot',
  merkle_tree_path_root_no_leaf_hash: 'merkleTreePathRootNoLeafHash', native_token: 'nativeToken',
  own_public_key: 'ownPublicKey', create_zswap_input: 'createZswapInput', create_zswap_output: 'createZswapOutput',
  token_type: 'tokenType', mint_token: 'mintShieldedToken', evolve_nonce: 'evolveNonce',
  burn_address: 'shieldedBurnAddress', send_immediate: 'sendImmediateShielded', merge_coin: 'mergeCoin',
  merge_coin_immediate: 'mergeCoinImmediate', mintToken: 'mintShieldedToken', burnAddress: 'shieldedBurnAddress',
  receive: 'receiveShielded', send: 'sendShielded', sendImmediate: 'sendImmediateShielded',
  NativePointX: 'jubjubPointX', NativePointY: 'jubjubPointY', nativePointX: 'jubjubPointX',
  nativePointY: 'jubjubPointY', constructNativePoint: 'constructJubjubPoint',
};
const RENAMED_TYPES = { NativePoint: 'JubjubPoint', CurvePoint: 'JubjubPoint' };
const RENAMED_OPS = {
  check_root: 'checkRoot', claim_contract_call: 'claimContractCall', claim_zswap_coin_receive: 'claimZswapCoinReceive',
  claim_zswap_coin_spend: 'claimZswapCoinSpend', claim_zswap_nullifier: 'claimZswapNullifier', insert_coin: 'insertCoin',
  insert_default: 'insertDefault', insert_hash: 'insertHash', insert_hash_index: 'insertHashIndex',
  insert_index: 'insertIndex', insert_index_default: 'insertIndexDefault', is_empty: 'isEmpty', is_full: 'isFull',
  less_than: 'lessThan', pop_front: 'popFront', push_front: 'pushFront', push_front_coin: 'pushFrontCoin',
  reset_history: 'resetHistory', reset_to_default: 'resetToDefault', write_coin: 'writeCoin',
};
// Methods each ledger type has in circuits on 0.36.1 (0.31.1 has all but Kernel.caller): every
// `(function <kind> <name>` in midnight-ledger.ss, where <kind> may be a parenthesised form, except js-only.
const ADT_METHODS = {
  Kernel: ['balance', 'balanceGreaterThan', 'balanceLessThan', 'blockTimeGreaterThan', 'blockTimeLessThan', 'checkpoint', 'claimContractCall', 'claimUnshieldedCoinSpend', 'claimZswapCoinReceive', 'claimZswapCoinSpend', 'claimZswapNullifier', 'incUnshieldedInputs', 'incUnshieldedOutputs', 'mintShielded', 'mintUnshielded', 'self', 'caller'],
  Counter: ['decrement', 'increment', 'lessThan', 'read', 'resetToDefault'],
  Set: ['insert', 'insertCoin', 'isEmpty', 'member', 'remove', 'resetToDefault', 'size'],
  Map: ['insert', 'insertCoin', 'insertDefault', 'isEmpty', 'lookup', 'member', 'remove', 'resetToDefault', 'size'],
  List: ['head', 'isEmpty', 'length', 'popFront', 'pushFront', 'pushFrontCoin', 'resetToDefault'],
  MerkleTree: ['checkRoot', 'insert', 'insertHash', 'insertHashIndex', 'insertIndex', 'insertIndexDefault', 'isFull', 'resetToDefault'],
  HistoricMerkleTree: ['checkRoot', 'insert', 'insertHash', 'insertHashIndex', 'insertIndex', 'insertIndexDefault', 'isFull', 'resetHistory', 'resetToDefault'],
};
// Usual wrong method name → real one, per ledger type.
const METHOD_HINTS = {
  get: 'lookup', has: 'member', contains: 'member', containsKey: 'member', set: 'insert', put: 'insert',
  delete: 'remove', value: 'read', get_value: 'read', add: 'insert', push: 'pushFront', pop: 'popFront',
  len: 'size', length: 'size', count: 'size', clear: 'resetToDefault',
};
// Standard library names on 0.36.1 (exports plus native circuits and types; all need the import).
const STDLIB = [
  'ContractAddress', 'Either', 'Maybe', 'MerkleTreeDigest', 'MerkleTreePath', 'MerkleTreePathEntry',
  'QualifiedShieldedCoinInfo', 'ShieldedCoinInfo', 'ShieldedSendResult', 'UserAddress', 'ZswapCoinPublicKey',
  'blockTimeGt', 'blockTimeGte', 'blockTimeLt', 'blockTimeLte', 'constructJubjubPoint', 'createZswapInput',
  'createZswapOutput', 'degradeToTransient', 'ecAdd', 'ecMul', 'ecMulGenerator', 'evolveNonce', 'hashToCurve',
  'jubjubPointX', 'jubjubPointY', 'left', 'mergeCoin', 'mergeCoinImmediate', 'merkleTreePathRoot',
  'merkleTreePathRootNoLeafHash', 'mintShieldedToken', 'mintUnshieldedToken', 'nativeToken', 'none', 'ownPublicKey',
  'persistentCommit', 'persistentHash', 'receiveShielded', 'receiveUnshielded', 'right', 'sendImmediateShielded',
  'sendShielded', 'sendUnshielded', 'shieldedBurnAddress', 'some', 'tokenType', 'transientCommit', 'transientHash',
  'unshieldedBalance', 'unshieldedBalanceGt', 'unshieldedBalanceGte', 'unshieldedBalanceLt', 'unshieldedBalanceLte',
  'upgradeFromTransient', 'JubjubPoint', 'JubjubScalar',
  // added since 0.31.1: in 0.36.1's standard-library.compact and midnight-natives.ss
  'keccak256', 'jubjubSchnorrVerify', 'JubjubSchnorrSignature', 'ecNeg', 'PublicAddress',
  // the ZKIR v3 library and natives (zkir-v3-library.compact, zkir-v3-natives.ss)
  'sha512', 'secp256k1EcdsaVerify', 'secp256k1EthereumAddress', 'Secp256k1EcdsaSignature', 'secp256r1EcdsaVerify',
  'Secp256r1EcdsaSignature', 'ed25519Verify', 'Ed25519Signature', 'Secp256k1Base', 'Secp256k1Scalar', 'Secp256k1Point',
  'secp256k1PointX', 'secp256k1PointY', 'Secp256r1Base', 'Secp256r1Scalar', 'Secp256r1Point', 'secp256r1PointX',
  'secp256r1PointY', 'Curve25519Base', 'Curve25519Scalar', 'Curve25519Point', 'curve25519PointX', 'curve25519PointY',
];
// Standard-library circuits that read or write the ledger through the kernel (0.36.1's standard-library.compact):
// a circuit that calls one has a proof, so it isn't pure.
const STATE_STDLIB = ['blockTimeGt', 'blockTimeGte', 'blockTimeLt', 'blockTimeLte', 'mergeCoin', 'mergeCoinImmediate',
  'mintShieldedToken', 'mintUnshieldedToken', 'receiveShielded', 'receiveUnshielded', 'sendImmediateShielded', 'sendShielded',
  'sendUnshielded', 'unshieldedBalance', 'unshieldedBalanceGt', 'unshieldedBalanceGte', 'unshieldedBalanceLt', 'unshieldedBalanceLte'];
// Not in Compact 0.31.1, but in 0.36.1. An older compiler reports them as unbound.
const NEWER_THAN_0311 = {
  keccak256: 'a hash function', jubjubSchnorrVerify: 'Schnorr signature verification',
  JubjubSchnorrSignature: 'the Schnorr signature type', ecNeg: 'point negation', PublicAddress: 'an address type',
  JubjubScalar: 'the scalar type', sha512: 'a hash function', secp256k1EcdsaVerify: 'ECDSA verification',
  secp256r1EcdsaVerify: 'ECDSA verification', ed25519Verify: 'Ed25519 verification', secp256k1EthereumAddress: 'an address helper',
  Secp256k1EcdsaSignature: 'a signature type', Secp256r1EcdsaSignature: 'a signature type', Ed25519Signature: 'a signature type',
  serialize: 'a built-in', deserialize: 'a built-in', emit: 'events',
};
const NEWER = (n) => `\`${n}\` (${NEWER_THAN_0311[n]}) is in Compact 0.36.1 but not in the compiler you ran, which is older. Every network needs 0.36.1: \`compact update 0.36\`, then \`compact compile +0.36.1\` (Remediation 8).`;
// Names models invent or remember from older Compact. Each one is `unbound identifier <name>` on 0.31.1 (reproduced).
const SECRET_IDENTITY = 'There is no built-in user identity: kernel.caller() names a calling contract, but reads none for a user\'s own call. Keep a secret in private state, return it from a witness, and compare persistentHash<…>(secret) with a public key stored in the ledger (see "Invented functions" in the runbook).';
const INVENTED = {
  public_key: SECRET_IDENTITY, publicKey: SECRET_IDENTITY, get_public_key: SECRET_IDENTITY, getPublicKey: SECRET_IDENTITY,
  msg: SECRET_IDENTITY, caller: SECRET_IDENTITY, sender: SECRET_IDENTITY,
  verify: 'There is no verify(). Use the named check for the scheme: jubjubSchnorrVerify, secp256k1EcdsaVerify, secp256r1EcdsaVerify or ed25519Verify, each with its own signature and key types. Don\'t take a verification result from a witness: the prover can return true.',
  verify_signature: 'There is no verify_signature(). Use the named check for the scheme: jubjubSchnorrVerify, secp256k1EcdsaVerify, secp256r1EcdsaVerify or ed25519Verify, each with its own signature and key types. Don\'t take a verification result from a witness: the prover can return true.',
  sign: 'Circuits cannot sign. Sign off-chain, or prove knowledge of a secret with persistentHash.',
  hash: 'There is no hash(). Use persistentHash<T>(value) (stable, for the ledger) or transientHash<T>(value) (in-circuit only).',
  encrypt: 'Circuits cannot encrypt. To hide a value but bind to it, store persistentCommit<T>(value, rand) with rand from a witness.',
  decrypt: 'Circuits cannot decrypt. Keep the value in private state and supply it through a witness.',
  random: 'Circuits have no randomness. Supply random values through a witness.',
  randomBytes: 'Circuits have no randomness. Supply random values through a witness.',
  now: 'There is no now(). Compare against block time with blockTimeLt / blockTimeGt / blockTimeLte / blockTimeGte.',
  blockHeight: 'There is no block height. Use the blockTimeLt / blockTimeGt / blockTimeLte / blockTimeGte circuits.',
  blockTimestamp: 'There is no block timestamp value. Use the blockTimeLt / blockTimeGt / blockTimeLte / blockTimeGte circuits.',
  blockTime: 'There is no blockTime(). blockTimeLt / blockTimeGt / blockTimeLte / blockTimeGte(t) compare the block time with t, a Uint<64> of seconds since the Unix epoch. To record the time, take it as an argument and accept it only within a window ending at block time (see the runbook).',
  Address: 'There is no Address type. Use ContractAddress, UserAddress or ZswapCoinPublicKey.',
  Cell: 'Cell<T> is from older Compact. Declare the ledger field with the type directly: `export ledger owner: Bytes<32>;`.',
  Void: 'Void is from older Compact. A circuit that returns nothing is declared `: []`.',
  CoinInfo: 'CoinInfo is the old name: use ShieldedCoinInfo.',
  QualifiedCoinInfo: 'QualifiedCoinInfo is the old name: use QualifiedShieldedCoinInfo.',
  SendResult: 'SendResult is the old name: use ShieldedSendResult.',
  EllipticCurvePoint: 'The curve point type is JubjubPoint.',
  String: 'Compact has no String type. Use Bytes<N> (pad(N, "text") makes a constant) or Opaque<"string"> for values only witnesses read.',
  string: 'Compact has no string type. Use Bytes<N> or Opaque<"string">.',
  to_string: 'Compact has no string conversion. Work with Bytes<N>.', toString: 'Compact has no string conversion. Work with Bytes<N>.',
  from_string: 'Compact has no string conversion. Work with Bytes<N>.', concat: 'There is no concat. Build Bytes or Vectors explicitly.',
  push: 'Vectors have a fixed size. For a growable list, use a ledger List and pushFront.',
  pop: 'Vectors have a fixed size. For a ledger List, use popFront.',
  filter: 'There is no filter. Use fold over a Vector with a condition.', reduce: 'Use fold over a Vector.',
  sort: 'There is no sort. Sort off-circuit and verify order in the circuit if needed.',
  reverse: 'There is no reverse. Index the Vector explicitly.', contains: 'For a ledger Set or Map use member(); for a Vector, use fold.',
  indexOf: 'There is no indexOf. Use fold over the Vector.',
};
const KEYWORD_FIX = {
  let: 'Use `const name = …;` (every local is a const).', var: 'Use `const name = …;` (every local is a const).',
  break: 'There is no break. Loops run over a fixed range; guard the body with if instead.',
  continue: 'There is no continue. Guard the rest of the loop body with if instead.',
  function: 'Compact uses `circuit` (or `pure circuit`), not `function`.',
  delete: '`delete` is reserved. Map and Set use remove(key).',
  void: 'There is no void: a circuit that returns nothing is declared `: []`.',
  throw: 'There are no exceptions: use `assert(condition, "message");`.',
  null: 'There is no null. For an optional value use Maybe<T> (`none<T>()`, `some<T>(x)`); for a zero value, `default<T>`.',
  do: 'There are no do/while loops. Use a bounded loop: `for (const i of 0..N) { … }`.',
  public: 'There are no public/private modifiers: `export circuit` is callable from outside, and a circuit without export is internal.',
  private: 'There are no public/private modifiers: `export circuit` is callable from outside, and a circuit without export is internal.',
  this: 'There is no this: refer to a ledger field by its name (`n`, not `this.n`).',
  class: 'There are no classes: use `struct` for data and `circuit` for code.',
  try: 'There are no exceptions. Use assert(condition, "message").', catch: 'There are no exceptions. Use assert(condition, "message").',
  while: 'There are no while loops. Use a bounded loop: `for (const i of 0..N) { … }`.',
  switch: 'There is no switch. Use if / else if / else.',
  in: 'The loop form is `for (const i of 0..N)`: `of`, not `in`.',
  from: '`from` is a keyword: rename the identifier (e.g. `sender`).',
};
// `event` as a declaration, as opposed to `event` used as a name (reserved since 0.34.0).
const EVENT_DECL = 'A contract can\'t declare its own event types: emit one of the standard library\'s (`emit(Misc { … })` and the like), or record the event as public ledger fields.';
const EMIT = '`emit` takes only the standard library\'s event types, written `emit(Event { … })`. Compilers before 0.34.0 (such as 0.31.1) have no emit at all: compile with 0.36.1.';
const MATCH = 'Compact has no match or switch: use if / else if / else.';
// Type-argument forms of the standard-library generics, for "no compatible function" messages.
const GENERIC_FORM = {
  persistentHash: '`persistentHash<T>(value)`, e.g. `persistentHash<Bytes<32>>(x)`', transientHash: '`transientHash<T>(value)`',
  persistentCommit: '`persistentCommit<T>(value, rand)` (rand is a Bytes<32> from a witness)', transientCommit: '`transientCommit<T>(value, rand)` (rand is a Field)',
  merkleTreePathRoot: '`merkleTreePathRoot<N, T>(path)`, e.g. `merkleTreePathRoot<10, Bytes<32>>(path)`',
  merkleTreePathRootNoLeafHash: '`merkleTreePathRootNoLeafHash<N>(path)`',
  some: '`some<T>(value)`', none: '`none<T>()`', left: '`left<A, B>(value)` (the value is an A)', right: '`right<A, B>(value)` (the value is a B)',
};
// Split "A, B<C, D>, E" at top-level commas.
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const RUNBOOK = 'compact-ai-generated-compile-errors-runbook.md';
// Lookups that ignore inherited keys (so `constructor` isn't mistaken for a table entry).
const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

// ---------- arguments ----------
const args = process.argv.slice(2);
const opts = { compile: false, compiler: NETWORK_COMPILER, json: false, explain: undefined, timeout: 300 };
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--compile') opts.compile = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--compiler' || a === '--explain' || a === '--timeout') {
    const v = args[++i];
    if (v === undefined) fail(`${a} needs a value\n${USAGE}`);
    if (a === '--compiler') opts.compiler = v;
    else if (a === '--timeout') opts.timeout = Number(v);
    else opts.explain = v;
  } else if (a.startsWith('-')) fail(`unknown option ${a}\n${USAGE}`);
  else inputs.push(a);
}
if (!opts.explain && !inputs.length) fail(USAGE);
if (!/^\d+\.\d+\.\d+$/.test(opts.compiler)) fail(`--compiler must be a version like 0.36.1`);
if (!(opts.timeout > 0)) fail('--timeout must be a number of seconds');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------- reading source ----------
// Blank out comments and string contents (keeping line and column positions), so patterns only
// match code. `strings` keeps the raw string literals with their positions for path checks.
function strip(src) {
  let out = '';
  const strings = [];
  for (let i = 0; i < src.length; ) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < src.length) { out += '  '; i += 2; }
    } else if (c === '"') {
      const start = i;
      out += '"'; i++;
      let val = '';
      while (i < src.length && src[i] !== '"' && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < src.length) { val += src[i + 1]; out += '  '; i += 2; continue; }
        val += src[i]; out += ' '; i++;
      }
      if (src[i] === '"') { out += '"'; i++; }
      strings.push({ index: start, value: val });
    } else { out += c; i++; }
  }
  return { code: out, strings };
}

// Returns index -> { line, col }, with the line starts computed once (a file can have thousands of findings).
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: index - starts[lo] + 1 };
  };
}

// Names the contract defines itself (so we don't flag them as invented).
function definedNames(code) {
  const names = new Set();
  const params = (list) => { for (const p of list.split(',')) { const k = p.trim().match(/^([\w$]+)\s*(?::|$)/); if (k) names.add(k[1]); } };
  for (const m of code.matchAll(/\b(?:circuit|witness|struct|enum|contract|module)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bledger\s+([\w$]+)\s*:/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:circuit|witness)\s+[\w$]+\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g)) params(m[1]);
  for (const m of code.matchAll(/\bconstructor\s*\(([^)]*)\)/g)) params(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?::\s*[^=;{}()]+?)?\s*=>/g)) params(m[1]);
  for (const m of code.matchAll(/([\w$]+)\s*=>/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bconst\s*\[([^\]]*)\]/g)) params(m[1]);
  // const a = …, b = …;  (every binding, at the statement's top level)
  for (const m of code.matchAll(/\bconst\s+/g)) {
    let depth = 0, start = m.index + m[0].length;
    const bind = (end) => { const k = code.slice(start, end).match(/^\s*([\w$]+)/); if (k) names.add(k[1]); };
    for (let j = start; j < code.length; j++) {
      const ch = code[j];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch) && --depth < 0) { bind(j); break; }
      else if (ch === ';') { bind(j); break; }
      else if (ch === ',' && depth === 0) { bind(j); start = j + 1; }
    }
  }
  return names;
}

// Ledger field name -> value type head of a Map whose values are themselves a ledger type (Map<K, Set<T>>).
function nestedValueTypes(code) {
  const out = new Map();
  for (const m of code.matchAll(/\bledger\s+(\w+)\s*:\s*Map\s*</g)) {
    const open = m.index + m[0].length - 1, end = matchClose(code, open, '<', '>');
    if (end < 0) continue;
    const v = splitTop(code.slice(open + 1, end - 1))[1]?.match(/^(\w+)/)?.[1];
    if (v && has(ADT_METHODS, v)) out.set(m[1], v);
  }
  return out;
}
function ledgerFields(code) {
  const fields = new Map();
  for (const m of code.matchAll(/\bledger\s+(\w+)\s*:\s*(\w+)/g)) fields.set(m[1], fields.has(m[1]) && fields.get(m[1]) !== m[2] ? null : m[2]);
  return fields;
}

// Index just past the matching close bracket for the open bracket at `i`.
function matchClose(code, i, open, close) {
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === open) depth++;
    else if (code[j] === close && --depth === 0) return j + 1;
  }
  return -1;
}

// matchClose for every open bracket in one pass: open index -> index just past its close bracket.
function bracketPairs(code, open, close) {
  const pairs = new Map(), stack = [];
  for (let j = 0; j < code.length; j++) {
    if (code[j] === open) stack.push(j);
    else if (code[j] === close && stack.length) pairs.set(stack.pop(), j + 1);
  }
  return pairs;
}

// Bodies of circuits and constructors, as [open brace, index past the close brace], in file order. A
// circuit header ends at the next `{` (a body) or `;` (a declaration); that position is kept until the
// scan passes it, so a file of headers with no body stays linear.
function circuitBodies(code) {
  const bodies = [], stop = /[{;]/g, paren = /\)/g, brace = /\s*\{/y;
  let nextStop = -1, nextParen = -1, from = 0;
  for (const h of code.matchAll(/\bcircuit\s+\w+|\bconstructor\s*\(/g)) {
    if (h.index < from) continue;
    const after = h.index + h[0].length;
    let open;
    if (h[0].startsWith('circuit')) {
      if (nextStop < after) { stop.lastIndex = after; nextStop = stop.exec(code)?.index ?? code.length; }
      if (code[nextStop] !== '{') { from = nextStop; continue; }
      open = nextStop;
    } else {
      if (nextParen < after) { paren.lastIndex = after; nextParen = paren.exec(code)?.index ?? code.length; }
      brace.lastIndex = nextParen + 1;
      if (nextParen >= code.length || !brace.test(code)) continue;
      open = brace.lastIndex - 1;
    }
    const end = matchClose(code, open, '{', '}');
    if (end > 0) bodies.push([open, end]);
    from = open + 1;
  }
  return bodies;
}

// ---------- pragma ----------
const cmpVer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
// true/false whether the pragma accepts `lang`; undefined if it can't be parsed. The grammar has
// version terms with an optional comparison, combined with &&, ||, ! and parentheses.
function pragmaAccepts(expr, lang) {
  const toks = expr.match(/\s*(\|\||&&|!|\(|\)|>=|<=|>|<|==|\d+(?:\.\d+){0,2}|\S)/g)?.map((t) => t.trim()) ?? [];
  let i = 0;
  const term = () => {
    if (toks[i] === '!') { i++; const v = term(); return v === undefined ? undefined : !v; }
    if (toks[i] === '(') { i++; const v = or(); if (toks[i++] !== ')') return undefined; return v; }
    const op = /^(>=|<=|>|<|==)$/.test(toks[i] ?? '') ? toks[i++] : 'exact';
    const ver = toks[i++];
    if (!/^\d+(?:\.\d+){0,2}$/.test(ver ?? '')) return undefined;
    const c = cmpVer(lang, ver);
    if (op === '>=') return c >= 0; if (op === '<=') return c <= 0; if (op === '>') return c > 0; if (op === '<') return c < 0;
    const want = ver.split('.');
    return lang.split('.').slice(0, want.length).join('.') === want.join('.');
  };
  const and = () => { let v = term(); while (toks[i] === '&&') { i++; const w = term(); v = v === undefined || w === undefined ? undefined : v && w; } return v; };
  const or = () => { let v = and(); while (toks[i] === '||') { i++; const w = and(); v = v === undefined || w === undefined ? undefined : v || w; } return v; };
  const v = or();
  return i === toks.length ? v : undefined;
}

// ---------- static scan ----------
function scan(file, src) {
  const stripped = strip(src);
  // `$` is part of identifiers (`private$secret_key`); make it a word character for \b, same length.
  const code = stripped.code.replace(/\$/g, '_'), strings = stripped.strings;
  const findings = [];
  const defined = definedNames(code);
  const fields = ledgerFields(code);
  const nested = nestedValueTypes(code);
  const lineCol = lineIndex(code);
  // Bodies of generic modules (`module M<#n> { … }`): the compiler checks them only once the module is used.
  const genericModules = [...code.matchAll(/\bmodule\s+\w+\s*<[^>{]*>\s*\{/g)].map((g) => [g.index, matchClose(code, g.index + g[0].length - 1, '{', '}')]);
  const inGenericModule = (i) => genericModules.some(([o, e]) => o < i && i < e);
  // Code from other files (include, or import of anything but the standard library) can define names
  // this file uses, so a name that looks invented is only a warning there.
  const pullsIn = /\binclude\s+"|\bimport\s+(?!(?:\{[^}]*\}\s*from\s+)?CompactStandardLibrary\b)["\w]/.test(code);
  const importsStd = /\bimport\s+(?:\{[^}]*\}\s*from\s+)?CompactStandardLibrary\b/.test(code);
  const hasPragma = /\bpragma\s+language_version\b/.test(code);
  const add = (index, rule, problem, fix, severity = 'error') =>
    findings.push({ file, ...lineCol(index), rule, severity, problem, fix });
  const addName = (index, rule, problem, fix) =>
    add(index, rule, pullsIn ? `${problem} (Unless an included or imported file defines it.)` : problem, fix, pullsIn ? 'warning' : 'error');
  const each = (re, fn) => { for (const m of code.matchAll(re)) fn(m); };

  // pragma
  const pragma = code.match(/\bpragma\s+language_version\s+([^;]+);/);
  if (pragma) {
    const expr = pragma[1].trim();
    const lang = LANGUAGE[opts.compiler];
    if (lang) {
      const ok = pragmaAccepts(expr, lang);
      if (ok === false) add(pragma.index, 'pragma-mismatch', `\`pragma language_version ${expr}\` rejects compiler ${opts.compiler} (language ${lang}).`, opts.compiler === NETWORK_COMPILER ? `Compiler ${opts.compiler} is language ${lang}. Use \`pragma language_version >= 0.28;\`: an older compiler then fails straight away instead of building code the networks can't run.` : pragmaAccepts(expr, LANGUAGE[NETWORK_COMPILER]) ? `The pragma is right for ${NETWORK_COMPILER}, which every network needs: compile with \`compact compile +${NETWORK_COMPILER}\` instead of ${opts.compiler}.` : `Compiler ${opts.compiler} is language ${lang}: use a pragma that accepts it. Every network needs 0.36.1 (language 0.28.0): \`pragma language_version >= 0.28;\`.`);
      if (ok === undefined) add(pragma.index, 'pragma-syntax', `\`pragma language_version ${expr}\` isn't a form the compiler accepts.`, 'Combine bounds with && (e.g. `>= 0.28 && <= 0.28`).');
    }
  }

  // contract types (0.34.0 and later): a pure circuit can't be called across contracts, and
  // `contract implements` accepts callees that can't be called either (servicedesk#298)
  {
    const types = new Map();
    for (const t of code.matchAll(/\bcontract\s+(?!implements\b)(\w+)\s*\{/g)) {
      const open = t.index + t[0].length - 1, end = matchClose(code, open, '{', '}');
      if (end < 0) continue;
      const body = code.slice(open + 1, end - 1);
      types.set(t[1], [...body.matchAll(/\bcircuit\s+(\w+)/g)].map((c) => c[1]));
      for (const pc of body.matchAll(/\bpure\s+circuit\s+(\w+)/g)) add(open + 1 + pc.index, 'contract-type-pure', `A contract type can't list a pure circuit (\`${pc[1]}\`).`, 'A cross-contract call needs the called circuit to have a proof, and a pure circuit has none. Drop it from the type; to reuse pure logic from another contract, import its module.');
    }
    const impl = code.match(/\bcontract\s+implements\s+(\w+)\s*;/);
    if (impl && types.has(impl[1])) {
      const witnesses = [...code.matchAll(/\bwitness\s+(\w+)/g)].map((w) => w[1]);
      const fields = [...ledgerFields(code).keys()];
      // The file's own circuits, by name, so state and witness use is followed through helpers.
      const own = new Map();
      for (const h of code.matchAll(/\bcircuit\s+(\w+)\b[^{;]*\{/g)) {
        const open = h.index + h[0].length - 1, end = matchClose(code, open, '{', '}');
        if (end > 0) own.set(h[1], { at: h.index, body: code.slice(open, end) });
      }
      // Names a body calls, and names it mentions, collected once with literal patterns.
      const memo = new Map();
      const scan = (body) => {
        if (!memo.has(body)) memo.set(body, {
          called: new Set([...body.matchAll(/(?<![\w$.])(\w+)\s*(?:<[^;(){}]*>)?\s*\(/g)].map((c) => c[1])),
          named: new Set([...body.matchAll(/(?<![\w$.])(\w+)(?![\w$])/g)].map((c) => c[1])),
        });
        return memo.get(body);
      };
      const calls = (body, n) => scan(body).called.has(n);
      const reaches = (name, direct, seen = new Set()) => {
        if (seen.has(name) || !own.has(name)) return false;
        seen.add(name);
        const { body } = own.get(name);
        return direct(body) || [...own.keys()].some((n) => n !== name && calls(body, n) && reaches(n, direct, seen));
      };
      const stateDirect = (body) => /\bkernel\s*\./.test(body) || fields.some((f) => scan(body).named.has(f)) || STATE_STDLIB.some((n) => calls(body, n));
      const witnessDirect = (body) => witnesses.some((w) => calls(body, w));
      const exported = new Map([...code.matchAll(/\bexport\s+circuit\s+(\w+)\b[^{;]*\{/g)].map((e) => [e[1], e]));
      for (const name of types.get(impl[1])) {
        const h = exported.get(name);
        if (!h || !own.has(name)) continue;
        const callsWitness = reaches(name, witnessDirect);
        const touchesState = reaches(name, stateDirect);
        const why = `The compiler accepts it under \`contract implements ${impl[1]}\`, but the first cross-contract call fails (servicedesk#298).`;
        if (callsWitness) add(h.index, 'implements-unprovable', `\`${name}\` calls a witness, so another contract can't call it. ${why}`, 'Keep witness calls out of the circuits the type lists: a callee runs without the caller\'s witnesses.', 'warning');
        else if (!touchesState) add(h.index, 'implements-unprovable', `\`${name}\` reads and writes no ledger state, so it compiles as a pure circuit with no proof, and another contract can't call it. ${why}`, 'Make it read or write the ledger, or take it out of the contract type.', 'warning');
      }
    }
  }

  // includes and imports that won't resolve
  each(/\binclude\s+"/g, (m) => {
    const s = strings.find((x) => x.index === m.index + m[0].length - 1);
    if (!s) return;
    if (/^std(\.compact)?$/.test(s.value)) return add(m.index, 'include-std', '`include "std"` doesn\'t load the standard library.', 'Use `import CompactStandardLibrary;`.');
    if (s.value.endsWith('.compact')) add(m.index, 'include-extension', `\`include "${s.value}"\`: include adds .compact itself.`, `Write \`include "${s.value.slice(0, -8)}";\`.`);
    else if (!fs.existsSync(path.resolve(path.dirname(file), `${s.value}.compact`))) add(m.index, 'include-missing', `\`include "${s.value}"\`: no ${s.value}.compact next to this file.`, 'Paths are relative to the including file, then each --compact-path / COMPACT_PATH directory. `compact compile --trace-search` shows every place it looked.', 'warning');
  });

  // structure from older Compact or other languages
  each(/\bledger\s*\{/g, (m) => add(m.index, 'ledger-block', '`ledger { … }` blocks no longer exist.', 'Declare each field on its own line: `export ledger name: Type;`.'));
  each(/\bCell\s*</g, (m) => add(m.index, 'cell-wrapper', INVENTED.Cell.split('.')[0] + '.', INVENTED.Cell));
  each(/\bVoid\b/g, (m) => add(m.index, 'void', 'There is no Void type.', INVENTED.Void));
  each(/\bwitness\s+\w+\s*(?:<[^>(]*>)?\s*\([^)]*\)\s*:\s*[^;{]+\{/g, (m) => add(m.index, 'witness-with-body', 'A witness declaration has a body.', 'Declare the witness with `;` only; implement it in TypeScript.'));
  each(/\bwhile\s*\(/g, (m) => add(m.index, 'while', 'There are no while loops.', 'Use a bounded loop: `for (const i of 0..N) { … }`.'));
  each(/\bswitch\s*\(/g, (m) => add(m.index, 'switch', 'There is no switch.', 'Use if / else if / else.'));
  each(/\btry\s*\{|\bcatch\s*\(/g, (m) => add(m.index, 'try-catch', 'There are no exceptions.', KEYWORD_FIX.try));
  each(/\b(break|continue)\s*;/g, (m) => add(m.index, m[1], `There is no ${m[1]}.`, KEYWORD_FIX[m[1]]));
  each(/\b(let|var)\s+\w+/g, (m) => add(m.index, 'let-var', `\`${m[1]}\` is reserved.`, KEYWORD_FIX.let));
  each(/\bfunction\b/g, (m) => add(m.index, 'function-keyword', '`function` is reserved.', KEYWORD_FIX.function));
  each(/\b(void|throw|null|do|this|public|private|class)\b/g, (m) => add(m.index, 'reserved-word', `\`${m[1]}\` is reserved and isn't Compact syntax.`, KEYWORD_FIX[m[1]]));
  const structNames = new Set([...code.matchAll(/\bstruct\s+(\w+)/g)].map((st) => st[1]));
  each(/(?<![\w.])(\w+)\s*\(/g, (m) => {
    if (!structNames.has(m[1])) return;
    add(m.index, 'struct-call', `\`${m[1]}(…)\`: a struct isn't called like a function.`, `Build it with braces: \`${m[1]} { field: value, … }\`.`);
  });
  each(/\b[A-Z]\w*::\w+/g, (m) => add(m.index, 'enum-double-colon', `\`${m[0]}\`: enum variants use a dot.`, `Write \`${m[0].replace('::', '.')}\`.`));
  each(/\bfor\s*\(?\s*(?:const\s+)?\w+\s+in\b/g, (m) => add(m.index, 'for-in', 'This loop form doesn\'t exist.', 'The only loop is `for (const i of 0..N) { … }` (or `of` a Vector).'));
  each(/\bfor\s*\(\s*(?:let|var|const)?\s*\w+\s*=/g, (m) => add(m.index, 'for-c-style', 'C-style for loops don\'t exist.', 'Use `for (const i of 0..N) { … }`.'));
  each(/\b[A-Za-z_]\w*\.\d+\b/g, (m) => add(m.index, 'tuple-dot-index', `\`${m[0]}\`: tuples aren't indexed with .N.`, 'Destructure: `const [a, b] = t;`, or index with `t[0]`.'));
  each(/\bif\b(?!\s*\()/g, (m) => add(m.index, 'if-parentheses', '`if` without parentheses.', 'Write `if (condition) { … }`.'));
  each(/\bassert\b(?!\s*\()/g, (m) => add(m.index, 'assert-call', '`assert` without parentheses (an old form).', 'Write `assert(condition, "message");`.'));
  each(/(?:^|[;}])\s*(?:export\s+)?event\s+\w+\s*[({]/gm, (m) => add(m.index + m[0].indexOf('event'), 'event-declaration', 'A contract can\'t declare its own event types.', EVENT_DECL));
  each(/\bemit\s+(\w+)\s*\(/g, (m) => defined.has('emit') || add(m.index, 'emit-call', `\`emit ${m[1]}(…)\` isn't the form: an event is a struct value in parentheses.`, `Write \`emit (${m[1]} { field: value, … });\` with one of the standard library's event types.`));
  {
    const ownStructs = new Set([...code.matchAll(/\bstruct\s+(\w+)/g)].map((st) => st[1]));
    each(/\bemit\s*\(\s*(\w+)\s*\{/g, (m) => ownStructs.has(m[1]) && add(m.index, 'emit-own-struct', `\`${m[1]}\` is declared in this file, and only the standard library's event types can be emitted.`, EVENT_DECL));
  }
  each(/\bdefault\s*</g, (m) => {
    const end = matchClose(code, m.index + m[0].length - 1, '<', '>');
    if (end > 0 && /^\s*\(\s*\)/.test(code.slice(end))) add(m.index, 'default-parentheses', '`default<T>()` with parentheses.', 'Write `default<T>` without parentheses.');
  });
  each(/(?:[=(,]|\breturn)\s*Bytes\s*<\s*\d+\s*>\s*\{/g, (m) => add(m.index, 'bytes-literal-braces', 'Bytes literals don\'t use braces.', 'Write `Bytes[1, 2, 3]`, `default<Bytes<32>>` or `pad(32, "text")`.'));
  each(/\bUnsigned\s+Integer\s*\[\s*(\d+)\s*\]/g, (m) => add(m.index, 'old-uint-syntax', `\`${m[0]}\` is older Compact syntax.`, `Write \`Uint<${m[1]}>\`.`));
  each(/\bUint\s*<\s*(\d+)\s*>/g, (m) => {
    if (Number(m[1]) > 248) add(m.index, 'uint-width', `Uint<${m[1]}> is wider than the maximum, 248 bits.${inGenericModule(m.index) ? ' (The compiler only reports it once this generic module is used.)' : ''}`, 'Use Uint<248> or smaller, or Field.', inGenericModule(m.index) ? 'warning' : 'error');
    if (Number(m[1]) === 0) add(m.index, 'uint-width', 'Uint<0> isn\'t a type: widths run from 1 to 248.', 'Use Uint<1> or wider.');
  });
  each(/\bsealed\s+export\b|\bledger\s+export\b|\bsealed\s+ledger\s+export\b/g, (m) => add(m.index, 'modifier-order', `\`${m[0]}\`: wrong modifier order.`, 'Write `export sealed ledger name: Type;`.'));
  each(/\b(?:Historic)?MerkleTree\s*<\s*(\d+)\s*,/g, (m) => { const d = Number(m[1]); if (d < 2 || d > 32) add(m.index, 'merkletree-depth', `MerkleTree depth ${d} is out of range.`, 'The depth must be between 2 and 32.'); });
  // A letter first is a missing depth, unless it's a size parameter (`#depth`) of the enclosing module or circuit.
  const sizeParams = new Set([...code.matchAll(/#\s*([A-Za-z]\w*)\b/g)].map((p) => p[1]));
  each(/\b(?:Historic)?MerkleTree\s*<\s*([A-Za-z]\w*)/g, (m) => sizeParams.has(m[1]) || add(m.index, 'merkletree-missing-depth', 'MerkleTree needs a depth first.', 'Write `MerkleTree<depth, T>`, e.g. `MerkleTree<10, Bytes<32>>`.'));
  each(/[=(,]\s*<\s*[A-Z]\w*(?:<[^>]*>)?\s*>\s*\w/g, (m) => add(m.index, 'angle-bracket-cast', 'Angle-bracket casts don\'t exist.', 'Cast with `as`: `x as Field`.'));
  if ((code.match(/\bconstructor\s*\(/g) ?? []).length > 1) add(code.search(/\bconstructor\s*\(/), 'multiple-constructors', 'More than one constructor.', 'A contract has at most one constructor.');
  // operators Compact doesn't have
  each(/[\w)\]]\s*(?<![&|])([&|])(?![&|])\s*[\w(!]/g, (m) => add(m.index, 'bitwise', `\`${m[1]}\` isn't an operator.`, m[1] === '&' ? 'Boolean and is `&&`. There are no bitwise operators; use Vector<N, Boolean> flags.' : 'Boolean or is `||`. There are no bitwise operators; use Vector<N, Boolean> flags.'));
  each(/[\w)\]]\s*(\^)\s*[\w(]|~\s*[\w(]/g, (m) => add(m.index, 'bitwise', `\`${m[0].includes('~') ? '~' : '^'}\` isn't an operator.`, 'There are no bitwise operators. Use Vector<N, Boolean> flags, or != for Booleans.'));
  each(/[\w)\]]\s*(<<|>>)\s*\d+/g, (m) => add(m.index, 'shift', `\`${m[1]}\` isn't an operator.`, m[1] === '<<' ? 'Multiply instead: `(x * 8) as Uint<…>` for << 3.' : 'Get the quotient from a witness and check `q * 8 + r == x` (with r < 8) in the circuit.'));
  each(/[\w)\]]\s*(%)\s*[\w(]/g, (m) => add(m.index, 'modulo', '`%` isn\'t an operator.', 'Get the quotient and remainder from a witness and check `q * d + r == x` and `r < d` in the circuit.'));
  each(/[\w)\]]\s*\/\s*[\w(]/g, (m) => add(m.index, 'division', '`/` isn\'t an operator.', 'Get the quotient and remainder from a witness and check `q * d + r == x` and `r < d` in the circuit.'));
  // assert needs a message
  each(/\bassert\s*\(/g, (m) => {
    const open = m.index + m[0].length - 1, end = matchClose(code, open, '(', ')');
    if (end < 0) return;
    let depth = 0, comma = false;
    for (let j = open + 1; j < end - 1; j++) {
      const ch = code[j];
      const targs = ch === '<' && /\w/.test(code[j - 1] ?? '') ? code.slice(j, j + 200).match(/^<[^;(){}&|=!]*>(?=\s*\()/) : null;
      if (targs) { j += targs[0].length - 1; continue; }
      if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; else if (ch === ',' && depth === 0) comma = true;
    }
    if (!comma) add(m.index, 'assert-message', '`assert` without a message.', 'Write `assert(condition, "message");`.');
  });
  // top-level const
  {
    let depth = 0;
    for (let j = 0; j < code.length; j++) {
      if (code[j] === '{') depth++; else if (code[j] === '}') depth--;
      else if (depth === 0 && code.startsWith('const', j) && /\W/.test(code[j - 1] ?? ' ') && /\s/.test(code[j + 5] ?? '')) {
        add(j, 'top-level-const', 'A `const` at the top level.', 'Move it inside a circuit, or make it a `pure circuit` that returns the value.');
      }
    }
  }

  // more reproduced mistakes
  each(/\brange\s*\(/g, (m) => { if (!defined.has('range')) add(m.index, 'for-range', 'There is no range().', 'Loop with `for (const i of 0..N) { … }`.'); });
  each(/\bfor\s*\(\s*(?!const\b)\w+\s+of\b/g, (m) => add(m.index, 'for-missing-const', 'The loop variable needs `const`.', 'Write `for (const i of 0..N) { … }`.'));
  each(/\bmatch\s*(?:\(\s*\w+\s*\)|\w+)\s*\{/g, (m) => add(m.index, 'match', 'There is no match expression.', 'Use if / else if / else.'));
  each(/(?:\bconst\s+|\(\s*|,\s*)from\b\s*[:=]/g, (m) => add(m.index, 'reserved-from', '`from` is a keyword.', 'Rename the identifier (e.g. `sender`).'));
  each(/(?<![.\w$])caller\b(?![\w$]|\s*[:(])/g, (m) => { if (!defined.has('caller') && !/kernel\s*\.\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index))) addName(m.index, 'invented', '`caller` doesn\'t exist.', SECRET_IDENTITY); });
  if (!importsStd) {
    // Lower-case names count only when called; type names only outside a field or member position.
    const stdlibNames = new Set([...STDLIB, 'Counter', 'Map', 'Set', 'List', 'MerkleTree', 'HistoricMerkleTree']);
    for (const u of code.matchAll(/(?<![\w$.])([A-Za-z]\w*)(?![\w$])/g)) {
      if (!stdlibNames.has(u[1])) continue;
      const after = code.slice(u.index + u[0].length, u.index + u[0].length + 200);
      if (defined.has(u[1]) || (/^[a-z]/.test(u[1]) ? !/^\s*(?:\(|<[^;(){}&|=!]*>\s*\()/.test(after) : /^\s*:(?!:)/.test(after))) continue;
      add(u.index, 'missing-stdlib-import', `\`${u[1]}\` comes from the standard library, which isn't imported.`, `Add \`import CompactStandardLibrary;\` after the pragma.${hasPragma ? '' : ' (If this file is included by one that imports it, ignore this.)'}`, hasPragma ? 'error' : 'warning');
      break;
    }
  }
  {
    // Bodies of circuits and constructors, to scope const declarations.
    const bodies = circuitBodies(code);
    for (const m of code.matchAll(/(?:^|[;{}]\s*)(\w+)\s*=(?!=)/gm)) {
      const name = m[1], at = m.index + m[0].indexOf(name);
      // Bodies are in file order and don't nest (circuits sit at the top level or in modules): binary search.
      let lo = 0, hi = bodies.length - 1, body;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (bodies[mid][0] < at) { body = bodies[mid]; lo = mid + 1; } else hi = mid - 1; }
      if (body && at >= body[1]) body = undefined;
      // Each body's const bindings (name -> first position), collected once.
      if (body && !body[2]) {
        body[2] = new Map();
        for (const c of code.slice(body[0], body[1]).matchAll(/\bconst\s*(\[[^\]]*\]|[^;]*)/g))
          for (const n of c[1].startsWith('[') ? c[1].slice(1, -1).split(',') : splitTop(c[1]).map((b) => b.split(/[:=]/)[0]))
            if (/^\s*\w+\s*$/.test(n) && !body[2].has(n.trim())) body[2].set(n.trim(), body[0] + c.index);
      }
      const declared = body && body[2].has(name) && body[2].get(name) < at;
      if (fields.get(name) && has(ADT_METHODS, fields.get(name)) && fields.get(name) !== 'Kernel')
        add(at, 'adt-assignment', `\`${name}\` is a ${fields.get(name)}; it can't be assigned with =.`, `Use its methods (${ADT_METHODS[fields.get(name)].join(', ')}).`);
      else if (declared && !fields.has(name))
        add(at, 'const-reassignment', `\`${name}\` is a const and can't be reassigned.`, 'Declare a new const with a new name, or keep the value in a ledger field.');
    }
  }
  each(/\bfor\s*\(/g, (m) => {
    const header = matchClose(code, m.index + m[0].length - 1, '(', ')');
    if (header < 0) return;
    const start = header + (code.slice(header).match(/^\s*/)[0].length);
    const end = code[start] === '{' ? matchClose(code, start, '{', '}') : code.indexOf(';', start) + 1;
    if (end <= 0) return;
    let body = code.slice(start, end);
    for (const a of body.matchAll(/=>\s*\{/g)) {
      const o = a.index + a[0].length - 1, e = matchClose(body, o, '{', '}');
      if (e > 0) body = body.slice(0, o) + ' '.repeat(e - o) + body.slice(e);
    }
    const r = body.search(/\breturn\b/);
    if (r >= 0) add(start + r, 'return-in-for', '`return` inside a for loop.', 'Compute the result with fold (or a guarded value) and return after the loop.');
  });
  // names: a call, `name(` or `name<…>(` (a `<` comparison isn't a type argument list)
  each(/(?<![\w$])(\w+)(?![\w$])\s*(?=\(|<[^;(){}&|=!]*>\s*\()/g, (m) => {
    const name = m[1];
    if (defined.has(name)) return;
    const prev = code.slice(Math.max(0, m.index - 1), m.index);
    if (prev === '.') return; // a method; handled below
    if (has(RENAMED, name) && !((name === 'send' || name === 'receive') && /\b(?:circuit|witness)\s+$/.test(code.slice(Math.max(0, m.index - 40), m.index)))) {
      addName(m.index, 'renamed', `\`${name}\` is an old name.`, `Use \`${RENAMED[name]}\`. 0.31.1's fixup rewrites old names (Remediation 1 in the runbook).`);
    } else if (has(NEWER_THAN_0311, name) && cmpVer(opts.compiler, '0.34.0') < 0) {
      addName(m.index, 'newer-than-compiler', `\`${name}\` isn't in compiler ${opts.compiler}.`, NEWER(name));
    } else if (has(INVENTED, name) && /^[a-z]/.test(name)) {
      addName(m.index, 'invented', `\`${name}()\` doesn't exist in Compact.`, INVENTED[name]);
    } else if (/^(persistentHash|transientHash|persistentCommit|transientCommit|merkleTreePathRoot|merkleTreePathRootNoLeafHash)$/.test(name) && code[m.index + m[0].length] === '(') {
      add(m.index, 'missing-generic', `\`${name}(…)\` without its type argument.`, `Write ${GENERIC_FORM[name]}.`);
    } else if (/^(none)$/.test(name) && code[m.index + m[0].length] === '(') {
      add(m.index, 'missing-generic', '`none()` without its type argument.', 'Write `none<T>()`.');
    }
  });
  each(/(?<![\w$.])(Cell|Address|CoinInfo|QualifiedCoinInfo|SendResult|EllipticCurvePoint|String|NativePoint|CurvePoint)(?![\w$])/g, (m) => {
    const name = m[1];
    if (defined.has(name) || name === 'Cell') return;
    if (has(RENAMED_TYPES, name)) addName(m.index, 'renamed', `\`${name}\` is an old type name.`, `Use \`${RENAMED_TYPES[name]}\`. 0.31.1 names the replacement; newer compilers only say "unbound identifier".`);
    else addName(m.index, 'invented', `\`${name}\` isn't a Compact type.`, INVENTED[name]);
  });
  each(/(?<![\w$.])msg\.\w+/g, (m) => defined.has('msg') || addName(m.index, 'invented', `\`${m[0]}\` doesn't exist.`, SECRET_IDENTITY));
  const ownCamelFields = new Set([...code.matchAll(/\b(goesLeft|isSome|isLeft|mtIndex|domainSep)\s*:/g)].map((f) => f[1]));
  each(/\.(goesLeft|isSome|isLeft|mtIndex|domainSep)\b/g, (m) => {
    if (ownCamelFields.has(m[1])) return; // the contract's own struct has this field
    const snake = m[1].replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    add(m.index, 'camelcase-field', `\`.${m[1]}\`: standard library struct fields are snake_case.`, `Use \`.${snake}\`. (The camelCase names are planned, not available yet.)`);
  });
  // methods on ledger fields
  each(/\b(\w+)\s*\.\s*(\w+)\s*\(/g, (m) => {
    const [obj, method] = [m[1], m[2]];
    const type = obj === 'kernel' ? 'Kernel' : fields.get(obj);
    const methods = type && has(ADT_METHODS, type) ? ADT_METHODS[type] : undefined;
    if (type === 'Kernel' && method === 'caller' && cmpVer(opts.compiler, '0.35.0') < 0) return add(m.index, 'newer-than-compiler', `\`kernel.caller()\` isn't in compiler ${opts.compiler} (0.35.0 and later).`, 'Every network needs 0.36.1: compile with `compact compile +0.36.1`.');
    if (!methods || methods.includes(method)) return;
    if (has(RENAMED_OPS, method)) return add(m.index, 'renamed', `\`${obj}.${method}()\` is an old name.`, `Use \`${obj}.${RENAMED_OPS[method]}()\`. 0.31.1's fixup rewrites old names (Remediation 1 in the runbook).`);
    const hint = has(METHOD_HINTS, method) ? METHOD_HINTS[method] : undefined;
    const real = hint && methods.includes(hint) ? hint : type === 'Counter' && method === 'add' ? 'increment' : undefined;
    add(m.index, 'ledger-method', `${type} has no ${method}().`, `${real ? `Use \`${obj}.${real}(…)\`. ` : ''}${type} methods: ${methods.join(', ')}.`);
  });

  each(/\b(\w+)\s*\.\s*lookup\s*\(/g, (m) => {
    const type = nested.get(m[1]);
    if (!type) return;
    const close = matchClose(code, m.index + m[0].length - 1, '(', ')');
    const next = close > 0 && code.slice(close).match(/^\s*\.\s*(\w+)\s*\(/);
    if (!next || ADT_METHODS[type].includes(next[1])) return;
    const hint = has(METHOD_HINTS, next[1]) && ADT_METHODS[type].includes(METHOD_HINTS[next[1]]) ? ` Use ${METHOD_HINTS[next[1]]}().` : '';
    add(close, 'ledger-method', `The values of \`${m[1]}\` are ${type}s, and ${type} has no ${next[1]}().`, `${hint.trim()} ${type} methods: ${ADT_METHODS[type].join(', ')}.`.trim());
  });

  // Code that compiles but is still wrong (the runbook's "Compiles, but still wrong"). Warnings only,
  // so they don't change the exit code.
  {
    // Bracket pairs, computed once and only if a rule needs them (an unclosed bracket costs one pass,
    // not one per call).
    let parens, braces;
    const closeParen = (i) => (parens ??= bracketPairs(code, '(', ')')).get(i) ?? -1;
    const closeBrace = (i) => (braces ??= bracketPairs(code, '{', '}')).get(i) ?? -1;
    // `const x = …;` bindings whose value contains a match for `re`, so a use through the const counts too.
    const constsOf = (re) => {
      const names = new Map();
      for (const c of code.matchAll(/\bconst\s+(\w+)\s*(?::[^=;]{1,300})?=(?!=)([^;]*)/g))
        if (re.test(c[2]) && !names.has(c[1])) names.set(c[1], c.index + c[0].indexOf(c[1], 5) + c[1].length);
      return names;
    };
    // Each later use of those consts, as [index, name].
    const usesOf = (names) => {
      if (!names.size) return [];
      return [...code.matchAll(/(?<![\w.])\w+(?!\w)/g)].filter((u) => names.has(u[0]) && u.index >= names.get(u[0])).map((u) => [u.index, u[0]]);
    };
    // Whether the expression at [start, end) is an operand of == / != ('eq') or of any comparison ('any').
    const AFTER = { eq: /^(?:\s*\.\s*\w+)*\s*[!=]=/, any: /^(?:\s*\.\s*\w+)*\s*(?:[<>]=?|[!=]=)/ };
    const BEFORE = { eq: /[!=]=\s*$/, any: /(?:[<>]=?|[!=]=)\s*$/ };
    const comparedAt = (start, end, ops) => AFTER[ops].test(code.slice(end, end + 200)) || BEFORE[ops].test(code.slice(Math.max(0, start - 20), start));

    if (!defined.has('ownPublicKey')) {
      const problem = '`ownPublicKey()` compared with a key isn\'t authorization: the caller supplies it, and a key stored in the ledger is public, so anyone can pass by copying it. (This compiles.)';
      const fix = 'Use the identity pattern: a secret returned from a witness, hashed with persistentHash, compared with the key in the ledger (runbook, "Invented functions").';
      each(/\bownPublicKey\s*\(\s*\)/g, (m) => comparedAt(m.index, m.index + m[0].length, 'eq') && add(m.index, 'ownpublickey-auth', problem, fix, 'warning'));
      for (const [at, name] of usesOf(constsOf(/\bownPublicKey\s*\(\s*\)/))) if (comparedAt(at, at + name.length, 'eq')) add(at, 'ownpublickey-auth', problem, fix, 'warning');
    }

    if (!defined.has('unshieldedBalance')) {
      const problem = '`unshieldedBalance()` in a comparison records the exact balance in the public transcript, and the transaction fails if the balance changes before it lands. (This compiles.)';
      const fix = 'Use unshieldedBalanceGt / unshieldedBalanceGte / unshieldedBalanceLt / unshieldedBalanceLte, which record only the yes/no.';
      each(/\bunshieldedBalance\s*\(/g, (m) => {
        const end = closeParen(m.index + m[0].length - 1);
        if (end > 0 && comparedAt(m.index, end, 'any')) add(m.index, 'unshieldedbalance-compare', problem, fix, 'warning');
      });
      for (const [at, name] of usesOf(constsOf(/\bunshieldedBalance\s*\(/))) if (comparedAt(at, at + name.length, 'any')) add(at, 'unshieldedbalance-compare', problem, fix, 'warning');
    }

    if (/\.\s*checkRoot\s*\(/.test(code)) {
      // `if (tree.checkRoot(…))`, or `if (ok)` with `const ok = tree.checkRoot(…)` used nowhere else, and
      // no else branch: a bad root then just skips the branch.
      const ifs = [...code.matchAll(/\bif\s*\(/g)].map((m) => [m.index, m.index + m[0].length - 1, closeParen(m.index + m[0].length - 1)]).filter(([, , e]) => e > 0);
      // Whether the branch after the condition ending at `condEnd` has an else. Called in file order, so
      // the next `;` is kept until the scan passes it.
      let nextSemi = -1;
      const space = /\s*/y;
      const hasElse = (condEnd) => {
        space.lastIndex = condEnd; space.test(code);
        const s = space.lastIndex;
        if (code[s] !== '{' && nextSemi < s) { nextSemi = code.indexOf(';', s); if (nextSemi < 0) nextSemi = code.length; }
        const blockEnd = code[s] === '{' ? closeBrace(s) : nextSemi < code.length ? nextSemi + 1 : -1;
        return blockEnd > 0 && /^\s*else\b/.test(code.slice(blockEnd, blockEnd + 20));
      };
      const viaConst = constsOf(/\.\s*checkRoot\s*\(/), uses = usesOf(viaConst);
      // Conditions don't overlap: find the last one opened before `at`.
      const inCondition = (at) => {
        let lo = 0, hi = ifs.length - 1, last;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (ifs[mid][1] < at) { last = ifs[mid]; lo = mid + 1; } else hi = mid - 1; }
        return last !== undefined && at < last[2];
      };
      const onlyInIf = new Set([...viaConst.keys()].filter((n) => uses.some(([, u]) => u === n) && uses.every(([at, u]) => u !== n || inCondition(at))));
      for (const [at, open, end] of ifs) {
        const cond = code.slice(open, end);
        if ((/\.\s*checkRoot\s*\(/.test(cond) || (onlyInIf.size && [...cond.matchAll(/(?<![\w.])\w+(?!\w)/g)].some((w) => onlyInIf.has(w[0]) && viaConst.get(w[0]) < at))) && !hasElse(end))
          add(at, 'checkroot-branch', 'An `if` on the result of `checkRoot`: with a bad root the branch is skipped and the transaction still succeeds, silently. (This compiles.)', 'For a guard, use `assert(tree.checkRoot(disclose(root)), "bad root");`.', 'warning');
      }
    }

    // Per circuit body: a Merkle path that isn't tied to the caller, and a self-mint received twice.
    if (/\.\s*checkRoot\s*\(|\bmintUnshieldedToken\b/.test(code)) for (const [open, end] of circuitBodies(code)) {
      const body = code.slice(open, end);
      if (/\.\s*checkRoot\s*\(/.test(body) && !/\bleaf\s*:/.test(body)) {
        // `path.leaf`, or `path.value.leaf` for a Maybe: the name the chain starts from.
        const bound = new Set([...body.matchAll(/(?<![\w.])(\w+)(?:\s*\.\s*\w+)*?\s*\.\s*leaf\b/g)].map((l) => l[1]));
        for (const r of body.matchAll(/\bmerkleTreePathRoot(?:NoLeafHash)?\s*(?:<[^;(){}]{0,300}>)?\s*\(/g)) {
          const close = closeParen(open + r.index + r[0].length - 1);
          if (close < 0) continue;
          const args = [...code.slice(open + r.index + r[0].length, close - 1).matchAll(/(?<![\w.])\w+(?!\w)/g)].map((a) => a[0]);
          if (!args.some((a) => bound.has(a))) add(open + r.index, 'merkle-path-unbound', 'A Merkle path checked against the root but not tied to the caller: it proves some member exists, not that the caller is one, and the paths are public. (This compiles.)', 'Bind it: `assert(path.leaf == commitment, "…")`, with `commitment` computed from the caller\'s secret. To stop a member using it twice, add a nullifier.', 'warning');
        }
      }
      if (!defined.has('receiveUnshielded')) {
        // `const color = mintUnshieldedToken(…, left<…>(kernel.self()))`, then `receiveUnshielded(color, …)`.
        const minted = new Set();
        for (const t of body.matchAll(/\bconst\s+(\w+)\s*(?::[^=;]{1,300})?=\s*mintUnshieldedToken\s*\(/g)) {
          const close = closeParen(open + t.index + t[0].length - 1);
          if (close > 0 && /\bkernel\s*\.\s*self\s*\(/.test(code.slice(open + t.index, close))) minted.add(t[1]);
        }
        if (minted.size) for (const r of body.matchAll(/\breceiveUnshielded\s*\(\s*(\w+)\s*,/g)) if (minted.has(r[1]))
          add(open + r.index, 'self-mint-received', '`receiveUnshielded` after `mintUnshieldedToken` to the contract itself: the mint already records the receipt, so receiving the same tokens counts them twice. (This compiles.)', 'Drop the receiveUnshielded for the minted token.', 'warning');
      }
    }
  }

  // dedupe (same rule, same position)
  const seen = new Set();
  return findings
    .filter((f) => { const k = `${f.line}:${f.col}:${f.rule}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.line - b.line || a.col - b.col);
}

// ---------- explaining a compiler message ----------
function closest(name, list) {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
    return m[a.length][b.length];
  };
  let best;
  for (const x of list) { const s = d(name, x); if (!best || s < best.s) best = { x, s }; }
  return best && best.s <= Math.max(2, Math.floor(name.length / 3)) ? best.x : undefined;
}

const ONE_ERROR = 'The compiler reports one error per run (all disclosure errors at once): a parse error first, then unknown names, then type errors in file order. Fix this one and re-run; the next one may be earlier in the file.';

// `line` is the source line the error points at, when known (--compile); it disambiguates parse errors.
// `compiler` is the version that printed the message, when known (--compile); --explain doesn't know it.
function explain(message, line = '', compiler) {
  const msg = String(message).trim();
  const m = (re) => msg.match(re);
  const on = (re) => re.test(line);
  let r;
  if ((r = m(/unbound identifier ([\w$]+)/))) {
    const n = r[1];
    const onCurrent = compiler !== undefined && cmpVer(compiler, '0.36.0') >= 0;
    if (has(NEWER_THAN_0311, n) && !STDLIB.includes(n)) return NEWER(n);
    if (has(NEWER_THAN_0311, n)) return onCurrent ? `\`${n}\` comes from the standard library: add \`import CompactStandardLibrary;\` after the pragma.` : `\`${n}\` comes from the 0.36.1 standard library. If \`import CompactStandardLibrary;\` is missing, add it after the pragma; if it's there, the compiler that printed this is older than 0.36.1: ${NEWER(n).split(': ').slice(1).join(': ')}`;
    if (has(RENAMED_TYPES, n)) return `\`${n}\` is an old type name: use \`${RENAMED_TYPES[n]}\` (0.31.1 says so; newer compilers dropped the hint).`;
    if (has(INVENTED, n)) return INVENTED[n];
    if (n === 'range') return 'There is no range(): loop with `for (const i of 0..N) { … }`.';
    if (STDLIB.includes(n) || has(ADT_METHODS, n)) return `\`${n}\` comes from the standard library: add \`import CompactStandardLibrary;\` after the pragma.`;
    const near = closest(n, [...STDLIB, ...Object.keys(NEWER_THAN_0311)]);
    return `\`${n}\` isn't defined here or in the 0.36.1 standard library${near ? `; did you mean \`${near}\`?` : '.'} Check the spelling and that \`import CompactStandardLibrary;\` is present.`;
  }
  if ((r = m(/apparent use of an old standard-library \/ ledger operator name (\w+):\s*the new name is (\w+)/)))
    return `Rename \`${r[1]}\` to \`${r[2]}\`. 0.31.1's fixup rewrites every old name at once (Remediation 1); it stops while a name or type error remains, so remove invented names first.`;
  if ((r = m(/operation = undefined for ledger field type (\w+)/))) return `A ${r[1]} can't be assigned with =: use its methods (${(has(ADT_METHODS, r[1]) ? ADT_METHODS[r[1]] : []).join(', ')}).`;
  if ((r = m(/operation (\w+) undefined for ledger field type (\w+)/))) {
    const [method, type] = [r[1], r[2]];
    if (type === 'Kernel' && method === 'caller') return '`kernel.caller()` needs Compact 0.35.0 or later; every network needs 0.36.1 (`compact compile +0.36.1`). It names a calling contract only: for a user calling directly it reads none, so it can\'t authorize users. ' + SECRET_IDENTITY;
    const methods = has(ADT_METHODS, type) ? ADT_METHODS[type] : [];
    const hint = has(METHOD_HINTS, method) ? METHOD_HINTS[method] : undefined;
    return `${type} has no ${method}().${hint && methods.includes(hint) ? ` Use ${hint}().` : ''} ${type} methods: ${methods.join(', ')}.`;
  }
  if ((r = m(/potential witness-value disclosure must be declared but is not/))) {
    const what = m(/potentially disclosed: (.*?)(?: at line|$)/)?.[1] ?? 'a private value';
    return `A private value reaches the public side without disclose(): ${what}. Wrap it in disclose(…) at the last step of the path the message lists, where it becomes public (for a ledger read like member or lookup, that's the argument, not the result), and only if revealing it is intended. disclose() doesn't change the value. Every disclosure error is printed in the same run.`;
  }
  if ((r = m(/no compatible function named (\w+) is in scope/))) {
    const fn = r[1];
    const gen = m(/supplied generic values: <(.*?)> declared generics for function at (.+?): <(.*)>/);
    if (gen) {
      const [supplied, at, declared] = [gen[1], gen[2], gen[3]];
      if (at !== '<standard library>') return `Your circuit \`${fn}\` (${at}) declares the type parameters <${declared}> but is called with <${supplied}>. A size parameter is declared with # (\`circuit ${fn}<#N>(…)\`), a type parameter without it.`;
      const form = has(GENERIC_FORM, fn) ? GENERIC_FORM[fn] : `\`${fn}<${splitTop(declared).map((k, i) => (k === 'size' ? 'N' : 'TABC'[i] ?? 'T')).join(', ')}>(…)\``;
      return `\`${fn}\` takes ${splitTop(declared).length === 1 ? 'a type argument' : `${splitTop(declared).length} type arguments`} (<${declared}>): write ${form}.`;
    }
    const arg = m(/supplied argument types: \((.*?)\) declared argument types for function at (.+?): \((.*)\)/);
    if (arg) {
      const [got, at, want] = [splitTop(arg[1]), arg[2], splitTop(arg[3])];
      const where = at === '<standard library>' ? 'the standard library' : `your circuit at ${at}`;
      if (fn === 'ecMulGenerator' && want.includes('JubjubScalar')) return 'Since 0.34.0, ecMulGenerator takes a JubjubScalar, not a Field (the Field form is 0.31.1\'s): write `ecMulGenerator(x as JubjubScalar)`.';
      if (got.length !== want.length) return `\`${fn}\` (${where}) takes ${want.length} argument(s), (${want.join(', ')}), but got ${got.length}.${/Commit$/.test(fn) ? ' The second argument is the randomness: supply it from a witness.' : ''}`;
      if ([...got].sort().join('|') === [...want].sort().join('|')) return `The arguments to \`${fn}\` are in the wrong order: it takes (${want.join(', ')}).`;
      const diff = got.map((g, i) => (g !== want[i] ? `argument ${i + 1} is ${g}, expected ${want[i]}` : '')).filter(Boolean).join('; ');
      const uintToField = got.some((g, i) => /^Uint</.test(g) && want[i] === 'Field');
      return `The arguments to \`${fn}\` (${where}) don't match: ${diff}. Pass a value of the declared type, or cast with \`as\`${uintToField ? ' (newer compilers don\'t convert a Uint to a Field implicitly: write `x as Field`)' : ''}.`;
    }
    return `The arguments to \`${fn}\` don't match its declaration (in the standard library, or your own circuit): check the type arguments, and the argument types, count and order.`;
  }
  if ((r = m(/language version (\S+) mismatch/)))
    return `The pragma doesn't accept this compiler's language version (${r[1]}). Compilers 0.36.0 and 0.36.1 are language 0.28.0, 0.35.0 is 0.27.0, 0.34.0 is 0.26.0 and 0.31.1 is 0.23.0. Every network needs 0.36.1: compile with \`compact compile +0.36.1\` and use \`pragma language_version >= 0.28;\`, which makes an older compiler fail straight away. A pragma pinned to an older language (\`<= 0.23\`, \`0.27\`) is code written for an older compiler (Remediation 8).`;
  if ((r = m(/structure (\w+) has no field named (\w+)/))) {
    const snake = r[2].replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    return snake !== r[2] ? `Use \`${snake}\`: standard library struct fields are snake_case (camelCase names are planned, not available).` : `${r[1]} has no field ${r[2]}.`;
  }
  if ((r = m(/failed to locate file "([^"]+)"/)))
    return /std\.compact/.test(r[1]) ? 'Use `import CompactStandardLibrary;` instead of including std.' : `Paths are relative to the including file, then each --compact-path / COMPACT_PATH directory. \`include\` adds .compact itself. Re-run with --trace-search to see where it looked.`;
  if ((r = m(/found keyword "(\w+)" \(which is reserved for future use\) looking for (.*)/))) {
    const [kw, wanted] = [r[1], r[2]];
    const asName = /^(?:an identifier|a const binding|a typed pattern|a pattern)/.test(wanted);
    if (kw === 'event') return asName ? '`event` is reserved on newer compilers: rename it (e.g. `evt`).' : EVENT_DECL;
    if (has(KEYWORD_FIX, kw)) return KEYWORD_FIX[kw];
    return asName ? `\`${kw}\` is reserved: use another name.` : `\`${kw}\` is reserved and isn't Compact syntax. See the syntax table in the runbook (Remediation 4).`;
  }
  if ((r = m(/invalid context for reference to struct name (\w+)/))) return `Structs are built with braces, not called: \`${r[1]} { field: value, … }\`.`;
  if ((r = m(/invalid context for reference to (?:variable|ledger field) name (\w+)/))) return `Loop ranges and sizes must be constants (circuits are unrolled), so \`${r[1]}\` can't be used there. Loop to a fixed maximum and guard the body: \`for (const i of 0..8) { if (i < ${r[1]}) { … } }\`.`;
  if (m(/found "event" looking for a program element/)) return EVENT_DECL;
  if ((r = m(/expected (?!test\b)(.+?) to have type (\S+) but received (Uint<0\.\.\d+>)/))) return `Arithmetic widens Uint types: cast the result back, e.g. \`(a + b) as ${r[2]}\`.`;
  if ((r = m(/expected (\w+) argument of (\w+) to have type (.+?) but received (.+)$/)))
    return /^Uint<0\.\./.test(r[4]) ? `Arithmetic widens Uint types: cast the result back, e.g. \`(a + b) as ${r[3]}\`.` : `The ${r[1]} argument of \`${r[2]}\` must be ${r[3]} but is ${r[4]}: pass a value of that type, or cast with \`as\` where the conversion exists.`;
  if (m(/resulting value might exceed largest representable Uint value/)) return 'The result could exceed the widest Uint (Uint<248>). Do the arithmetic in Field (`(a as Field) + b`) and cast back where needed; the cast fails at runtime if the value doesn\'t fit.';
  if (m(/is not a declared event type/)) return 'Only the standard library\'s event types can be emitted; a contract can\'t declare its own. Use one of them (Misc carries your own data), or record the event as a public ledger write.';
  if (m(/expression4/)) return '`<<` and `>>` aren\'t operators: multiply for a left shift; for a right shift get the quotient from a witness and check it.';
  if (m(/found "<" looking for an expression$/)) return 'Angle-bracket casts don\'t exist: cast with `as` (`x as Field`).';
  if (m(/found "\(" looking for ";"/)) return 'Something is called with () that isn\'t a function. The usual cause is `default<T>()`: write `default<T>` without parentheses.';
  if (m(/found "\/" looking for/)) return '`/` isn\'t an operator: get the quotient and remainder from a witness and check `q * d + r == x` and `r < d` in the circuit.';
  if (m(/found ":" looking for ";"/)) return 'Enum variants use a dot: `Choice.rock`, not `Choice::rock`.';
  if (m(/found "=" looking for "of"/)) return 'There are no C-style for loops: write `for (const i of 0..N) { … }`.';
  if (m(/found "\w+" looking for "const"/)) return 'The loop variable needs const: `for (const i of 0..N) { … }`.';
  if (m(/looking for a non-negative numeric constant/)) return 'pad() needs a literal length: `pad(32, "text")`.';
  if (m(/found "\w+" looking for a string/)) return 'pad() needs a string literal: `pad(32, "text")`. For a variable, it\'s already Bytes.';
  if (m(/found "<=" looking for ";", "\|\|", or "&&"/) || m(/found "<" looking for ";", "\|\|", or "&&"/)) return 'Combine pragma bounds with &&: `pragma language_version >= 0.28 && <= 0.28;`.';
  if (m(/found keyword "export" looking for (?:an identifier|"ledger")/)) return 'Modifier order: `export sealed ledger name: Type;`.';
  if (m(/found keyword "from" looking for/)) return '`from` is a keyword: rename the identifier (e.g. `sender`).';
  if (m(/found ";" looking for "\("/) || m(/found ";" looking for "\|\|", "&&"/)) return 'Circuits aren\'t values: there are no lambdas or function references. Call the circuit directly.';
  if (m(/found "\w+" looking for ";", ","/) && on(/\bemit\b/)) return EMIT;
  if ((r = m(/found "(\w+)" looking for ";", ","/))) return `Unexpected \`${r[1]}\`. If the line uses \`emit\`: ${EMIT} Otherwise a keyword from another language is being used as Compact.`;
  if (m(/found "<" looking for "\["/)) return 'Bytes literals are `Bytes[1, 2, 3]`; for a constant string use `pad(32, "text")`.';
  if (m(/found ":" looking for "\)"/)) return 'Enum variants use a dot: `Choice.rock`, not `Choice::rock`.';
  if (m(/found "\{" looking for an identifier/)) return '`ledger { … }` blocks no longer exist: declare `export ledger name: Type;` per field.';
  if (m(/found "\{" looking for ";"$/)) return 'A witness has no body in Compact: declare it with `;` and implement it in TypeScript.';
  if (m(/found "\{" looking for ";", ","/)) return on(/\bmatch\b/) ? MATCH : line ? 'Unexpected `{`: check the line for syntax from another language.' : `If the line is \`match x {\`: ${MATCH}`;
  if (m(/found keyword "const" looking for a program element/)) return 'No top-level const: move it into a circuit or make it a `pure circuit`.';
  if (m(/found "\d+" looking for an identifier/)) return 'Tuples aren\'t indexed with .0: destructure (`const [a, b] = t;`) or use t[0].';
  if (m(/found "\w+" looking for "\("/)) {
    if (on(/\bemit\b/)) return EMIT;
    if (on(/\bassert\b(?!\s*\()/)) return '`assert` is called like a function: `assert(condition, "message");`.';
    const ifFor = 'Write `if (condition)` and `for (const i of 0..N)`: parentheses are required, and that\'s the only loop form.';
    return line ? ifFor : `${ifFor} If the line is \`emit X(…)\` (0.35.0 and 0.36.1 give this message for it too): ${EMIT}`;
  }
  if ((r = m(/unexpected character '(.)'/))) return r[1] === '%' ? '`%` isn\'t an operator: get quotient and remainder from a witness and check them.' : '`&`, `|`, `^`, `~` aren\'t operators: Boolean and/or are `&&` and `||`; there are no bitwise operators.';
  if (m(/found "\)" looking for ","/)) return '`assert` needs a message: `assert(condition, "message");`.';
  if ((r = m(/Uint width (\d+)/))) return r[1] === '0' ? 'Uint widths run from 1 to 248: Uint<0> isn\'t a type.' : 'The widest Uint is Uint<248>.';
  if (m(/MerkleTree depth/)) return 'MerkleTree depth must be between 2 and 32.';
  if ((r = m(/declared number 2 of (?:ADT|generic) parameters for ((?:Historic)?MerkleTree(?:Path)?)/))) return `Write \`${r[1]}<depth, T>\` (\`MerkleTree\`, \`HistoricMerkleTree\` and \`MerkleTreePath\` all take the depth first).`;
  if ((r = m(/mismatch between actual number (\d+) and declared number (\d+) of (?:ADT|generic) parameters for (\w+)/))) {
    const form = { Map: 'Map<K, V>', Set: 'Set<T>', List: 'List<T>', Counter: 'Counter (no type arguments)' }[r[3]];
    return `\`${r[3]}\` takes ${r[2]} type argument(s), not ${r[1]}${form ? `: \`${form}\`` : ''}.`;
  }
  if ((r = m(/another binding found for (\w+) in the same scope(?: at (line \d+ char \d+))?/))) return `\`${r[1]}\` is already defined${r[2] ? ` (${r[2]}; often the standard library import)` : ''}: rename yours, or import the standard library with a prefix (\`import CompactStandardLibrary prefix S_;\`).`;
  if ((r = m(/circuit (\w+) is marked pure but is actually impure/))) return `A pure circuit can't read or write the ledger: drop \`pure\` from \`${r[1]}\`, or pass the value in as an argument.`;
  if ((r = m(/index (\d+) is out-of-bounds for a vector of length (\d+)/))) return `Vector indexes are checked when compiling: index ${r[1]} doesn't exist in a vector of length ${r[2]} (indexes run from 0 to ${Number(r[2]) - 1}).`;
  if (m(/recursion involving/)) return 'Circuits can\'t recurse. Rewrite with a bounded `for` loop or fold.';
  if (m(/return is not supported within for loops/)) return 'No return inside for: compute the result with fold or a variable-free pattern, then return after the loop.';
  if (m(/unreachable statement/)) return 'Remove the code after return.';
  if (m(/might be referenced before it is assigned/)) return 'A name is used before its binding, e.g. `const y = x, x = 1;`: bind it first, in its own const statement.';
  if (m(/found multiple bindings for/)) return 'Two consts with the same name in one block: rename one.';
  if (m(/expected left-hand side of = to have an ADT type/)) return 'Locals can\'t be reassigned: declare a new const (or write to a ledger field).';
  if (m(/exported circuits cannot modify sealed ledger fields/)) return 'Sealed fields can only be set in the constructor (or circuits called only from it).';
  if (m(/cross-contract calls are not yet supported|contract-info\.json/)) return 'The compiler you ran is 0.31.1 or older, which can\'t call other contracts (the contract-info.json message comes first; with the other contract compiled, it says cross-contract calls are not yet supported). Every network needs 0.36.1, which can: `compact compile +0.36.1` (Remediation 8).';
  if ((r = m(/a contract type cannot declare circuit (\w+) pure/))) return `Remove \`pure\` circuits from the contract type: a cross-contract call needs the called circuit to have a proof, and \`${r[1]}\` has none. To reuse pure logic from another contract, import its module (Remediation 10).`;
  if ((r = m(/contract implements failure: this contract exports a circuit named (\w+), but it is declared pure/))) return `\`${r[1]}\` is declared pure, so it can't be called from another contract. Give it a proof: drop \`pure\` and make it touch the ledger. A circuit that is pure without the keyword, or that calls a witness, passes \`contract implements\` but fails at the first call (servicedesk#298, Remediation 10).`;
  if (m(/contract implements failure/)) return 'This contract doesn\'t export what the contract type requires, with the same parameter and return types: check every circuit the type lists (Remediation 10).';
  if (m(/cannot cast from type contract/) || m(/expected structure type, received contract/)) return 'A contract-typed value has no address to read: there\'s no cast to ContractAddress, and no .bytes or .address. To pay a contract you also call, store its address in its own ledger field, set with the reference (Remediation 10).';
  if (m(/incompatible types Uint<0\.\.256> and Uint<0\.\.3> for relational operator/)) return 'If the compiler says "Internal error" and points at the pragma, it\'s a 0.35.0 and 0.36.0 bug with deserialize<Boolean, …>, fixed in 0.36.1 (compact#856): compile with 0.36.1. On an older compiler, compare the byte instead: `deserialize<Uint<8>, 1>(b) == 1`. Otherwise cast one side so the types match.';
  if (m(/cannot export type-parameterized function/)) return 'Export a concrete wrapper: `export circuit f(x: Field): … { return g<Field>(x); }`.';
  if (m(/mismatch between actual (?:return )?type/)) return 'Types don\'t match: cast with `as` (e.g. `(a + b) as Uint<64>`). Since 0.34.0 a bare number literal is a Uint, not a Field: write `0 as Field` (code written for 0.31.1 often needs this).';
  if (m(/incompatible (?:combination of )?types/)) return 'Cast one side so the types match. Field has no < or >; compare Uint values. Compare enums with `Enum.variant`.';
  if (m(/expected test to have type Boolean/)) return 'Conditions must be Boolean: write `x != 0`, not `x`.';
  if (m(/cannot cast from type/)) return 'That cast doesn\'t exist. For a string constant use pad(N, "text").';
  if (m(/cannot be applied to a first argument containing opaque/)) return 'Circuits can store and pass Opaque values but can\'t hash, commit, Merkle-insert or look inside them. Hash it off-circuit and pass the Bytes<32> in.';
  if (m(/opaque type \S+ is not supported/)) return 'Only Opaque<"string"> and Opaque<"Uint8Array"> are supported.';
  if (m(/multiple top-level exports/)) return 'Two exported circuits with the same name: rename one.';
  if (m(/found other ledger constructors/)) return 'Only one constructor per contract.';
  if (m(/another binding found for kernel/)) return '`kernel` is built in: don\'t declare it.';
  if (m(/does not contain a \(single\) module|defines module/)) return 'A module file must contain exactly one module, named like the file.';
  if (m(/expected non-ADT type/)) return 'Ledger types can only nest inside Map values.';
  if (m(/can return without/)) return 'Every path must return: add the else branch.';
  if (m(/unrecognized pragma setting/)) return 'The only pragma is `pragma language_version …;`.';
  if ((r = m(/expected .* to be an ordinary Compact type but received ADT type (\S+)/))) return `${r[1]} is a ledger type: it only works as a ledger field, through its methods. A value of it can't be compared, or put in a tuple or vector.`;
  if ((r = m(/expected structure type, received (\S+)/))) return r[1] === 'JubjubPoint' ? 'JubjubPoint has no fields: use `jubjubPointX(p)` and `jubjubPointY(p)`.' : `${r[1]} isn't a struct, so it has no fields to read with a dot.`;
  if (m(/const binding found in a single-statement context/) || m(/found keyword "const" looking for (?:an expression|a block or an expression)/)) return 'A const is a statement of its own, not part of an expression or a lone if/else branch: write `if (c) { const x = …; … }`, or compute the value with `c ? a : b`.';
  if (m(/call site ambiguity \(multiple compatible functions\)/)) return 'More than one circuit with this name accepts these arguments: rename one, or give them different parameter types.';
  if (m(/include cycle involving/)) return 'Files include each other in a loop: include each file once, from the top-level contract.';
  if (m(/cycle involving (?:modules?|types?)/)) return 'Modules or types refer to each other in a loop: a struct can\'t contain itself, and two modules can\'t import each other.';
  if (m(/is out of Field range/)) return 'That number is larger than the Field modulus. Use a smaller literal, or keep large constants as Bytes<32>.';
  if ((r = m(/(?:pad|slice|vector type) length \d+ exceeds the maximum supported length (\d+)/))) return `Lengths are limited to ${r[1]}: use a smaller size.`;
  if (m(/slice index .* is out-of-bounds|slice index did not reduce to a constant/)) return '`slice<N>(v, i)` needs a constant index, and the slice must fit inside the vector.';
  if (m(/range (?:start|end) for Uint type|end bound \d+ is less than start bound|range end \d+ for Uint type exceeds/)) return 'A Uint range is `Uint<0..N>`: it starts at 0, N is exclusive and at least 1, and N can be at most 2^248.';
  if (m(/spread initializer found after positional or named initializers/)) return 'In a struct value, put the spread first: `S { ...other, a: 1 }`.';
  if ((r = m(/duplicate field name (\w+)/))) return `Two fields are named \`${r[1]}\`: rename one.`;
  if ((r = m(/no export named (\w+) in module (\w+)/))) return `Module ${r[2]} doesn't export \`${r[1]}\`: mark it \`export\` inside the module, or check the name.`;
  if (m(/incompatible arguments in call to anonymous circuit/)) return 'The arguments don\'t match the anonymous circuit\'s parameters (count or types).';
  if (m(/invalid context for reference to (?:function|type alias) name CompactStandardLibrary/)) return 'Import the standard library once (`import CompactStandardLibrary;`) and use its names directly, not as `CompactStandardLibrary.x`.';
  if (m(/is identical to the exported circuit name .* modulo case/)) return 'Two exported circuits differ only in letter case, which clashes on case-insensitive file systems: rename one.';
  if (m(/found "Integer" looking for/)) return 'If the type is `Unsigned Integer[N]` (older Compact), write `Uint<N>`.';
  if ((r = m(/found keyword "for" looking for a program element/))) return 'A for loop can only be inside a circuit or the constructor.';
  if ((r = m(/expected right-hand side of = to have type (.+?) but received (.+)$/))) return `The value is ${r[2]} but the target is ${r[1]}: make the types match (a cast with \`as\` where one exists).`;
  if ((r = m(/found "([^"]+)" looking for a program element or end of file/))) return `\`${r[1]}\` starts something that isn't a top-level declaration (pragma, import, include, struct, enum, ledger, witness, circuit, constructor, module). Check for a stray word or a missing \`}\` above it.`;
  if (m(/looking for a version atom/)) return 'A pragma version is a plain number: `pragma language_version >= 0.28;`.';
  if ((r = m(/found "(\w+)" looking for ",", ";"/))) return `Something is missing before \`${r[1]}\`: usually a \`,\` between two bindings or a \`;\` at the end of the statement.`;
  if ((r = m(/found keyword "(\w+)" looking for (.*)/))) return `\`${r[1]}\` is a keyword, so it can't be used here (the parser wanted ${r[2]}). Use another name, or check the syntax around it.`;
  return undefined;
}

// ---------- compiling ----------
function hasCompact() {
  const r = spawnSync('compact', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}
// Runs `compact` with a time limit. The CLI starts the compiler as a child process, so on timeout (or
// Ctrl-C) the whole process group is killed: killing only the CLI would leave the compiler running.
let running;
process.on('SIGINT', () => { stop(running); process.exit(130); });
function stop(child) {
  if (!child) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ }
}
function runCompact(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('compact', args, { cwd, detached: process.platform !== 'win32' });
    running = child;
    let text = '', timedOut = false;
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    const timer = setTimeout(() => { timedOut = true; stop(child); }, timeoutMs);
    const done = (status) => { clearTimeout(timer); running = undefined; resolve({ status, text, timedOut }); };
    child.on('error', (e) => { text += String(e); done(null); });
    child.on('close', done);
  });
}
async function compileFile(file, version) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'check-compact-'));
  try {
    const r = await runCompact(['compile', `+${version}`, '--skip-zk', path.basename(file), out], path.dirname(file), opts.timeout * 1000);
    if (r.timedOut) return { ok: false, timedOut: true, message: `the compiler didn't finish within ${opts.timeout} s and was stopped`, errors: [] };
    const text = r.text;
    if (/not installed|No such version|failed to (?:find|locate) (?:compiler|version)|Couldn't find compiler|Directory does not exist/i.test(text) && r.status !== 0) return { missing: true, text };
    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('Compiling'));
    // One "Exception:" block per error. Disclosure errors all arrive in one run.
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
      const w = lines[i].match(/^Exception: (\S+) line (\d+) char (\d+):\s*(.*)/);
      if (!w) continue;
      const body = [];
      for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) body.push(lines[j]);
      const message = [w[4], ...body.map((l) => l.trim())].join(' ').trim();
      const section = (head) => {
        const at = body.findIndex((l) => l.trim() === head);
        if (at < 0) return undefined;
        const ind = body[at].match(/^\s*/)[0].length;
        const part = [];
        for (let k = at + 1; k < body.length && body[k].match(/^\s*/)[0].length > ind; k++) part.push(body[k].trim());
        return part.join(' ');
      };
      // The path runs from the private value to where it becomes public; its last step is where disclose() goes.
      const via = body.findIndex((l) => l.trim() === 'via this path through the program:');
      const pathSteps = via < 0 ? [] : body.slice(via + 1).filter((l) => l.match(/^\s*/)[0].length > body[via].match(/^\s*/)[0].length).map((l) => l.trim());
      errors.push({
        where: { file: w[1], line: Number(w[2]), col: Number(w[3]) },
        message,
        disclosure: /potential witness-value disclosure/.test(message)
          ? { value: section('witness value potentially disclosed:'), nature: section('nature of the disclosure:'), path: pathSteps, crosses: pathSteps.at(-1) }
          : undefined,
      });
    }
    const first = errors[0];
    const message = first ? first.message : r.status !== 0 ? lines.slice(0, 4).join(' ') : '';
    return { ok: r.status === 0, where: first?.where, message, errors };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
// Files to compile on their own: one with a pragma, or with exports, ledger fields or a constructor
// outside any module. Anything else is a fragment another file includes, and is reported as not compiled.
function isEntry(src) {
  const { code } = strip(src);
  if (/\bpragma\s+language_version\b/.test(code)) return true;
  let top = code;
  for (const m of code.matchAll(/\bmodule\s+[\w$]+\s*(?:<[^>{]*>)?\s*\{/g)) {
    const end = matchClose(code, m.index + m[0].length - 1, '{', '}');
    if (end > 0) top = top.slice(0, m.index) + ' '.repeat(end - m.index) + top.slice(end);
  }
  return /\bexport\s+(?:pure\s+)?circuit|\bexport\s+(?:sealed\s+)?ledger|\bledger\s+\w+\s*:|\bconstructor\s*\(/.test(top);
}

// ---------- main ----------
// Each file once (links are followed, but a file or directory reached twice is skipped, which also
// stops link loops). A broken link inside a directory is skipped with a note; a missing argument is an error.
function collect(p, out, seen = new Set(), top = true) {
  let st, real;
  try { st = fs.statSync(p); real = fs.realpathSync(p); } catch {
    if (top) fail(`no such file or directory: ${p}`);
    console.error(`skipping ${p}: broken link or unreadable`);
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  if (st.isDirectory()) {
    let entries = [];
    try { entries = fs.readdirSync(p).sort(); } catch { console.error(`skipping ${p}: can't read the directory`); }
    for (const e of entries) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      collect(path.join(p, e), out, seen, false);
    }
  } else if (p.endsWith('.compact')) out.push(p);
}

async function main() {
  if (opts.explain) {
    const e = explain(opts.explain);
    console.log(e ?? 'No explanation for this message yet. See the runbook\'s message table, or open a servicedesk issue with the full error.');
    process.exit(e ? 0 : 2);
  }
  const files = [];
  for (const i of inputs) collect(i, files);
  if (!files.length) fail('no .compact files found');
  if (opts.compile && !hasCompact()) fail('--compile needs the compact CLI on PATH (https://docs.midnight.network)');
  const report = [];
  let problems = 0;
  let fragments = 0;
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (e) { fail(`could not read ${f}: ${e.message}`); }
    const findings = scan(f, src);
    const entry = { file: f, findings };
    problems += findings.filter((x) => x.severity === 'error').length;
    if (opts.compile && !isEntry(src)) {
      fragments++;
      entry.compile = { skipped: 'no pragma and nothing exported: a file other files include, so it isn\'t compiled on its own' };
    } else if (opts.compile) {
      const c = await compileFile(path.resolve(f), opts.compiler);
      if (c.missing) fail(`compiler ${opts.compiler} isn't installed: run \`compact update ${opts.compiler} --no-set-default\``);
      // The source line the error points at (it may be in an included file), to tell similar parse errors apart.
      let line = '';
      if (c.where) try { line = fs.readFileSync(path.resolve(path.dirname(path.resolve(f)), c.where.file), 'utf8').split('\n')[c.where.line - 1] ?? ''; } catch { /* no line: explain() falls back to the message alone */ }
      const explanation = c.ok ? undefined : c.timedOut ? 'The compiler hung on this file. Try a longer --timeout; a compile that never finishes is a compiler bug worth reporting, with the file, to LFDT-Minokawa/compact.' : explain(c.message, line, opts.compiler);
      entry.compile = { compiler: opts.compiler, ok: c.ok, timedOut: c.timedOut || undefined, where: c.where, message: c.message, explanation, disclosures: c.errors?.filter((e) => e.disclosure).map((e) => ({ where: e.where, ...e.disclosure })) };
      if (!c.ok) {
        problems++;
        if (opts.compiler === NETWORK_COMPILER && !c.timedOut) {
          const older = await compileFile(path.resolve(f), OLD_COMPILER);
          if (!older.missing) entry.compile.on_0_31_1 = older.ok ? 'compiles' : older.message;
        }
      }
    }
    report.push(entry);
  }
  if (opts.json) {
    console.log(JSON.stringify({ compiler: opts.compiler, files: report }, null, 1));
  } else {
    for (const e of report) {
      for (const f of e.findings) console.log(`${f.file}:${f.line}:${f.col}  ${f.severity}  ${f.rule}  ${f.problem}\n    fix: ${f.fix}`);
      if (e.compile && !e.compile.skipped) {
        const c = e.compile;
        if (c.ok) console.log(`${e.file}: compiles with ${c.compiler}`);
        else if (c.disclosures?.length) {
          console.log(`${e.file}  compile (${c.compiler})  ${c.disclosures.length} disclosure error(s): a private value reaches the public side without disclose().`);
          for (const d of c.disclosures) {
            console.log(`  ${e.file}:${d.where.line}:${d.where.col}  ${d.value ?? 'a private value'}`);
            if (d.crosses) console.log(`      becomes public at: ${d.crosses}${d.path.length > 1 ? `\n      path: ${d.path.join(' -> ')}` : ''}`);
            if (d.nature) console.log(`      ${d.nature}`);
          }
          console.log('    fix: wrap the value in disclose(…) where it becomes public, the last step of its path (for a ledger read like member or lookup, that\'s the argument, not the result), and only if revealing it is intended. disclose() doesn\'t change the value. See Remediation 7 in the runbook.');
        } else {
          console.log(`${e.file}${c.where ? `:${c.where.line}:${c.where.col}` : ''}  compile (${c.compiler})  ${c.message}`);
          console.log(`    fix: ${c.explanation ?? 'no explanation for this message yet: see the runbook message table.'}`);
          if (c.on_0_31_1 === 'compiles') console.log(`    note: it compiles with ${OLD_COMPILER}, so it was written for older Compact. See Remediation 8 in the runbook.`);
          if (!c.timedOut) console.log(`    ${ONE_ERROR}`);
        }
      }
    }
    const n = report.reduce((s, e) => s + e.findings.length, 0);
    const failed = report.filter((e) => e.compile && !e.compile.skipped && !e.compile.ok).length;
    const compiled = report.filter((e) => e.compile && !e.compile.skipped).length;
    const compileNote = opts.compile ? `; compile with ${opts.compiler}: ${compiled - failed} of ${compiled} contract(s) compile${failed ? `, ${failed} fail` : ''}${fragments ? `; ${fragments} file(s) not compiled on their own (no pragma and nothing exported: files other files include)` : ''}` : '';
    console.log(`\n${files.length} file(s), ${n} static finding(s)${compileNote}. See ${RUNBOOK}.`);
  }
  process.exitCode = problems ? 2 : 0;
}

main().catch((e) => fail(`check-compact failed: ${e?.stack ?? e}`));
