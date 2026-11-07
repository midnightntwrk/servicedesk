#!/usr/bin/env node
/**
 * decode-1010.mjs: read-only decoder for Midnight node transaction rejections. Turns
 * "1010: Invalid Transaction: Custom error: N" into the ledger error N stands for, using the
 * code table of the node version that rejected the transaction.
 *
 * Give it the error text: a log file, piped output, the text itself, or just the number. It finds
 * every `Custom error: N`, every Substrate transaction pool error (1001 to 1021), the wallet SDK's
 * "rejected by the node" errors that carry no code, and the node's own log lines
 * ("Rejected transaction <hash> from mempool: …", "Rejecting transaction <hash> at pre-dispatch:
 * …"), and says what each one means. Offline unless you pass --rpc. Nothing is signed or submitted.
 *
 * Requirements: Node >= 20. No npm install.
 *
 * Usage:
 *   node decode-1010.mjs app.log
 *   node decode-1010.mjs 'RpcError: 1010: Invalid Transaction: Custom error: 196'
 *   npm run deploy 2>&1 | node decode-1010.mjs           # any command that exits; for a server,
 *                                                        # save its output with tee and pass the file
 *   docker logs midnight-node 2>&1 | node decode-1010.mjs -
 *   node decode-1010.mjs 182 --node 2.x
 *   node decode-1010.mjs app.log --rpc https://rpc.preprod.midnight.network
 *   export BLOCKFROST_PROJECT_ID=<your project token>          # never pass it as an argument
 *   node decode-1010.mjs app.log --rpc https://rpc.midnight-mainnet.blockfrost.io
 *
 *   --node  code table: 1.0 (node 1.0.0 to 1.0.400) or 2.x (node 2.x release candidates).
 *           Default 1.0: preview, preprod and mainnet ran node 1.0.400 on 2026-10-07.
 *   --rpc   node RPC URL (http(s), or the ws(s) URL the wallet uses); reads system_version and
 *           picks the table from it. Use one of --node and --rpc, not both.
 *   -       read stdin as well as the other arguments.
 *
 * Exit code: 0 = explained at least one failure, 2 = found none it could explain,
 *            1 = could not run (bad arguments, unreadable input, RPC failure). 1 is never a verdict.
 */

import fs from 'node:fs';

// Blockfrost: the key comes from the environment, never from an argument. It is only sent to
// blockfrost.io hosts and is redacted from every line printed, as is any project_id in a URL.
const KEY = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? '';
const redact = (s) => {
  let out = String(s).replace(/(project_id=)[^&#\s]*/gi, '$1<key>');
  if (KEY) out = out.split(encodeURIComponent(KEY)).join('<key>').split(KEY).join('<key>');
  return out;
};
const fail = (msg) => {
  console.error(redact(msg));
  process.exit(1);
};

if (Number(process.versions.node.split('.')[0]) < 20) fail(`Node >= 20 is required (this is ${process.version})`);

const USAGE =
  'usage: node decode-1010.mjs [--node 1.0|2.x | --rpc <url>] [<file> | <text> | <code> | -] …  (or pipe text in)';

// ---------- code tables ----------
// Generated from `impl From<LedgerApiError> for u8` in midnight-node, not typed by hand:
//   NODE_1_0: tag node-1.0.400 (3acfd2edecdcd91373b6a506933f4c14ad3f0308),
//             ledger/src/versions/common/types.rs. node-1.0.0 to 1.0.300 are identical.
//   NODE_2_X: tag node-2.1.0-rc.4 (1b2b31c714f8986a082b8690f15e805981c771dd),
//             ledger/src/ledger_8/types.rs (ledger_9/types.rs is identical, and so is main at
//             b2f85e1626edb8dec8e49841e69f95943ec7b4e0). node-2.0.0-rc.x lacks only 140.
// Names drop the leading `Transaction.`: `Malformed.X` is LedgerApiError::Transaction(Malformed(X)).
const NODE_1_0 = {
  0: 'Deserialization.NetworkId', 1: 'Deserialization.Transaction',
  2: 'Deserialization.DeserializationLedgerState',
  3: 'Deserialization.DeserializationContractAddress', 4: 'Deserialization.PublicKey',
  5: 'Deserialization.VersionedArenaKey', 6: 'Deserialization.UserAddress',
  7: 'Deserialization.TypedArenaKey', 8: 'Deserialization.SystemTransaction',
  9: 'Deserialization.DustPublicKey', 10: 'Deserialization.CNightGeneratesDustActionType',
  11: 'Deserialization.CNightGeneratesDustEvent', 50: 'Serialization.TransactionIdentifier',
  51: 'Serialization.SerializationLedgerState', 52: 'Serialization.LedgerParameters',
  53: 'Serialization.SerializationContractAddress', 54: 'Serialization.ContractState',
  55: 'Serialization.ContractStateToJson', 56: 'Serialization.ZswapState',
  57: 'Serialization.UnknownType', 58: 'Serialization.MerkleTreeDigest',
  59: 'Serialization.VersionedArenaKey', 60: 'Serialization.TypedArenaKey',
  61: 'Serialization.CNightGeneratesDustEvent', 62: 'Serialization.SystemTransaction',
  63: 'Serialization.ArenaHash', 100: 'Invalid.EffectsMismatch',
  101: 'Invalid.ContractAlreadyDeployed', 102: 'Invalid.ContractNotPresent', 103: 'Invalid.Zswap',
  104: 'Invalid.Transcript', 105: 'Invalid.InsufficientClaimable',
  106: 'Invalid.VerifierKeyNotFound', 107: 'Invalid.VerifierKeyAlreadyPresent',
  108: 'Invalid.ReplayCounterMismatch', 109: 'Invalid.UnknownError',
  110: 'Malformed.VerifierKeyNotSet', 111: 'Malformed.TransactionTooLarge',
  112: 'Malformed.VerifierKeyTooLarge', 113: 'Malformed.VerifierKeyNotPresent',
  114: 'Malformed.ContractNotPresent', 115: 'Malformed.InvalidProof',
  116: 'Malformed.BindingCommitmentOpeningInvalid', 117: 'Malformed.NotNormalized',
  118: 'Malformed.FallibleWithoutCheckpoint', 119: 'Malformed.ClaimReceiveFailed',
  120: 'Malformed.ClaimSpendFailed', 121: 'Malformed.ClaimNullifierFailed',
  122: 'Malformed.ClaimCallFailed', 123: 'Malformed.InvalidSchnorrProof',
  124: 'Malformed.UnclaimedCoinCom', 125: 'Malformed.UnclaimedNullifier',
  126: 'Malformed.Unbalanced', 127: 'Malformed.Zswap', 128: 'Malformed.BuiltinDecode',
  129: 'Malformed.GuaranteedLimit', 130: 'Malformed.MergingContracts',
  131: 'Malformed.CantMergeTypes', 132: 'Malformed.ClaimOverflow',
  133: 'Malformed.ClaimCoinMismatch', 134: 'Malformed.KeyNotInCommittee',
  135: 'Malformed.InvalidCommitteeSignature', 136: 'Malformed.ThresholdMissed',
  137: 'Malformed.TooManyZswapEntries', 138: 'Malformed.BalanceCheckOverspend',
  139: 'Malformed.UnknownError', 150: 'LedgerCacheError', 151: 'NoLedgerState',
  152: 'LedgerStateScaleDecodingError', 153: 'ContractCallCostError',
  154: 'BlockLimitExceededError', 155: 'FeeCalculationError', 165: 'GetTransactionContextError',
  166: 'Malformed.InvalidNetworkId', 167: 'Malformed.IllegallyDeclaredGuaranteed',
  168: 'Malformed.FeeCalculation', 169: 'Malformed.InvalidDustRegistrationSignature',
  170: 'Malformed.InvalidDustSpendProof', 171: 'Malformed.OutOfDustValidityWindow',
  172: 'Malformed.MultipleDustRegistrationsForKey',
  173: 'Malformed.InsufficientDustForRegistrationFee', 174: 'Malformed.MalformedContractDeploy',
  175: 'Malformed.IntentSignatureVerificationFailure', 176: 'Malformed.IntentSignatureKeyMismatch',
  177: 'Malformed.IntentSegmentIdCollision', 178: 'Malformed.IntentAtGuaranteedSegmentId',
  179: 'Malformed.UnsupportedProofVersion', 180: 'Malformed.GuaranteedTranscriptVersion',
  181: 'Malformed.FallibleTranscriptVersion', 182: 'Malformed.TransactionApplicationError',
  183: 'Malformed.BalanceCheckOutOfBounds', 184: 'Malformed.BalanceCheckConversionFailure',
  185: 'Malformed.PedersenCheckFailure', 186: 'Malformed.EffectsCheckFailure',
  187: 'Malformed.DisjointCheckFailure', 188: 'Malformed.SequencingCheckFailure',
  189: 'Malformed.InputsNotSorted', 190: 'Malformed.OutputsNotSorted',
  191: 'Malformed.DuplicateInputs', 192: 'Malformed.InputsSignaturesLengthMismatch',
  193: 'Invalid.ReplayProtectionViolation', 194: 'Invalid.BalanceCheckOutOfBounds',
  195: 'Invalid.InputNotInUtxos', 196: 'Invalid.DustDoubleSpend',
  197: 'Invalid.DustDeregistrationNotRegistered', 198: 'Invalid.GenerationInfoAlreadyPresent',
  199: 'Invalid.InvariantViolation', 200: 'Invalid.RewardTooSmall',
  201: 'SystemTransaction.IllegalPayout', 202: 'SystemTransaction.InsufficientTreasuryFunds',
  203: 'SystemTransaction.CommitmentAlreadyPresent', 204: 'SystemTransaction.UnknownError',
  205: 'SystemTransaction.ReplayProtectionFailure',
  206: 'SystemTransaction.IllegalReserveDistribution',
  207: 'SystemTransaction.GenerationInfoAlreadyPresent',
  208: 'SystemTransaction.InvalidBasisPoints', 209: 'SystemTransaction.InvariantViolation',
  210: 'SystemTransaction.TreasuryDisabled', 211: 'SystemTransaction.MerkleTreeError',
  255: 'HostApiError'
};
const NODE_2_X = {
  0: 'Deserialization.NetworkId', 1: 'Deserialization.Transaction',
  2: 'Deserialization.DeserializationLedgerState',
  3: 'Deserialization.DeserializationContractAddress', 4: 'Deserialization.PublicKey',
  5: 'Deserialization.VersionedArenaKey', 6: 'Deserialization.UserAddress',
  7: 'Deserialization.TypedArenaKey', 8: 'Deserialization.SystemTransaction',
  9: 'Deserialization.DustPublicKey', 10: 'Deserialization.CNightGeneratesDustActionType',
  11: 'Deserialization.CNightGeneratesDustEvent', 50: 'Serialization.TransactionIdentifier',
  51: 'Serialization.SerializationLedgerState', 52: 'Serialization.LedgerParameters',
  53: 'Serialization.SerializationContractAddress', 54: 'Serialization.ContractState',
  55: 'Serialization.ContractStateToJson', 56: 'Serialization.ZswapState',
  57: 'Serialization.UnknownType', 58: 'Serialization.MerkleTreeDigest',
  59: 'Serialization.VersionedArenaKey', 60: 'Serialization.TypedArenaKey',
  61: 'Serialization.CNightGeneratesDustEvent', 62: 'Serialization.SystemTransaction',
  63: 'Serialization.ArenaHash', 100: 'Invalid.EffectsMismatch',
  101: 'Invalid.ContractAlreadyDeployed', 102: 'Invalid.ContractNotPresent',
  103: 'Invalid.Zswap.Unknown', 104: 'Invalid.Transcript', 105: 'Invalid.InsufficientClaimable',
  106: 'Invalid.VerifierKeyNotFound', 107: 'Invalid.VerifierKeyAlreadyPresent',
  108: 'Invalid.ReplayCounterMismatch', 109: 'Invalid.UnknownError',
  110: 'Malformed.VerifierKeyNotSet', 111: 'Malformed.TransactionTooLarge',
  112: 'Malformed.VerifierKeyTooLarge', 113: 'Malformed.VerifierKeyNotPresent',
  114: 'Malformed.ContractNotPresent', 115: 'Malformed.InvalidProof',
  116: 'Malformed.BindingCommitmentOpeningInvalid', 117: 'Malformed.NotNormalized',
  118: 'Malformed.FallibleWithoutCheckpoint', 119: 'Malformed.ClaimReceiveFailed',
  120: 'Malformed.ClaimSpendFailed', 121: 'Malformed.ClaimNullifierFailed',
  122: 'Malformed.ClaimCallFailed', 123: 'Malformed.InvalidSchnorrProof',
  124: 'Malformed.UnclaimedCoinCom', 125: 'Malformed.UnclaimedNullifier',
  126: 'Malformed.Unbalanced', 127: 'Malformed.Zswap.Unknown', 128: 'Malformed.BuiltinDecode',
  129: 'Malformed.GuaranteedLimit', 130: 'Malformed.MergingContracts',
  131: 'Malformed.CantMergeTypes', 132: 'Malformed.ClaimOverflow',
  133: 'Malformed.ClaimCoinMismatch', 134: 'Malformed.KeyNotInCommittee',
  135: 'Malformed.InvalidCommitteeSignature', 136: 'Malformed.ThresholdMissed',
  137: 'Malformed.TooManyZswapEntries', 138: 'Malformed.BalanceCheckOverspend',
  139: 'Malformed.UnknownError', 140: 'SystemTransaction.NotAllowedForCaller',
  150: 'LedgerCacheError', 151: 'NoLedgerState', 152: 'LedgerStateScaleDecodingError',
  153: 'ContractCallCostError', 154: 'BlockLimitExceededError', 155: 'FeeCalculationError',
  156: 'ContractNotPresent', 157: 'BeneficiaryNotFound', 165: 'GetTransactionContextError',
  166: 'Malformed.InvalidNetworkId', 167: 'Malformed.IllegallyDeclaredGuaranteed',
  169: 'Malformed.InvalidDustRegistrationSignature', 170: 'Malformed.InvalidDustSpendProof',
  171: 'Malformed.OutOfDustValidityWindow', 172: 'Malformed.MultipleDustRegistrationsForKey',
  173: 'Malformed.InsufficientDustForRegistrationFee',
  174: 'Malformed.MalformedContractDeploy.Unknown',
  175: 'Malformed.IntentSignatureVerificationFailure', 176: 'Malformed.IntentSignatureKeyMismatch',
  177: 'Malformed.IntentSegmentIdCollision', 178: 'Malformed.IntentAtGuaranteedSegmentId',
  179: 'Malformed.UnsupportedProofVersion', 180: 'Malformed.GuaranteedTranscriptVersion',
  181: 'Malformed.FallibleTranscriptVersion', 183: 'Malformed.BalanceCheckOutOfBounds',
  184: 'Malformed.BalanceCheckConversionFailure', 185: 'Malformed.PedersenCheckFailure',
  189: 'Malformed.InputsNotSorted', 190: 'Malformed.OutputsNotSorted',
  191: 'Malformed.DuplicateInputs', 192: 'Malformed.InputsSignaturesLengthMismatch',
  194: 'Invalid.BalanceCheckOutOfBounds', 195: 'Invalid.InputNotInUtxos',
  196: 'Invalid.DustDoubleSpend', 197: 'Invalid.DustDeregistrationNotRegistered',
  198: 'Invalid.GenerationInfoAlreadyPresent', 199: 'Invalid.InvariantViolation',
  200: 'Invalid.RewardTooSmall', 201: 'SystemTransaction.IllegalPayout',
  202: 'SystemTransaction.InsufficientTreasuryFunds',
  203: 'SystemTransaction.CommitmentAlreadyPresent', 204: 'SystemTransaction.UnknownError',
  206: 'SystemTransaction.IllegalReserveDistribution',
  207: 'SystemTransaction.GenerationInfoAlreadyPresent',
  208: 'SystemTransaction.InvalidBasisPoints', 209: 'SystemTransaction.InvariantViolation',
  210: 'SystemTransaction.TreasuryDisabled', 211: 'SystemTransaction.MerkleTreeError',
  212: 'Malformed.EffectsCheck.RealCallsSubsetCheckFailure',
  213: 'Malformed.EffectsCheck.AllCommitmentsSubsetCheckFailure',
  214: 'Malformed.EffectsCheck.RealUnshieldedSpendsSubsetCheckFailure',
  215: 'Malformed.EffectsCheck.ClaimedUnshieldedSpendsUniquenessFailure',
  216: 'Malformed.EffectsCheck.ClaimedCallsUniquenessFailure',
  217: 'Malformed.EffectsCheck.NullifiersNeqClaimedNullifiers',
  218: 'Malformed.EffectsCheck.CommitmentsNeqClaimedShieldedReceives',
  219: 'Malformed.SequencingCheck.CallSequencingViolation',
  220: 'Malformed.SequencingCheck.SequencingCorrelationViolation',
  221: 'Malformed.SequencingCheck.GuaranteedInFallibleContextViolation',
  222: 'Malformed.SequencingCheck.FallibleInGuaranteedContextViolation',
  223: 'Malformed.SequencingCheck.CausalityConstraintViolation',
  224: 'Malformed.SequencingCheck.CallHasEmptyTranscripts',
  225: 'Malformed.DisjointCheck.ShieldedInputsDisjointFailure',
  226: 'Malformed.DisjointCheck.ShieldedOutputsDisjointFailure',
  227: 'Malformed.DisjointCheck.UnshieldedInputsDisjointFailure',
  228: 'Malformed.TransactionApplication.IntentTtlExpired',
  229: 'Malformed.TransactionApplication.IntentTtlTooFarInFuture',
  230: 'Malformed.TransactionApplication.IntentAlreadyExists',
  231: 'Malformed.FeeCalculation.OutsideTimeToDismiss',
  232: 'Malformed.FeeCalculation.BlockLimitExceeded',
  233: 'Malformed.MalformedContractDeploy.NonZeroBalance',
  234: 'Malformed.MalformedContractDeploy.IncorrectChargedState',
  235: 'Malformed.Zswap.InvalidProof', 236: 'Malformed.Zswap.ContractSentCiphertext',
  237: 'Malformed.Zswap.NonDisjointCoinMerge', 238: 'Malformed.Zswap.NotNormalized',
  239: 'Invalid.Zswap.NullifierAlreadyPresent', 240: 'Invalid.Zswap.CommitmentAlreadyPresent',
  241: 'Invalid.Zswap.UnknownMerkleRoot',
  242: 'Invalid.ReplayProtectionViolation.IntentTtlExpired',
  243: 'Invalid.ReplayProtectionViolation.IntentTtlTooFarInFuture',
  244: 'Invalid.ReplayProtectionViolation.IntentAlreadyExists',
  245: 'SystemTransaction.ReplayProtectionFailure.IntentTtlExpired',
  246: 'SystemTransaction.ReplayProtectionFailure.IntentTtlTooFarInFuture',
  247: 'SystemTransaction.ReplayProtectionFailure.IntentAlreadyExists',
  248: 'Invalid.DivideByZero', 249: 'Invalid.MerkleTreeError',
  250: 'Invalid.Zswap.MerkleTreeError', 255: 'HostApiError'
};

// The source imports four variants under aliases (`LedgerState as DeserializationLedgerState`);
// show the variants' real names.
for (const t of [NODE_1_0, NODE_2_X]) {
  for (const [c, n] of Object.entries(t)) {
    t[c] = n.replace(/^(Deserialization|Serialization)\.(?:Deserialization|Serialization)(LedgerState|ContractAddress)$/, '$1.$2');
  }
}

// What the node prints for the errors that aren't `Transaction(…)`: generated from
// `impl core::fmt::Display for LedgerApiError` in the same two files.
const DISPLAY_1_0 = {
  "Error deserializing: NetworkId": 0,
  "Error deserializing: Transaction": 1,
  "Error deserializing: LedgerState": 2,
  "Error deserializing: Address": 3,
  "Error deserializing: PublicKey": 4,
  "Error deserializing: VersionedArenaKey": 5,
  "Error deserializing: UserAddress": 6,
  "Error deserializing: TypedArenaKey": 7,
  "Error deserializing: SystemTransaction": 8,
  "Error deserializing: DustPublicKey": 9,
  "Error deserializing: CNightGeneratesDustActionType": 10,
  "Error deserializing: CNightGeneratesDustEvent": 11,
  "Error serializing: TransactionIdentifier": 50,
  "Error serializing: LedgerState": 51,
  "Error serializing: LedgerParameters": 52,
  "Error serializing: Address": 53,
  "Error serializing: ContractState": 54,
  "Error serializing: ContractStateToJson": 55,
  "Error serializing: ZswapState": 56,
  "Error serializing: UnknownType": 57,
  "Error serializing: MerkleTreeDigest": 58,
  "Error serializing: VersionedArenaKey": 59,
  "Error serializing: TypedArenaKey": 60,
  "Error serializing: CNightGeneratesDustEvent": 61,
  "Error serializing: SystemTransaction": 62,
  "Error serializing: ArenaHash": 63,
  "Error with Ledger Cache: poisoned lock": 150,
  "Error, LedgerState is not present": 151,
  "Error, it was not possible to SCALE decode the Ledger State": 152,
  "Error, it was not possible calculate the cost of a Contract Call": 153,
  "Error, exceeded block limit during post-block update declaration": 154,
  "Error, exceeded block limit during transaction application": 155,
  "Error while getting transaction context": 165,
  "Error while processing the transaction in the host API": 255,
};
const DISPLAY_2_X = {
  ...DISPLAY_1_0,
  "Error, contract is not present": 156,
  "Error, beneficiary is not found": 157,
};

const TABLES = {
  '1.0': { table: NODE_1_0, display: DISPLAY_1_0, label: 'node 1.0.x', range: '1.0.0 to 1.0.400' },
  '2.x': { table: NODE_2_X, display: DISPLAY_2_X, label: 'node 2.x', range: '2.0.0-rc.4 to 2.1.0-rc.4, and main on 2026-11-06; ledger 8 and ledger 9 alike' },
};

// Node 1.0.x codes that node 2.x split into finer ones (same source as the tables).
const SPLIT = {
  103: [239, 240, 241, 250], 127: [235, 236, 237, 238], 168: [231, 232], 174: [233, 234],
  182: [228, 229, 230], 186: [212, 213, 214, 215, 216, 217, 218], 187: [225, 226, 227],
  188: [219, 220, 221, 222, 223, 224], 193: [242, 243, 244], 205: [245, 246, 247],
};
const SPLIT_FROM = Object.fromEntries(Object.entries(SPLIT).flatMap(([old, news]) => news.map((n) => [n, Number(old)])));

const CATEGORY = {
  Deserialization: 'the node could not decode part of the transaction it was sent.',
  Serialization: 'the node failed to serialize a value while validating the transaction.',
  Invalid: 'the transaction is well-formed but conflicts with the ledger state it was checked against.',
  Malformed: "the transaction failed the ledger's well-formedness checks (structure, proofs, signatures, balance, TTL, fees).",
  SystemTransaction: "a system transaction error. DApps and wallets don't send system transactions; check the node log.",
  node: "the node's ledger API failed while validating, outside the ledger's own checks. The node log has the details.",
};

// What the codes people actually hit mean in practice, and what to do. Only codes with a
// reproduction or a worked servicedesk case are here; the rest get their name and category.
const TTL_FIX =
  "Fix: build the transaction again with a TTL a little in the future (now + 30 minutes was accepted on node 1.0.400), and don't submit a transaction built long ago.";
const TTL_182 = `Intent TTL expired, TTL too far in the future, or intent already exists. The node log says which and gives the times ("Intent TTL has expired. TTL: …, Current block: …" or "Intent TTL is too far in the future. TTL: …, Maximum allowed: …"). Reproduced on node 1.0.400 with a TTL 5 minutes in the past and one 30 days ahead. On a public network you won't see the node log: compare the ttl you passed with when you submitted. ${TTL_FIX}`;
const REPLAY_193 =
  'Replay protection, checked against ledger state; it covers an expired TTL, a TTL too far ahead and an intent that is already on chain. Reproduced on node 1.0.400 by submitting a transaction again after it was included (node log: "guaranteed execution would fail: ReplayProtectionViolation(IntentAlreadyExists)"). The common cause is a retry that resubmits a transaction that already landed: check whether the first one is on chain before retrying, and build a new transaction for a real retry.';
const DUST_FIX =
  'Fix: one wallet instance per seed (one instance built and submitted two transfers back to back without a conflict); with several processes, send every submission through the one that holds the wallet.';
const DUST_196 = `The DUST that pays the fee is already spent on chain. Reproduced on node 1.0.400 with two wallet instances on one seed: the second transaction got 196 once the first was in a block. ${DUST_FIX}`;
const DUST_170 =
  "The DUST spend proof that pays the fee did not verify. The ledger's own text: \"this is just as likely a disagreement on dust state on the declared time as the proof being invalid\". Let the wallet finish syncing and build again. If every transaction on the network gets 170, faucet included, the problem is on the network's side, not in the DApp (servicedesk#150, stagenet: an indexer bug). In servicedesk#52 a client on ledger-v8 8.0.3 got 170 on preprod while 8.1.0 deployed; the cause wasn't established.";
const BALANCE_194 =
  'A contract call pays out more of a token than the contract holds: the ledger subtracts each payout from the contract\'s balance and rejects the transaction if it would go below zero. Reproduced on node 1.0.0 and 1.0.400 with a circuit that sends NIGHT from a contract that holds none. On Mainnet, wallets have no NIGHT on Midnight to pay into a contract, so every circuit that sends NIGHT gets this: see the contract-native-night-mainnet runbook.';
const DISMISS_TEXT = '"exceeded the maximum time to dismiss for transaction size"';
const BLOCK_TEXT = '"exceeded block limit in transaction fee computation"';
const HINTS = {
  '1.0': {
    168: `Fee check. On node 1.0.x this one code covers two ledger errors, and the node log says which: ${DISMISS_TEXT} (the transaction would take longer to validate than its size allows; servicedesk#100, where a third intent the SDK added tipped a swap over) or ${BLOCK_TEXT} (too big for one block; for a contract deploy, see the contract-batched-deploy runbook).`,
    170: DUST_170,
    182: TTL_182,
    186: "The transaction's effects don't match what its contract calls claim. servicedesk#37: midnight-js 4.0.4 put the offer for a fallible claim in the guaranteed section; midnight-js 4.1.1 fixed it.",
    193: REPLAY_193,
    194: BALANCE_194,
    196: DUST_196,
  },
  '2.x': {
    104: "On ledger 9 (mainnet and preview), midnight-ledger#839 (open): a contract call that spends a held shielded coin and writes the change back with writeCoin can be rejected with 104 once the chain's commitment tree isn't empty. The node measures more bytes_written than the client declared, so the call runs out of its gas budget. Nothing in the call is wrong; it waits on a ledger fix.",
    170: DUST_170,
    194: BALANCE_194,
    196: DUST_196,
    228: `Intent TTL expired. On node 1.0.x this was 182, reproduced there with a TTL 5 minutes in the past. ${TTL_FIX}`,
    229: `Intent TTL too far in the future. On node 1.0.x this was 182, reproduced there with a TTL 30 days ahead. ${TTL_FIX}`,
    230: 'Intent already exists. On node 1.0.x this was 182.',
    231: `Node log: ${DISMISS_TEXT}. The transaction would take longer to validate than its size allows. servicedesk#117 (node 2.0.0-rc.4): contract calls that use unshielded-token effects. On node 1.0.x this was 168 (servicedesk#100, a swap that gained a third intent). On ledger 9 (mainnet and preview), midnight-ledger#838 (open): a moderately expensive contract call (about 10 ms to apply) paid with exactly one DUST spend can fail this check because the client overestimates the transaction's size; pay with two or more DUST spends.`,
    232: `Node log: ${BLOCK_TEXT}. Too big for one block; for a contract deploy, see the contract-batched-deploy runbook. On node 1.0.x this was 168.`,
    242: `Replay protection, checked against ledger state: intent TTL expired (the well-formedness check, 228, usually catches this first). On node 1.0.x this was 193. ${TTL_FIX}`,
    243: `Replay protection, checked against ledger state: intent TTL too far in the future (the well-formedness check, 229, usually catches this first). On node 1.0.x this was 193. ${TTL_FIX}`,
    244: 'Replay protection, checked against ledger state: this intent is already on chain. On node 1.0.x this was 193, reproduced there by submitting a transaction again after it was included. Check whether the first one is on chain before retrying, and build a new transaction for a real retry.',
  },
};

// Substrate transaction pool errors (polkadot-sdk polkadot-stable2603,
// substrate/client/rpc-api/src/author/error.rs). The RPC message for each is quoted.
const POOL = {
  1001: ['Extrinsic has invalid format', 'The node could not decode the extrinsic at all.'],
  1002: ['Verification Error', 'The extrinsic failed verification before it reached the pool.'],
  1010: ['Invalid Transaction', 'The node rejected the transaction.'],
  1011: ['Unknown Transaction Validity', "The node couldn't decide whether the transaction is valid; the data field has the reason."],
  1012: ['Transaction is temporarily banned', 'The pool refuses this exact transaction for now. Build a new transaction instead of resubmitting the same one.'],
  1013: ['Transaction Already Imported', 'This exact transaction is already in the pool. Wait for it instead of resubmitting.'],
  1014: ['Priority is too low', 'Another transaction already in the pool takes precedence over this one.'],
  1015: ['Cycle Detected', 'The pool found a dependency cycle between transactions.'],
  1016: ['Immediately Dropped', "The transaction couldn't enter the pool because of the pool's limit. Retry later."],
  1018: ['Unactionable', 'The transaction is not propagable and the node does not author blocks.'],
  1019: ['No tags provided', "The transaction provides no tags, so the pool can't identify it."],
  1020: ['The provided block ID is not valid', 'The block the transaction refers to is not valid.'],
  1021: ['The pool is not accepting future transactions', 'The pool does not accept transactions that are not valid yet.'],
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const POOL_RE = new RegExp(`\\b(10[0-2]\\d): (${Object.values(POOL).map(([m]) => esc(m)).join('|')})(?::[ \\t]*([^\\n]*))?`, 'g');
const CUSTOM_RE = /Custom error: (\d{1,6})(?![\dxX])/g;

// Rejections the wallet SDK reports without any node code (wallet-sdk-node-client 1.1.3,
// PolkadotNodeClient.js): the node took the transaction and later reported it invalid, dropped or
// replaced, or the connection closed first.
const NO_CODE = [
  [
    /Transaction is invalid and was rejected by the node/,
    `TransactionInvalidError: the node accepted the transaction into its pool and rejected it later, so no code reaches the client. Reproduced on node 1.0.400 with two wallet instances on one seed spending the same DUST while the first transaction was still pending: the node log said "Rejecting transaction … at pre-dispatch: guaranteed execution would fail: DustDoubleSpend(…)". If you run the node, its log has the reason. ${DUST_FIX}`,
  ],
  [/Transaction got dropped, the mempool likely is full/, 'TransactionDroppedError: the node dropped the transaction from its pool. Retry later.'],
  [/Transaction got usurped/, 'TransactionUsurpedError: another transaction replaced this one in the pool.'],
  [
    /(?:submitAndWatchExtrinsic\([^)]*\): ExtrinsicStatus:: |\[cause\]: Error: )disconnected from wss?:\/\/\S+: 1000:: Normal Closure/,
    'The connection to the node closed before it answered, so there is no node verdict. Seen once, resubmitting straight after a rejection; the node never logged the second submission. Retry after a few seconds.',
  ],
];
const WRAPPER_RE = /Transaction submission (error|failed)|SubmissionError|Unexpected error submitting scoped transaction/;

// Node log lines (node 1.0.400 ledger/src/versions/common/mod.rs). Mempool validation prints the
// node's error (`Transaction Error: Malformed(TransactionApplicationError)`, or a text such as
// "Error while getting transaction context"); a failed dry run and the pre-dispatch check at block
// authoring print the ledger's TransactionInvalid ("guaranteed execution would fail: …").
const NODE_LOG_RE =
  /(?:Rejected transaction (?:0x)?([0-9a-fA-F]{8,}) from mempool|Rejecting transaction (?:0x)?([0-9a-fA-F]{8,}) at pre-dispatch): ([^\n]*)/g;
const DETAIL_RE = /Transaction malformed: ([^\n]*?)\s*$/gm;

// ---------- arguments ----------
const args = process.argv.slice(2);
let nodeOpt;
let rpcOpt;
const inputs = [];
let endOfOptions = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!endOfOptions && (a === '-h' || a === '--help')) {
    console.log(USAGE);
    process.exit(0);
  } else if (!endOfOptions && a === '--') {
    endOfOptions = true;
  } else if (!endOfOptions && (a === '--node' || a === '--rpc')) {
    const v = args[++i];
    if (!v || v.startsWith('-')) fail(`${a} needs a value\n${USAGE}`);
    if (a === '--node') nodeOpt = v;
    else rpcOpt = v;
  } else if (!endOfOptions && a !== '-' && /^-[^\d\s]/.test(a)) {
    fail(`unknown option ${a}\n${USAGE}`);
  } else {
    inputs.push(a);
  }
}
if (nodeOpt && rpcOpt) fail('use --node or --rpc, not both');
if (nodeOpt && !TABLES[nodeOpt]) fail(`--node must be one of: ${Object.keys(TABLES).join(', ')}`);

async function systemVersion(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`--rpc is not a URL: ${raw}`);
  }
  // The wallet talks to the node over a websocket; system_version is asked over HTTP.
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`--rpc must be an http(s) or ws(s) URL: ${raw}`);
  const blockfrost = u.hostname === 'blockfrost.io' || u.hostname.endsWith('.blockfrost.io');
  const hadKey = u.searchParams.has('project_id');
  if (KEY && blockfrost && !hadKey) u.searchParams.set('project_id', KEY);
  let res;
  try {
    res = await fetch(u.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_version', params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    fail(`could not reach ${raw}: ${e.cause?.code ?? e.cause?.message ?? e.message}`);
  }
  if (!res.ok) {
    const why = !blockfrost
      ? ''
      : KEY || hadKey
        ? ' (Blockfrost rejected the project token; tokens are per network)'
        : ' (Blockfrost needs BLOCKFROST_PROJECT_ID)';
    fail(`${raw}: HTTP ${res.status}${res.status === 403 ? why : ''}`);
  }
  const body = await res.json().catch(() => undefined);
  const ver = body?.result;
  if (typeof ver !== 'string' || !/^[\w.+-]{1,64}$/.test(ver)) fail(`${raw}: not a system_version response`);
  return ver;
}

function decodeText(buf) {
  let s;
  if (buf[0] === 0xff && buf[1] === 0xfe) s = buf.subarray(2).toString('utf16le');
  else s = buf.toString('utf8').replace(/^﻿/, '');
  // Colour codes from pretty loggers sit right against the text we look for.
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return decodeText(Buffer.concat(chunks));
}

function stdinIsData() {
  try {
    const st = fs.fstatSync(0);
    return st.isFIFO() || st.isFile();
  } catch {
    return false;
  }
}

// ---------- decoding ----------
const otherKey = (k) => (k === '1.0' ? '2.x' : '1.0');
const list = (xs) => (xs.length === 1 ? `${xs[0]}` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
// Wrap at 100 columns. Indented lines keep their indent; a heading's continuation is indented
// so it doesn't look like a new heading.
const wrap = (line, width = 100) => {
  const indent = line.match(/^\s*/)[0];
  const next = indent || '    ';
  const words = line.trim().split(/\s+/);
  const lines = [];
  let cur = indent;
  for (const w of words) {
    if (cur.trim() && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = `${next}${w}`;
    } else cur = cur.trim() ? `${cur} ${w}` : `${indent}${w}`;
  }
  lines.push(cur);
  return lines.join('\n');
};

// → { lines, ok } where ok means the code was identified (on this table, or on the other one).
function decodeCustom(code, key) {
  const { table } = TABLES[key];
  const other = TABLES[otherKey(key)];
  const name = table[code];
  if (!name) {
    const lines = [`Custom error: ${code}  →  not a code on ${TABLES[key].label}.`];
    if (!other.table[code]) {
      lines.push('  Not on any node version this script knows either. Decode it against the source of the node that rejected it.');
      return { lines, ok: false };
    }
    const was = key === '1.0' && SPLIT_FROM[code] !== undefined ? ` On ${TABLES[key].label} the same failure is ${SPLIT_FROM[code]} (${table[SPLIT_FROM[code]]}).` : '';
    const now = key === '2.x' && SPLIT[code] ? ` On ${TABLES[key].label} the same failures are ${list(SPLIT[code])}.` : '';
    lines.push(`  On ${other.label} it is ${other.table[code]}.${was}${now} Check which node rejected the transaction (--rpc).`);
    return { lines, ok: true };
  }
  const head = name.includes('.') ? name.split('.')[0] : 'node';
  const lines = [`Custom error: ${code}  →  ${name}`];
  lines.push(`  ${head === 'node' ? 'Node' : head}: ${CATEGORY[head] ?? CATEGORY.node}`);
  const hint = HINTS[key][code];
  if (hint) lines.push(`  ${hint}`);
  const there = other.table[code];
  if (there !== name) {
    let pointer = '';
    if (key === '1.0' && SPLIT[code]) pointer = ` The same failures are ${list(SPLIT[code])} there.`;
    if (key === '2.x' && SPLIT_FROM[code] !== undefined) pointer = ` The same failure is ${SPLIT_FROM[code]} (${other.table[SPLIT_FROM[code]]}) there.`;
    lines.push(`  On ${other.label}: ${there ? `${code} is ${there}` : `${code} is not used`}.${pointer}`);
  }
  return { lines, ok: true };
}

// "Malformed(TransactionApplicationError)" → the code with that name, falling back to the longest
// known prefix (payloads such as "DustDoubleSpend(DustNullifier(…))"). A variant the node has no
// code for is reported as its catch-all (`Invalid.UnknownError` 109 on node 1.0.x, per
// ledger/src/versions/common/conversions.rs; `….Unknown` on node 2.x).
function codeForVariant(variant, key, catchAll = false) {
  const parts = (variant.match(/[A-Za-z]+/g) ?? []).slice(0, 8);
  const byName = new Map(Object.entries(TABLES[key].table).map(([c, n]) => [n, Number(c)]));
  for (let n = parts.length; n > 1; n--) {
    const code = byName.get(parts.slice(0, n).join('.'));
    if (code !== undefined) return { code };
  }
  for (let n = parts.length - 1; catchAll && n > 0; n--) {
    for (const tail of ['Unknown', 'UnknownError']) {
      const code = byName.get(`${parts.slice(0, n).join('.')}.${tail}`);
      if (code !== undefined) return { code, catchAll: true };
    }
  }
  return {};
}

// One normaliser for the pool error's data, used for both grouping and display.
const normData = (d) =>
  String(d ?? '')
    .replace(/\s*:?\s*\(FiberFailure\)[\s\S]*$/, '')
    .replace(/\\?"\s*,\s*\\?"\w+\\?"\s*:[\s\S]*$/, '')
    .replace(/["'\s}\]\\]+$/, '')
    .trim();

// JSON-RPC errors in any key order, also when the JSON sits escaped inside another JSON log line.
const JSON_STR = {
  message: /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/,
  data: /"data"\s*:\s*"((?:[^"\\]|\\.)*)"/,
};
function* jsonPoolErrors(text) {
  for (const t of [text, text.replace(/\\"/g, '"')]) {
    for (const m of t.matchAll(/"code"\s*:\s*(10[0-2]\d)\b/g)) {
      const start = t.lastIndexOf('{', m.index);
      const end = t.indexOf('}', m.index);
      if (start < 0 || end < 0) continue;
      const obj = t.slice(start, end + 1);
      const str = (k) => {
        const s = JSON_STR[k].exec(obj)?.[1];
        if (s === undefined) return undefined;
        try {
          return JSON.parse(`"${s}"`);
        } catch {
          return s;
        }
      };
      yield [Number(m[1]), str('message') ?? '', str('data') ?? ''];
    }
  }
}

function poolBlock(code, message, reason) {
  const lines = [`${code}: ${message}${reason ? `: ${reason}` : ''}`];
  if (code === 1010 && !reason) {
    lines.push('  1010 is the envelope: the node rejected the transaction. The number after "Custom error:" says why; pass that, or the whole error text.');
  } else if (code === 1010) {
    lines.push(
      /exhaust the block limits/.test(reason)
        ? '  Too big for one block. For a contract deploy, see the contract-batched-deploy runbook (servicedesk#225).'
        : '  A Substrate check rejected the transaction before the Midnight ledger checked it; the text after the colon is the reason.',
    );
  } else {
    lines.push(`  ${POOL[code][1]}`);
  }
  return lines;
}

async function main() {
  // Collect the text to scan.
  const texts = [];
  const codes = [];
  let wantStdin = false;
  for (const inp of inputs) {
    if (inp === '-') {
      wantStdin = true;
      continue;
    }
    if (/^\d+$/.test(inp)) {
      codes.push(inp); // a bare number is a code; write ./182 for a file named 182
      continue;
    }
    let st;
    try {
      st = fs.statSync(inp);
    } catch {}
    if (st?.isDirectory()) fail(`${inp} is a directory; pass a file`);
    if (st) {
      try {
        texts.push(decodeText(fs.readFileSync(inp)));
      } catch (e) {
        fail(`could not read ${inp}: ${e.message}`);
      }
    } else if (!/\s/.test(inp) && (/[\\/]/.test(inp) || /\.(log|txt|json|out|err)$/i.test(inp))) {
      fail(`no such file: ${inp}`);
    } else {
      texts.push(decodeText(Buffer.from(inp)));
    }
  }
  if (!inputs.length) {
    if (process.stdin.isTTY) fail(USAGE);
    wantStdin = true;
  } else if (!wantStdin && stdinIsData()) {
    console.error('note: stdin is ignored because arguments were given; add - to read it too.');
  }
  if (wantStdin) texts.push(await readStdin());
  const text = texts.join('\n');

  // Which table.
  let key = nodeOpt ?? '1.0';
  const header = [];
  if (rpcOpt) {
    const ver = await systemVersion(rpcOpt);
    const m = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
    const [maj, min, patch] = m ? m.slice(1).map(Number) : [];
    if (maj === 1 && min === 0) key = '1.0';
    else if (maj === 2 && (min === 0 || min === 1)) key = '2.x';
    else fail(`${rpcOpt} runs node ${ver}; this script has no code table for it. Decode against that node's ledger/src/**/types.rs.`);
    header.push(`Code table: ${TABLES[key].label} (${TABLES[key].range}). ${rpcOpt} runs ${ver}.`);
    if (key === '1.0' && patch > 400) header.push(`  Caution: ${ver} is newer than 1.0.400, the last 1.0.x release this table was checked against.`);
    if (key === '2.x' && !/^2\.1\.0-rc\.4\b/.test(ver)) {
      header.push(`  Caution: the 2.x table is node-2.1.0-rc.4's, unchanged on main on 2026-11-06 (2.0.0-rc.x lacks only 140); ${ver}'s own source wasn't checked.`);
    }
  } else if (nodeOpt) {
    header.push(`Code table: ${TABLES[key].label} (${TABLES[key].range}), from --node ${key}.`);
  } else {
    header.push(`Code table: ${TABLES[key].label} (${TABLES[key].range}). On 2026-11-07 preprod ran node 1.0.400 (this table); mainnet and preview ran 2.1.101 (--node 2.x).`);
    header.push('  Check the node that rejected the transaction with --rpc <url>, or pass --node 2.x.');
  }

  const custom = new Set();
  const pool = new Map(); // "code|message|reason" → [code, message, reason]
  for (const c of codes) {
    const n = c.length <= 6 ? Number(c) : NaN;
    if (n <= 255) custom.add(n);
    else if (POOL[n]) pool.set(`${n}||`, [n, POOL[n][0], '']);
    else fail(`${c} is neither a node ledger code (0-255) nor a transaction pool code (1001-1021)`);
  }
  for (const m of text.matchAll(CUSTOM_RE)) custom.add(Number(m[1]));
  const addPool = (code, message, data) => {
    if (!POOL[code] || !message.startsWith(POOL[code][0])) return; // e.g. websocket close codes
    if (code === 1010 && /^\s*Custom error: \d+/.test(data)) return; // decoded as a ledger code
    const reason = normData(data);
    pool.set(`${code}|${message}|${reason}`, [code, message, reason]);
  };
  for (const m of text.matchAll(POOL_RE)) addPool(Number(m[1]), m[2], m[3] ?? '');
  for (const [code, message, data] of jsonPoolErrors(text)) addPool(code, message, data);

  const nodeLog = new Map(); // reason text → { hashes, preDispatch }
  for (const m of text.matchAll(NODE_LOG_RE)) {
    const reason = m[3].trim().slice(0, 300);
    const key2 = reason.replace(/\([0-9a-fA-F]{16,}\)/g, '(…)');
    if (!nodeLog.has(key2)) nodeLog.set(key2, { reason, hashes: new Set(), preDispatch: false });
    const e = nodeLog.get(key2);
    e.hashes.add((m[1] ?? m[2]).toLowerCase());
    if (m[2]) e.preDispatch = true;
  }
  const details = [...new Set([...text.matchAll(DETAIL_RE)].map((m) => m[1]))];

  const blocks = [];
  let identified = 0;
  for (const c of [...custom].sort((a, b) => a - b)) {
    if (c > 255) {
      blocks.push([`Custom error: ${c}  →  not a node ledger code: those are 0 to 255. Look for the 1010 response elsewhere in the error.`]);
      continue;
    }
    const { lines, ok } = decodeCustom(c, key);
    if (ok) identified++;
    blocks.push(lines);
  }
  for (const [code, message, reason] of pool.values()) {
    identified++;
    blocks.push(poolBlock(code, message, reason));
  }
  for (const [re, meaning] of NO_CODE) {
    const m = re.exec(text);
    if (m) {
      identified++;
      blocks.push([`No node code: "${m[0]}"`, `  ${meaning}`]);
    }
  }
  for (const { reason, hashes, preDispatch } of nodeLog.values()) {
    const where = preDispatch ? 'at pre-dispatch (block authoring)' : 'from mempool';
    const tx = hashes.size > 1 ? `${hashes.size} transactions` : `transaction ${[...hashes][0].slice(0, 12)}…`;
    let found = {};
    let shown = reason;
    const t = reason.match(/^Transaction Error: ([A-Z][A-Za-z]*(?:\([A-Z][A-Za-z]*){0,8})/);
    const g = reason.match(/^guaranteed execution would fail: ([A-Z][A-Za-z]*(?:\([A-Z][A-Za-z]*){0,8})/);
    if (t) found = codeForVariant(t[1], key);
    else if (g) found = codeForVariant(`Invalid(${g[1]}`, key, true);
    else if (TABLES[key].display[reason.replace(/\s+$/, '')] !== undefined) found = { code: TABLES[key].display[reason.replace(/\s+$/, '')] };
    const v = t?.[1] ?? (g ? `Invalid(${g[1]}` : undefined);
    if (v) shown = v + ')'.repeat((v.match(/\(/g) ?? []).length);
    if (found.code === undefined) {
      blocks.push([`Node log, rejected ${where}: ${shown}, ${tx}  →  no matching code on ${TABLES[key].label}.`]);
      continue;
    }
    identified++;
    const lines = [`Node log, rejected ${where}: ${shown}, ${tx}  →  Custom error: ${found.code}`];
    if (found.catchAll) lines.push(`  The node has no code of its own for this variant and reports it as ${found.code}.`);
    if (preDispatch) lines.push('  At pre-dispatch the client gets no code: it sees "Transaction is invalid and was rejected by the node".');
    if (!custom.has(found.code)) lines.push(...decodeCustom(found.code, key).lines.slice(1));
    blocks.push(lines);
  }
  if (details.length) blocks.push(['Node log detail:', ...details.map((d) => `  ${d}`)]);

  console.log(header.map((l) => wrap(redact(l))).join('\n'));
  if (!identified) {
    for (const b of blocks) console.log(`\n${b.map((l) => wrap(l)).join('\n')}`);
    console.log('\nNo node rejection or submission failure explained in the input.');
    if (WRAPPER_RE.test(text)) {
      console.log(
        wrap(
          "The text has the wallet SDK's wrapper but not the node's code: err.message, err.stack and JSON.stringify(err) drop it. Print String(err) or console.error(err) instead, or find the console line that starts with \"RPC-CORE: submitAndWatchExtrinsic\", and run this script on that.",
        ),
      );
    }
    process.exitCode = 2;
    return;
  }
  for (const b of blocks) console.log(`\n${b.map((l) => wrap(l)).join('\n')}`);
  process.exitCode = 0;
}

main().catch((e) => fail(`decode-1010 crashed: ${e?.stack ?? e}`));
