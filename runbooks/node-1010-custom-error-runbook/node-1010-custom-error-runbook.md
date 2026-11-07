# Runbook: Node rejects a transaction ("1010: Invalid Transaction: Custom error: N")

A transaction is built, proved and balanced, and the node turns it away at submission. Called
through the wallet SDK (or midnight-js `submitTx`), the DApp sees only `Transaction submission
error`: the node's reason, `Custom error: N`, is two causes down the error chain, where
`err.message` doesn't reach. Midnight.js contract calls do put it in `err.message`. Find the
`RPC-CORE: submitAndWatchExtrinsic` line already in your console (or print `String(err)`), decode N
with the script below, and match it to a fix. The numbers depend on the node version: node 2.x
drops or renames ten of node 1.0.x's codes. Since the ledger 9 fork, mainnet and preview run node
2.1.101 (the 2.x table) and preprod still runs 1.0.400.
Decode against the table for the node that rejected the transaction.

_Compiled 2026-10-07 from local reproductions on node 1.0.400; re-checked 2026-11-07 after the
ledger 9 fork: the 2.x table is the same at `node-2.1.0-rc.4` and on midnight-node `main`, in both
`ledger/src/ledger_8/types.rs` and `ledger/src/ledger_9/types.rs` (node 2.1.101's own source isn't
public yet), and #838 and #839 come from the ledger 9.1.0.0 release notes (method and results in
[`scripts/decode-1010.NOTES.md`](scripts/decode-1010.NOTES.md)). Sources, pinned:_

- _midnight-node `node-1.0.400` (`3acfd2edecdcd91373b6a506933f4c14ad3f0308`):
  `ledger/src/versions/common/types.rs` (the code table), `conversions.rs`, `mod.rs` (the node
  log lines), `pallets/midnight/src/lib.rs`_
- _midnight-node `node-2.1.0-rc.4` (`1b2b31c714f8986a082b8690f15e805981c771dd`):
  `ledger/src/ledger_8/types.rs`_
- _midnight-ledger `ledger-8.1.3` (`b5d3e965a18e4cac17fac4f38446fc55c524439a`), the version node
  1.0.400 pins: `ledger/src/error.rs` (the texts in the node log)_
- _polkadot-sdk `polkadot-stable2603` (`2e4dd0bc22366a5af820492528869a493b5a5208`):
  `substrate/client/rpc-api/src/author/error.rs`_
- _midnight-docs: `docs/nodes/error-codes.mdx` and
  `docs/troubleshoot/decode-1010-transaction-rejection-errors.mdx` at
  `6a971bf2845645599c5f49e21fb13cbdae6f91dc` (midnight-docs#1454)_
- _`@midnight-ntwrk/wallet-sdk-facade` 4.1.0, `wallet-sdk-node-client` 1.1.3, `effect` 3.22.0,
  midnight-js 4.1.1 (`midnight-js-utils`, `midnight-js-contracts`, testkit-js)_
- _midnight-ledger `ledger-9.1.0.0` release notes (known defects #838 and #839)_
- _live node RPC on preview, preprod and mainnet (`system_version` `1.0.400-c338b9ac` on
  2026-10-07; on 2026-11-07, `2.1.101-913ec011` on mainnet and preview)_

_Node versions and their code tables move: re-check them before asserting anything._

---

## Symptom

Everything here is the wallet SDK running in your own process (Node.js or the page). Browser
consoles and the DApp Connector path, where a browser wallet submits for you, weren't
reproduced. Each item below was reproduced on a local network running node 1.0.400 unless
marked otherwise.

- **The wallet SDK rejects with a message that has no reason** (→ Diagnose 1):

  ```text
  (FiberFailure) SubmissionError: Transaction submission error
  ```

  That's all `err.name` and `err.message` hold. `err.stack` and `JSON.stringify(err)` don't
  contain the node's code either, and `err.cause` is `undefined`. `String(err)`, and
  `console.error(err)` in Node.js, print the whole chain:

  ```text
  (FiberFailure) SubmissionError: Transaction submission error
      at …
    [cause]: SubmissionError: Transaction submission failed
        at …
      [cause]: RpcError: 1010: Invalid Transaction: Custom error: 182
  ```

- **The console has the code even when the DApp swallows the error** (→ Diagnose 1). The RPC
  client logs this to stderr on every rejection, twice per rejection (two lines are one failure,
  not a retry):

  ```text
  RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 196
  ```

- **Midnight.js contract calls** (`deployed.callTx.<circuit>()`, plain or inside
  `withContractScopedTransaction`) reject with the whole chain in `err.message`, and `err.cause` is
  the wallet's `FiberFailure` (→ Diagnose 2):

  ```text
  Error: Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) SubmissionError: Transaction submission error
    …
      [cause]: RpcError: 1010: Invalid Transaction: Custom error: 182
  ```

  Reproduced with midnight-js 4.1.1 on a deployed counter contract. midnight-js `submitTx` passes
  the wallet's error on unchanged (`servicedesk#225`).
- **A client that shows the raw JSON-RPC response** (→ Diagnose 2; from `servicedesk#54`, not
  reproduced):

  ```json
  {"jsonrpc":"2.0","id":4,"error":{"code":1010,"message":"Invalid Transaction","data":"Custom error: 168"}}
  ```

- **No code at all, and the cause is `TransactionInvalidError`** (→ Remediation 3):

  ```text
  (FiberFailure) SubmissionError: Transaction submission error
    [cause]: TransactionInvalidError: Transaction is invalid and was rejected by the node
  ```

  The node accepted the transaction into its pool and dropped it when it built the block, so no
  code comes back. Reproduced with two wallet instances on one seed spending the same DUST while
  the first transaction was still pending. The same spend made after the first one was in a
  block got `Custom error: 196` instead.
- **The node log, if you run the node** (→ Diagnose 2). Mempool rejections of a malformed
  transaction print the node's error, and the line before it has the ledger's own text. Ledger
  state failures print "guaranteed execution would fail", either at submission ("from mempool")
  or when the block is built ("at pre-dispatch", the case with no code above):

  ```text
  Transaction malformed: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1791320261), Current block: Timestamp(1791320580)
  🚫 Rejected transaction 7a041e26… from mempool: Transaction Error: Malformed(TransactionApplicationError)
  🚫 Rejected transaction e5505985… from mempool: guaranteed execution would fail: ReplayProtectionViolation(IntentAlreadyExists)
  🚫 Rejecting transaction 7e428a89… at pre-dispatch: guaranteed execution would fail: DustDoubleSpend(DustNullifier(a244c441…))
  ```

**Not this runbook:**

- **1010 with text instead of a number:** `1010: Invalid Transaction: Transaction would exhaust
  the block limits` is a Substrate check, not the Midnight ledger. See the
  [batched deploy runbook](../contract-batched-deploy-runbook/contract-batched-deploy-runbook.md)
  (`servicedesk#225`; not reproduced here).
- **`disconnected from … Normal Closure` and no code:** the connection closed before
  the node answered, so there is no verdict. Seen when the same transaction was resubmitted
  straight after a rejection; the node never logged the second attempt. Retry after a few seconds.

## Root cause

**How the number gets into the error** (from source):

1. The node validates every submitted transaction against the ledger (`validate_unsigned` in
   `pallet_midnight`). A failure is a `LedgerApiError`, which the node turns into a `u8` with
   `impl From<LedgerApiError> for u8` and returns as `InvalidTransaction::Custom(code)`
   (`pallets/midnight/src/lib.rs` L557-574). Ledger variants the node has no code for become
   its catch-all, `Invalid.UnknownError` (109) or `Malformed.UnknownError` (139)
   (`conversions.rs`).
2. Substrate's author RPC answers with code 1010, message `Invalid Transaction` and data
   `Custom error: N` (`author/error.rs` L107-111). The 1010 is Substrate's envelope; the N is
   Midnight's.
3. The RPC client (polkadot.js) turns that into `RpcError: 1010: Invalid Transaction: Custom
   error: N`, and the wallet SDK wraps it twice: `SubmissionError: Transaction submission failed`
   (`wallet-sdk-node-client`), then `SubmissionError: Transaction submission error`
   (`wallet-sdk-capabilities`). The promise API rejects with an Effect `FiberFailure`, whose
   `message` is the outermost text and which sets no `cause`; only its `toString()` renders the
   chain (`effect` 3.22.0, `internal/runtime.ts` L223-227).

Ledger state is checked twice. At submission the pool validates the transaction against the
current state, and a failure comes back as 1010. When a block is built, `pre_dispatch` checks it
again against the state at that point (`lib.rs` L476). A failure there is logged by the node,
but the client only sees `TransactionInvalidError`, with no code. Two transactions that are each
valid on their own, such as two spends of the same DUST, both pass the first check while
neither is in a block yet.

**Why the code depends on the node version.** The table is in the node. Nodes 1.0.0 to 1.0.400
share one table of 120 codes. Node 2.0.0-rc.x has 154, and 2.1.0-rc.x and `main` have 155 (140
was added in 2.1.0-rc.1). Seven 1.0.x codes are gone in 2.x, and three more become the
`…Unknown` case of a finer split:

| 1.0.x | Name on 1.0.x | On node 2.x |
|---|---|---|
| 168 | `Malformed.FeeCalculation` | gone: 231 `OutsideTimeToDismiss`, 232 `BlockLimitExceeded` |
| 182 | `Malformed.TransactionApplicationError` | gone: 228 `IntentTtlExpired`, 229 `IntentTtlTooFarInFuture`, 230 `IntentAlreadyExists` |
| 186 | `Malformed.EffectsCheckFailure` | gone: 212 to 218 |
| 187 | `Malformed.DisjointCheckFailure` | gone: 225 to 227 |
| 188 | `Malformed.SequencingCheckFailure` | gone: 219 to 224 |
| 193 | `Invalid.ReplayProtectionViolation` | gone: 242 TTL expired, 243 TTL too far ahead, 244 intent already exists |
| 205 | `SystemTransaction.ReplayProtectionFailure` | gone: 245 to 247 |
| 103 | `Invalid.Zswap` | stays as `Invalid.Zswap.Unknown`; adds 239 to 241 and 250 |
| 127 | `Malformed.Zswap` | stays as `Malformed.Zswap.Unknown`; adds 235 to 238 |
| 174 | `Malformed.MalformedContractDeploy` | stays as `….Unknown`; adds 233 and 234 |

140, 156, 157, 248 and 249 are new. So `Custom error: 231` (`servicedesk#117`) came from a node
2.0.0-rc.4 devnet; on node 1.0.x the same failure is 168. Stagenet already runs node 2.0.0
(`system_version` `2.0.0-d9729c13`).

**The docs.** [Node error codes](https://docs.midnight.network/nodes/error-codes) is the
reference for node 1.0.x and matches node 1.0.400 code for code.
[Decode 1010 errors](https://docs.midnight.network/how-to/decode-1010-transaction-rejection-errors)
links to it. Until
[midnight-docs#1454](https://github.com/midnightntwrk/midnight-docs/pull/1454) (merged
2026-10-07), the decode page had its own 2.x table that marked 168, 182, 186, 187, 188, 193 and
205 as retired, although node 1.0.400 still uses all seven (182 and 193 were reproduced on it).
Copies of the docs made before then, including answers built from them, can still carry it.

**Malformed or Invalid.** A `Malformed` code is about the transaction as built (structure,
proofs, signatures, balance, TTL, fees). An `Invalid` code is about the ledger state it met
(already spent, already on chain), so the question is what got there first. The TTL is checked
in both places: the well-formedness check gives 182 (228 or 229 on 2.x), and replay protection
against ledger state gives 193 (242 or 243 on 2.x). Both TTL cases reproduced on node 1.0.400,
expired and 30 days ahead, came back as 182, from the first check.

## Key identifiers

- **RPC error:** `{"code":1010,"message":"Invalid Transaction","data":"Custom error: N"}`, with N
  from 0 to 255. Without `Custom error:`, the data is Substrate's own reason (for example
  `Transaction would exhaust the block limits`). Other pool codes (`author/error.rs`): 1011
  Unknown Transaction Validity, 1012 Transaction is temporarily banned, 1013 Transaction Already
  Imported, 1014 Priority is too low, 1016 Immediately Dropped (the pool is full).
- **Code ranges on node 1.0.x:** 0-11 deserialization, 50-63 serialization, 100-109 and 193-200
  `Invalid`, 110-139 and 166-192 `Malformed`, 150-155 and 165 node ledger API, 201-211 system
  transactions, 255 host API. The tables themselves are linked under Reference material.
- **Node version:** JSON-RPC `system_version`. `1.0.400-c338b9ac` on preview, preprod and
  mainnet on 2026-10-07 (the build hash isn't a public commit); on 2026-11-07, after the ledger 9
  fork, `2.1.101-913ec011` on mainnet and preview and still `1.0.400-c338b9ac` on preprod; and `2.0.0-d9729c13` on stagenet,
  a 2.0.0 build with no public tag, so its table is assumed to be 2.0.0-rc.x's; the
  `midnightntwrk/midnight-node:1.0.400` image reports `1.0.400-87c0fbdb`, with the same table.
  `rpc.<network>.midnight.network` answered without a key on 2026-10-07; for their shutdown and
  Blockfrost's project token, see the
  [Blockfrost migration runbook](../indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md).
- **Wallet SDK errors:** name `(FiberFailure) SubmissionError`; messages
  `Transaction submission error` (outer) and `Transaction submission failed` (inner). With no
  node code: `TransactionInvalidError: Transaction is invalid and was rejected by the node`,
  `TransactionDroppedError` and `TransactionUsurpedError` (`wallet-sdk-node-client` 1.1.3,
  `PolkadotNodeClient.js`).
- **Node log:** `Rejected transaction <hash> from mempool: Transaction Error: …` (the node's
  error), `… from mempool: guaranteed execution would fail: …` and `Rejecting transaction <hash>
  at pre-dispatch: guaranteed execution would fail: …` (the ledger's).
- **TTL:** set by the caller. `wallet-sdk-facade` 4.1.0 requires `ttl` in `transferTransaction`
  and the `balance…Transaction` methods (its own one-hour `DEFAULT_TTL_MS` only covers DUST
  registrations and fee estimates). Midnight.js uses `ttlOneHour()`, the machine clock + 1 hour
  (`midnight-js-utils` 4.1.1), for deploy and call intents, and testkit-js's `balanceTx` defaults
  to it.
- **Transaction id and timing:** `WalletFacade.submitTransaction` resolves only once the
  transaction is finalized, and returns `tx.identifiers().at(-1)`, which you can read before
  submitting. That took 14 to 22 s on the local network. Preprod and mainnet made a block every
  6 s and finalized 2 to 3 blocks behind (measured 2026-10-07).

## Diagnose (no API key)

1. **Get the code.** Search the output you already have (terminal, CI log, browser console) for
   `Custom error:` or `RPC-CORE: submitAndWatchExtrinsic`; the RPC client prints the code on
   every rejection, even when the DApp swallows the error. If the line says
   `disconnected from … Normal Closure` instead, the node never answered (see Not this runbook).
   If the cause is `TransactionInvalidError`, there is no code; go to Remediation 3. If there's
   nothing, log `String(err)` where you catch the submission error and reproduce. In a browser,
   use `String(err)`: the docs say browser consoles show only the outer message (not reproduced
   here). Reproducing submits a transaction, so an agent working for a user asks first. If you
   run the node, grep its log for `Rejected transaction` and `Rejecting transaction`.
2. **Decode it.** The script needs Node >= 20, no install, and only reads the text you give it;
   with `--rpc` it also asks the node for its version.

   ```sh
   mkdir -p /tmp/decode-1010
   curl -fsSL -o /tmp/decode-1010/decode-1010.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/node-1010-custom-error-runbook/scripts/decode-1010.mjs
   node /tmp/decode-1010/decode-1010.mjs 'RpcError: 1010: Invalid Transaction: Custom error: 196'   # paste the line
   node /tmp/decode-1010/decode-1010.mjs app.log --rpc wss://rpc.preprod.midnight.network          # or a saved log
   npm run deploy 2>&1 | node /tmp/decode-1010/decode-1010.mjs                                     # or a command that exits
   ```

   For a server that keeps running, save its output first (`npm start 2>&1 | tee app.log`) and
   pass the file; the script reads stdin to the end before it prints. It finds every
   `Custom error: N`, every pool error, the no-code wallet errors and the node log lines above.
   Pass `--rpc` with the node URL the DApp uses (the `wss://` one works), so it decodes against
   that node's version, or `--node 1.0` / `--node 2.x`; without either it assumes 1.0.x and says
   so. For Blockfrost, `export BLOCKFROST_PROJECT_ID=…` first; the key is only sent to
   blockfrost.io and never printed. Exit code: 0 = explained at least one failure, 2 = found none
   it could explain (it says how to get the code out of the SDK error), 1 = it could not run.
   Example:

   ```text
   Code table: node 1.0.x (1.0.0 to 1.0.400). https://rpc.preprod.midnight.network runs
       1.0.400-c338b9ac.

   Custom error: 196 → Invalid.DustDoubleSpend
     Invalid: the transaction is well-formed but conflicts with the ledger state it was checked
     against.
     The DUST that pays the fee is already spent on chain. Reproduced on node 1.0.400 with two wallet
     instances on one seed: the second transaction got 196 once the first was in a block. Fix: one
     wallet instance per seed (one instance built and submitted two transfers back to back without a
     conflict); with several processes, send every submission through the one that holds the wallet.
   ```

   A code that only exists on the other node version gets a pointer instead:

   ```text
   Custom error: 231 → not a code on node 1.0.x.
     On node 2.x it is Malformed.FeeCalculation.OutsideTimeToDismiss. On node 1.0.x the same failure is
     168 (Malformed.FeeCalculation). Check which node rejected the transaction (--rpc).
   ```

3. **By hand, if you can't run it:** check the node version, then look the code up on the
   [Node error codes](https://docs.midnight.network/nodes/error-codes) page for 1.0.x, or in the
   2.x source under Reference material.

   ```sh
   curl -s -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' \
     https://rpc.preprod.midnight.network
   ```

4. **Match it to a cause.** The failures that come up in practice:

   | 1.0.x code | 2.x code | Name on 1.0.x | What happened | Seen in | Fix |
   |---|---|---|---|---|---|
   | 182 | 228, 229 | `Malformed.TransactionApplicationError` | Intent TTL expired or too far ahead (the node log says which) | reproduced; `servicedesk#235` (the same text in a node log) | Remediation 1 |
   | 193 | 242, 243 | `Invalid.ReplayProtectionViolation` | Intent TTL expired or too far ahead, checked against ledger state | from source | Remediation 1 |
   | 193 | 244 | `Invalid.ReplayProtectionViolation` | The transaction was submitted again after it landed | reproduced | Remediation 2 |
   | 196 | 196 | `Invalid.DustDoubleSpend` | The DUST paying the fee is already spent on chain | reproduced | Remediation 3 |
   | none | none | `TransactionInvalidError` | Rejected when the block was built, e.g. the same DUST spent twice while both were pending | reproduced | Remediation 3 |
   | 170 | 170 | `Malformed.InvalidDustSpendProof` | The DUST spend proof didn't verify, which is as likely a disagreement on DUST state as a bad proof | `servicedesk#150`, `servicedesk#52` | Remediation 4 |
   | 168 | 231, 232 | `Malformed.FeeCalculation` | Too slow to validate for its size, or too big for a block | `servicedesk#100`, `servicedesk#117` | Remediation 5 |
   | none | 231 | `OutsideTimeToDismiss` on ledger 9 | A contract call paid with exactly one DUST spend | [midnight-ledger#838](https://github.com/midnightntwrk/midnight-ledger/issues/838) (open) | Remediation 5 |
   | 104 | 104 | `Invalid.Transcript` | The call's on-chain program failed against the state it met, e.g. the contract's state changed after the call was built; on ledger 9 also a held shielded coin written back with `writeCoin` (node log: `ran out of gas budget`) | from source; [midnight-ledger#839](https://github.com/midnightntwrk/midnight-ledger/issues/839) (open) | Remediation 7 |
   | 186 | 212 to 218 | `Malformed.EffectsCheckFailure` | The transaction's effects don't match what its contract calls claim | `servicedesk#37` | Remediation 6 |
   | 194 | 194 | `Invalid.BalanceCheckOutOfBounds` | A contract call pays out more of a token than the contract holds. On Mainnet, every circuit that sends NIGHT | reproduced (node 1.0.0 and 1.0.400) | [NIGHT on Mainnet](../contract-native-night-mainnet-runbook/contract-native-night-mainnet-runbook.md) |

   On node 1.0.x, 182 and 193 can each carry all three cases (TTL expired, TTL too far ahead,
   intent already exists), because both wrap the ledger's `TransactionApplicationError`. In the
   reproductions, TTL failures came back as 182 and a resubmitted transaction that had landed as
   193. Anything else → Remediation 8.

## Remediation

1 to 3 were reproduced; 4 to 6 come from worked cases.

1. **TTL (182 or 193; 228, 229, 242 and 243 on 2.x).** Build the transaction again and submit
   it promptly, with a TTL a little in the future. On node 1.0.400, now + 30 minutes was
   accepted, a midnight-js call with the default TTL went through after an expired one failed,
   and now - 5 minutes and now + 30 days were rejected. The local node allowed up to block time +
   14 days; the public networks' limit wasn't checked, and the node's RPC has no method that
   returns it. The TTL is whatever your code passes as `ttl`, or midnight-js's `ttlOneHour()`.
   Both come from the client's clock, so a clock that's behind by more than your margin (an hour
   with `ttlOneHour()`) produces expired TTLs (from source, not reproduced). On a public network
   you won't see the node log: compare the `ttl` you passed with the time you submitted. A
   resubmitted transaction that already landed gets 193 instead (Remediation 2).

   *Trade-off:* a signed transaction that waits (offline signing, a job queue, a co-signing
   window) can expire, and a TTL can't hold a long window open. Keep the window under the limit,
   or have everyone sign the final transaction close to submission.
2. **Already on chain (193; 244 on 2.x).** The transaction landed, and usually a retry
   resubmitted it. Submitting the same transaction again while it was still pending was harmless:
   both calls resolved with the same id. After it was in a block, the same resubmission got 193.
   `submitTransaction` itself takes 14 to 22 s to resolve, so a retry timeout shorter than that
   fires on healthy submissions. Keep the id before the first submission:
   `tx.identifiers().at(-1)` on the transaction `finalizeRecipe` returned is the id
   `submitTransaction` returns (checked). Before retrying, check whether it's on chain. With
   midnight-js, race `publicDataProvider.watchForTxData(txId)` against a timeout, because it never
   times out on its own: for a landed id it resolved, for one that never landed it waited until
   the 30 s timeout. Without midnight-js, look the id up on the indexer (not covered here). Treat
   193 after a retry as "the first one went through", and build a new transaction for a real
   retry.

   *Trade-off:* safe retries mean storing the id before the first submission.
3. **DUST already spent (196, or `TransactionInvalidError` with no code).** Run one wallet
   instance per seed. Two instances on one seed built from the same state picked the same DUST:
   while the first transaction was pending, the second was dropped when the block was built
   (`TransactionInvalidError`), and once the first was in a block, the same spend got 196. One
   instance doesn't do this: it built two transfers back to back and submitted them a second
   apart, and built the next one right after the previous one finalized, and all went through. With
   several processes, send every submission through the one process that holds the wallet.

   *Trade-off:* one submitter per seed. Separate wallets (seeds), each with its own DUST, would
   allow independent submitters (not tested).
4. **DUST spend proof (170).** Let the wallet finish syncing and build again. If every
   transaction on the network gets 170, faucet included, the problem is on the network's side, not
   in the DApp: open a servicedesk issue. In `servicedesk#150` (stagenet, ledger v9) it was an
   indexer bug, fixed by
   [midnight-indexer#1443](https://github.com/midnightntwrk/midnight-indexer/pull/1443). If only
   your client fails, compare its ledger with the node's (`npm ls @midnight-ntwrk/ledger-v8`
   against the `midnight_ledgerVersion` RPC). In `servicedesk#52` a client on ledger-v8 8.0.3 got
   170 on preprod while 8.1.0 deployed, though the cause wasn't established. A transfer proved by
   proof server 8.0.3 was accepted by node 1.0.400, so an older proof server alone doesn't cause
   it.
5. **Fee check (168 on 1.0.x; 231 and 232 on 2.x).** On node 1.0.x one code covers two ledger
   errors, and the node log says which. "Exceeded the maximum time to dismiss for transaction
   size" means the transaction would take longer to validate than its size allows. Fewer intents
   per transaction may help: in `servicedesk#100` a third intent the SDK added to a balanced swap
   tipped it over, and the app couldn't avoid it. The limit is a network parameter, so nothing on
   the client raises it; `servicedesk#100` was closed as needing a governance decision. "Exceeded
   block limit in transaction fee computation" means it's too big for a block; for a deploy, see
   the
   [batched deploy runbook](../contract-batched-deploy-runbook/contract-batched-deploy-runbook.md).
   On a public network you won't see the node log: if it's a deploy, start with the batched deploy
   runbook, otherwise treat it as the time-to-dismiss check. On ledger 9 (mainnet and preview),
   a moderately expensive contract call (about 10 ms to apply) paid with exactly one DUST spend can
   hit 231 because the client overestimates the transaction's size (midnight-ledger#838, a known
   defect, from the ledger 9.1.0.0 release notes, not reproduced here). The release notes say two
   or more DUST spends avoid it, but wallet-sdk-facade 5.0.0's balancing options are only `ttl` and
   `tokenKindsToBalance`, so a DApp can't choose that: there's no workaround yet. Triage expects the
   fix as a client package upgrade.

   *Trade-off:* splitting one transaction into several gives up atomicity; a later one can fail
   after an earlier one landed.
6. **Effects check (186; 212 to 218 on 2.x).** midnight-js 4.0.4 put the offer for a fallible
   claim in the guaranteed section (`servicedesk#37`), and 4.1.1 fixed it. Upgrade to the
   [support matrix](https://docs.midnight.network/relnotes/support-matrix) version. Otherwise open
   an issue with the contract and the full error.

   *Trade-off:* midnight-js 4.1.1 goes with compact-runtime 0.16.0, so the rest of the project
   moves to the matrix set with it (see the
   [toolchain version mismatch runbook](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md)).
7. **Transcript rejected (104).** 104 is every transcript rejection
   (`ledger/src/ledger_9/conversions.rs` maps `Transcript(..)` to it): the call's on-chain program
   failed against the state it met. Often the contract's state changed after the call was built
   (ledger 9.1.0.0's own tests expect `ReadMismatch` for that); build the call again against the
   current state. One case is a known defect on ledger 9: if the call spends a shielded coin the
   contract holds and writes the change back with `writeCoin`, and the node log says `ran out of gas
   budget`, it's rejected once the chain's commitment tree isn't empty: the node measures a few more `bytes_written` than
   the client declared, because the stored coin's `mt_index` is its real tree position
   (midnight-ledger#839, open; from the ledger 9.1.0.0 release notes; [midnight-examples#88](https://github.com/midnightntwrk/midnight-examples/pull/88)
   reports it for shielded-chips' `burnFromTreasury`). Nothing in the call is wrong, and the release notes give no
   workaround; it waits on a ledger fix.
8. **Anything else.** Run the decoder, read the name and category, and check the code's row on
   the Node error codes page. If that doesn't explain it, open an issue at the
   [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) with
   `String(err)`, the decoder's output, the node's `system_version` and, if you have them, the
   node log lines around `Rejected transaction`.

## Upstream follow-ups

- [servicedesk#225](https://github.com/midnightntwrk/servicedesk/issues/225): the SDK error that
  reaches the DApp doesn't carry the node's reason in `message`.
- [midnight-docs#1454](https://github.com/midnightntwrk/midnight-docs/pull/1454) (merged
  2026-10-07): made the Node error codes page the single node 1.0.x reference, added 211, and
  removed the 2.x table from "Decode 1010 errors".
- [midnight-ledger#838](https://github.com/midnightntwrk/midnight-ledger/issues/838) and
  [#839](https://github.com/midnightntwrk/midnight-ledger/issues/839) (both open): ledger 9's
  single-DUST-spend size estimate (231) and coin write-back gas (104).
- [midnight-docs#1509](https://github.com/midnightntwrk/midnight-docs/issues/1509): the decode
  page's "no inner u8" causes (signature, era, nonce) don't apply to Midnight's unsigned
  transactions, and the code-less `TransactionInvalidError` isn't documented.

## Reference material

- **Reproductions:** [`scripts/decode-1010.NOTES.md`](scripts/decode-1010.NOTES.md): every
  reproduction, how the script's tables were generated and checked, and what was not reproduced.
  [`scripts/gen-tables.mjs`](scripts/gen-tables.mjs) rebuilds the tables from a node release.
- **Worked cases:** `servicedesk#37` (186, midnight-js 4.0.4), `servicedesk#52` (170, cause not
  established), `servicedesk#54` (168 on node 0.22.5, whose table wasn't checked),
  `servicedesk#100` (168, three-intent swap), `servicedesk#117` (231 on a node 2.0.0-rc.4
  devnet), `servicedesk#150` (170 for every transaction on stagenet, an indexer bug),
  `servicedesk#225` (1010 "would exhaust the block limits"), `servicedesk#235` (the 182 TTL text
  in a node's log while replaying history).
- **Docs:** [Node error codes](https://docs.midnight.network/nodes/error-codes) (the 1.0.x table
  and how the SDK wraps the error),
  [Decode 1010 errors](https://docs.midnight.network/how-to/decode-1010-transaction-rejection-errors)
  (extracting the code; links to the table).
- **Source:**
  - midnight-node `node-1.0.400`: [`ledger/src/versions/common/types.rs` L277-419](https://github.com/midnightntwrk/midnight-node/blob/3acfd2edecdcd91373b6a506933f4c14ad3f0308/ledger/src/versions/common/types.rs#L277-L419)
    (the code table), [`conversions.rs` L48-51 and L137-139](https://github.com/midnightntwrk/midnight-node/blob/3acfd2edecdcd91373b6a506933f4c14ad3f0308/ledger/src/versions/common/conversions.rs#L48-L51)
    (catch-alls), [`mod.rs` L946, L972 and L1017](https://github.com/midnightntwrk/midnight-node/blob/3acfd2edecdcd91373b6a506933f4c14ad3f0308/ledger/src/versions/common/mod.rs#L946)
    (the log lines), [`pallets/midnight/src/lib.rs` L557-574](https://github.com/midnightntwrk/midnight-node/blob/3acfd2edecdcd91373b6a506933f4c14ad3f0308/pallets/midnight/src/lib.rs#L557-L574)
    and [L476](https://github.com/midnightntwrk/midnight-node/blob/3acfd2edecdcd91373b6a506933f4c14ad3f0308/pallets/midnight/src/lib.rs#L476) (`pre_dispatch`)
  - midnight-node `node-2.1.0-rc.4`: [`ledger/src/ledger_8/types.rs` L359-556](https://github.com/midnightntwrk/midnight-node/blob/1b2b31c714f8986a082b8690f15e805981c771dd/ledger/src/ledger_8/types.rs#L359-L556)
  - midnight-ledger `ledger-8.1.3`: [`ledger/src/error.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/b5d3e965a18e4cac17fac4f38446fc55c524439a/ledger/src/error.rs)
    (`FeeCalculationError`, `TransactionApplicationError`, `InvalidDustSpendProof` texts)
  - polkadot-sdk `polkadot-stable2603`: [`substrate/client/rpc-api/src/author/error.rs` L107-111](https://github.com/paritytech/polkadot-sdk/blob/2e4dd0bc22366a5af820492528869a493b5a5208/substrate/client/rpc-api/src/author/error.rs#L107-L111)
  - `effect` 3.22.0 `internal/runtime.ts` (`FiberFailureImpl.toString`); `wallet-sdk-facade`
    4.1.0 `dist/index.js` (`submitTransaction`, `transferTransaction`, `DEFAULT_TTL_MS`);
    `wallet-sdk-node-client` 1.1.3 `dist/effect/PolkadotNodeClient.js` (the no-code errors);
    midnight-js 4.1.1: `midnight-js-utils` (`ttlOneHour`), `packages/contracts` (`Unexpected error
    submitting scoped transaction`), `midnight-js-types` (`watchForTxData`)
