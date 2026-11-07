---
title: "Node rejects a transaction (1010, Custom error: N)"
when_to_use: "Submission fails with `1010: Invalid Transaction: Custom error: N`, or with only `Transaction submission error`, `submitTx rejected the transaction` or `Transaction is invalid and was rejected by the node`, and the code has to be found and decoded for the node version that rejected it."
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-07"
last_reviewed: "2026-11-07"
error_strings:
  - "1010: Invalid Transaction: Custom error:"
  - "Transaction submission error"
  - "Transaction submission failed"
  - "submitTx rejected the transaction"
  - "Transaction is invalid and was rejected by the node"
  - "Rejected transaction"
  - "Rejecting transaction"
  - "guaranteed execution would fail"
review_when:
  - "A network moves to another node version: the decoder picks its table from system_version, so a version it doesn't know needs a new table from gen-tables.mjs"
  - "midnight-ledger#838 or #839 closes: Remediation 5 and 7 change"
  - "The wallet SDK or midnight-js changes how it wraps a submission error: Symptom and Diagnose 1"
---

# Runbook: Node rejects a transaction (1010, Custom error: N)

The node rejects a transaction at submission with a number, `Custom error: N`, naming the ledger's reason. The SDKs bury it a cause or two down, and it means different things on node 1.0.x (Preprod) and 2.x (Mainnet, Preview). Find it, decode it for the node that rejected it, and match it to a fix.

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported**, **inferred** or **not tested** has none, so trust it less.

## Symptom

| If you see | Go to |
|---|---|
| `1010: Invalid Transaction: Custom error: N`, in an `RPC-CORE: submitAndWatchExtrinsic` console line, in `String(err)` or in a cause | Diagnose 2 |
| `(FiberFailure) SubmissionError: Transaction submission error` and no code in `err.message` (wallet SDK) | Diagnose 1 |
| `ProviderFailedError: submitTx rejected the transaction (circuit '…')` (midnight-js 5) | Diagnose 1 |
| `Unexpected error submitting scoped transaction '<unnamed>': …` (midnight-js 4.1.1) | Diagnose 1 |
| `TransactionInvalidError: Transaction is invalid and was rejected by the node`, with no code | Remediation 3 |
| A node log line `Rejected transaction … from mempool` or `Rejecting transaction … at pre-dispatch` | Diagnose 2 |

### Not this runbook

- **1010 with text instead of a number**, such as `Transaction would exhaust the block limits`: a Substrate check. See the [batched deploy runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/contract-batched-deploy-runbook/contract-batched-deploy-runbook.md).
- **`disconnected from … Normal Closure` and no code:** the connection closed before the node answered (reproduced after a straight resubmission). Check whether it landed (Remediation 2) before retrying.
- **194 from a circuit that moves NIGHT on Mainnet:** see the [NIGHT on Mainnet runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/contract-native-night-mainnet-runbook/contract-native-night-mainnet-runbook.md).

## Root cause

1. **The node returns a code.** It checks each submitted transaction against the ledger and turns a failure into a `u8` (`impl From<LedgerApiError> for u8`). Substrate's RPC wraps that as error 1010, `Invalid Transaction`, with data `Custom error: N`. The 1010 is Substrate's; the N is Midnight's.
2. **The SDKs hide it.** The wallet SDK wraps the RPC error twice (`Transaction submission failed`, then `Transaction submission error`) in a `FiberFailure` whose `message` is only the outer text; `String(err)` shows the chain (reproduced on wallet SDK 1.2.0). midnight-js 5 rethrows it as `ProviderFailedError`, the RPC error two causes down.
3. **The table is the node's.** Node 2.x drops seven of node 1.0.x's codes and splits three (from source; the list is in NOTES), so one failure can have two numbers. Check which node a network runs with `system_version`: `1.0.…` or `2.…`.
4. **The ledger state is checked twice:** at submission (a 1010 comes back) and when the block is built, where the client only gets `TransactionInvalidError`. Two pending spends of the same DUST both pass the first check (reproduced).

## Before you start

- **You need** the error output, Node 20 or newer, and [scripts/decode-1010.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-1010-custom-error-runbook/scripts/decode-1010.mjs), no install. For Blockfrost with `--rpc`, the user sets `export BLOCKFROST_PROJECT_ID=…` in their own shell; the script never prints it.
- **Safety.** Diagnose only reads text or asks the node its version. Reproducing a failure submits a transaction, so an agent asks the user first.

## Diagnose

1. **Get the code out.** Search the output you have for `Custom error:` or `RPC-CORE: submitAndWatchExtrinsic`: the RPC client prints the code to stderr twice per rejection, even when the DApp swallows the error (reproduced). Otherwise print the error and its causes where the submission is caught, and reproduce:

   ```ts
   for (let e: unknown = err; e instanceof Error; e = e.cause) console.log(e.message);
   console.log(String(err)); // the wallet SDK's FiberFailure renders its chain only here
   ```

   Reproducing submits a transaction, and on Mainnet it spends DUST.

   `TransactionInvalidError` has no code: Remediation 3. If you run the node, grep its log for `Rejected transaction` and `Rejecting transaction`; a ledger state failure there says `guaranteed execution would fail`.

2. **Decode it for the node that rejected it.**

   ```sh
   mkdir -p /tmp/decode-1010
   curl -fsSL -o /tmp/decode-1010/decode-1010.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/node-1010-custom-error-runbook/scripts/decode-1010.mjs
   node /tmp/decode-1010/decode-1010.mjs 'Custom error: 196' --rpc https://rpc.mainnet.midnight.network   # or rpc.preview / rpc.preprod
   node /tmp/decode-1010/decode-1010.mjs app.log --rpc <the node URL the DApp uses>
   ```

   `--rpc` picks the table from the node's `system_version` (`--node 1.0` or `--node 2.x` by hand; neither assumes 1.0.x and says so). It prints the name, category and fix for every code, pool error, code-less wallet error and node log line it finds. Exit 0: it explained one or more; 2: nothing it could explain; 1: it couldn't run.

   By hand: check `system_version`, then look 1.0.x codes up on [Node error codes](https://docs.midnight.network/nodes/error-codes) and 2.x codes in midnight-node's `ledger/src/ledger_9/types.rs`.

3. **Match it to a cause.** `Malformed` is about the transaction as built; `Invalid` is about the ledger state it met.

   | Node 1.0.x | Node 2.x | What happened | Fix |
   |---|---|---|---|
   | 182 | 228, 229 | Intent TTL expired, or too far ahead | Remediation 1 |
   | 193 | 242, 243 | The same, checked against ledger state | Remediation 1 |
   | 193 | 244 | The transaction was submitted again after it landed | Remediation 2 |
   | 196 | 196 | The DUST paying the fee is already spent on chain | Remediation 3 |
   | none | none | `TransactionInvalidError`: dropped when the block was built, e.g. the same DUST spent twice while both were pending | Remediation 3 |
   | 170 | 170 | The DUST spend proof didn't verify | Remediation 4 |
   | 168 | 231, 232 | Too slow to validate for its size, or too big for a block | Remediation 5 |
   | 186 | 212 to 218 | The effects don't match what the contract calls claim | Remediation 6 |
   | 104 | 104 | The call's on-chain program failed against the state it met | Remediation 7 |
   | 194 | 194 | A call pays out more of a token than the contract holds | [NIGHT on Mainnet](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/contract-native-night-mainnet-runbook/contract-native-night-mainnet-runbook.md), if the token is NIGHT |

   On node 1.0.x, 182 and 193 each wrap all three TTL and intent cases (reproduced: TTL as 182, a landed resubmission as 193). A 1.0.x-only code such as 182 from a 2.x network means the log came from a 1.0.x node: check `--rpc` against the node that submitted. Copies of the docs from before midnight-docs#1454 called 182 and 193 retired; node 1.0.x still uses them. Anything else: Remediation 8.

## Remediation

1 to 3 were reproduced on node 1.0.400; 4 to 7 come from worked cases and source.

1. **TTL (182, 193; 228, 229, 242, 243).** Build the transaction again and submit it promptly, with a TTL a little in the future: on node 1.0.400, now + 30 minutes was accepted, and now − 5 minutes and now + 30 days were rejected. The TTL is the `ttl` your code passes, or midnight-js's client clock + 1 hour, so a client clock that's far behind produces expired TTLs (inferred).

   *Trade-off:* a transaction that waits before submission can expire; sign close to submission.
2. **Already on chain (193; 244).** A retry resubmitted a transaction that had landed; resubmitting while it was pending was harmless. Keep the id before the first submission (`tx.identifiers().at(-1)` is what `submitTransaction` returns) and check it before retrying: with midnight-js, race `publicDataProvider.watchForTxData(txId)` against a timeout, since it never times out by itself. 244 (or 193 on 1.0.x) right after a retry of the same transaction usually means the first one went through; confirm with the stored id. `submitTransaction` took 14 to 22 s locally (measured), so a shorter retry timeout fires on healthy submissions.

   *Trade-off:* safe retries mean storing the id first.
3. **DUST already spent (196, or `TransactionInvalidError`).** Run one wallet instance per seed: two instances on one seed picked the same DUST, while one instance submitted back-to-back transfers without a conflict. With several processes, send every submission through the one that holds the wallet.

   *Trade-off:* one submitter per seed (separate seeds with their own DUST would allow more; not tested).
4. **DUST spend proof (170).** Let the wallet finish syncing and build again. If every transaction on the network gets 170, faucet included, it's the network's side (an indexer bug in `servicedesk#150`): Stop and escalate.

   *Trade-off:* none.
5. **Fee check (168; 231, 232).** 231 (168 on 1.0.x, with "maximum time to dismiss" in the node log): it would take longer to validate than its size allows. Fewer intents may help (`servicedesk#100`); the limit is a network parameter. 232 (168 with "block limit"): too big for one block; for a deploy, see the batched deploy runbook. Without the node log, treat a deploy as the block limit. On node 2.x a moderately expensive call paid with exactly one DUST spend can also hit 231, a known defect (midnight-ledger#838) with no DApp workaround yet.

   *Trade-off:* splitting a transaction gives up atomicity.
6. **Effects check (186; 212 to 218).** 186 on 1.0.x was a midnight-js 4.0.4 bug, fixed in 4.1.1 (`servicedesk#37`): use the [support matrix](https://docs.midnight.network/relnotes/support-matrix) version. 212 to 218 on 2.x have no worked case yet: Stop and escalate with the contract.

   *Trade-off:* a midnight-js upgrade moves the rest of the stack with it (see the [version mismatch runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md)).
7. **Transcript rejected (104).** The call's on-chain program failed against the state it met, usually because the contract's state changed after the call was built: build it again against the current state. On node 2.x, a call that writes a held coin's change back with `writeCoin`, with `ran out of gas budget` in the node log, is a known defect (midnight-ledger#839) with no workaround yet.

   *Trade-off:* under contention a rebuilt call can fail again.
8. **Anything else.** Read the decoder's name and category, and the code's row on [Node error codes](https://docs.midnight.network/nodes/error-codes). If that doesn't explain it, Stop and escalate.

   *Trade-off:* none.

## Confirm fixed

- The rebuilt transaction's submission resolves with an id, and no new `Custom error:` line appears.
- For 193 or 244: the stored id of the first submission is on chain.
- For 196 or `TransactionInvalidError`: consecutive submissions from one wallet instance go through.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- The decoder doesn't know the code on the node's table, or the node runs a version it has no table for.
- Every transaction on the network gets the same code, the faucet's included.
- The matched code's fix doesn't change the result, or a known defect (midnight-ledger#838, #839) blocks the DApp.
- A source in Key identifiers disagrees with its row and no step covers that.

Include the error and its causes, the decoder's output, the node's `system_version` and any node log lines around `Rejected transaction`. Remove any project id first.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). [check-runbook.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/authoring/check-runbook.mjs) tests every row daily against each source's newest version, or the npm version a row pins. For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| The node turns a ledger failure into a u8 code | `github:midnightntwrk/midnight-node/ledger/src/ledger_9/types.rs` | `impl From<LedgerApiError> for u8` |
| Node 2.x: 196, 194 and 104 | `github:midnightntwrk/midnight-node/ledger/src/ledger_9/types.rs` | `InvalidError::DustDoubleSpend => 196,` `InvalidError::BalanceCheckOutOfBounds => 194,` `InvalidError::Transcript => 104,` |
| Node 2.x: TTL and replay codes 228, 229 and 244 | `github:midnightntwrk/midnight-node/ledger/src/ledger_9/types.rs` | `TransactionApplicationErrorCode::IntentTtlExpired => 228,` `TransactionApplicationErrorCode::IntentTtlTooFarInFuture => 229,` `TransactionApplicationErrorCode::IntentAlreadyExists => 244,` |
| Node 2.x: fee codes 231 and 232, and 170 | `github:midnightntwrk/midnight-node/ledger/src/ledger_9/types.rs` | `FeeCalculationErrorCode::OutsideTimeToDismiss => 231,` `FeeCalculationErrorCode::BlockLimitExceeded => 232,` `MalformedError::InvalidDustSpendProof => 170,` |
| Every transcript rejection becomes 104 | `github:midnightntwrk/midnight-node/ledger/src/ledger_9/conversions.rs` | `Ti::Transcript(..) => Ie::Transcript,` |
| Substrate returns the code as 1010, Invalid Transaction, Custom error | `github:paritytech/polkadot-sdk/substrate/client/rpc-api/src/author/error.rs` | `"Invalid Transaction",` `format!("Custom error: {}", e)` |
| The docs' code page, the node 1.0.x reference | `github:midnightntwrk/midnight-docs/docs/nodes/error-codes.mdx` | `"data": "Custom error: 196"` |
| The wallet SDK's code-less rejection | `npm:@midnightntwrk/wallet-sdk-node-client/dist/effect/PolkadotNodeClient.js` | `Transaction is invalid and was rejected by the node` |
| midnight-js 5 wraps a failed submission | `npm:@midnight-ntwrk/midnight-js-contracts/dist/index.js` | `rejected the transaction` |
| One DUST spend can fail the time-to-dismiss check | `issue:midnightntwrk/midnight-ledger#838` | `open` |
| A coin write-back can run out of gas budget | `issue:midnightntwrk/midnight-ledger#839` | `open` |

## Reference material

- **Script:** [scripts/decode-1010.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-1010-custom-error-runbook/scripts/decode-1010.mjs) decodes against embedded node 1.0.x and 2.x tables; [scripts/gen-tables.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-1010-custom-error-runbook/scripts/gen-tables.mjs) rebuilds them from a node release.
- **Measurements and reproductions:** [scripts/decode-1010.NOTES.md](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-1010-custom-error-runbook/scripts/decode-1010.NOTES.md), including the 1.0.x table's source (midnight-node `node-1.0.400`, `ledger/src/versions/common/types.rs`, a tag the daily check can't follow) and which codes 2.x dropped or split.
- **Worked cases:** `servicedesk#37` (186), `#150` (170), `#100` (168), `#117` (231), `#225` (the hidden code).
