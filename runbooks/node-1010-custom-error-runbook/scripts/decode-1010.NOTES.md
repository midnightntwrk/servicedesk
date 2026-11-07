# Notes: `decode-1010.mjs`

What the script does, how each symptom in the
[1010 runbook](../node-1010-custom-error-runbook.md) was reproduced, and how the script was
tested. **The user runs it** on their own error text; it signs and submits nothing.

## What the script reads

| Input | Pattern | Output |
|---|---|---|
| Ledger code | `Custom error: N` anywhere (RPC error, `String(err)`, `RPC-CORE` line, JSON) | name, category, a hint for codes with a reproduction or worked case, and what the code is on the other node version |
| Pool error | `10xx: <Substrate message>[: data]`, or a JSON-RPC error object in any key order (also escaped inside a JSON log line) | the Substrate meaning; for 1010 without a number, the reason text |
| No-code wallet error | `Transaction is invalid and was rejected by the node`, `…got dropped…`, `…got usurped…`, a submission's `disconnected from … Normal Closure` | what happened and what to do |
| Node log | `Rejected transaction <hash> from mempool: …` (the node's error, or "guaranteed execution would fail: …") and `Rejecting transaction <hash> at pre-dispatch: …`; `Transaction malformed: …` detail lines | the code that line maps to; the detail text |
| Bare number | 0-255 (ledger) or 1001-1021 (pool) | as above |
| Wallet wrapper only | `Transaction submission error`, `SubmissionError`, `Unexpected error submitting scoped transaction` and nothing else | exit 2 and how to get the code out |

Input can be files, text arguments, numbers, or stdin (`-`, or piped with no arguments). Colour
codes, a UTF-8 BOM and UTF-16LE files (PowerShell's default) are handled. The table comes from
`--node 1.0|2.x`, or from `system_version` with `--rpc`, which also takes the wallet's `ws(s)://`
URL; without either it uses 1.0.x and says so. A version that is neither 1.0.x nor 2.0/2.1 stops
the script (exit 1) rather than decode against the wrong table; a 2.x build other than
2.1.0-rc.4, or a 1.0.x newer than 1.0.400, gets a caution line. `BLOCKFROST_PROJECT_ID` is only
sent to `blockfrost.io` hosts, and it and any `project_id` in a URL are redacted from the output.

## How the tables were made

Not typed by hand. [`gen-tables.mjs`](gen-tables.mjs) reads `impl From<LedgerApiError> for u8`
(code → variant) and `impl core::fmt::Display for LedgerApiError` (log text → code) from a node
`types.rs` and prints the consts the decoder embeds. Run on the two files below, its output is
byte-identical to the tables in `decode-1010.mjs`. An independent parser built during the review
agreed, and so did every code 0-255 in both tables, checked one by one. At run time the decoder
renames the four variants the source imports under aliases
(`Deserialization.DeserializationLedgerState` → `Deserialization.LedgerState`, and the same for
`ContractAddress` and both `Serialization` ones).

| Table | Source | Codes | Display texts |
|---|---|---|---|
| `NODE_1_0`, `DISPLAY_1_0` | midnight-node tag `node-1.0.400` (`3acfd2edecdcd91373b6a506933f4c14ad3f0308`), `ledger/src/versions/common/types.rs` | 120 | 34 |
| `NODE_2_X`, `DISPLAY_2_X` | tag `node-2.1.0-rc.4` (`1b2b31c714f8986a082b8690f15e805981c771dd`), `ledger/src/ledger_8/types.rs` | 155 | 36 |

Same table, checked: `node-1.0.0`, `node-1.0.1`, `node-1.0.2`, `node-1.0.300` and
`release/node-1.0.400` equal `node-1.0.400`; `ledger_9/types.rs` equals `ledger_8/types.rs` at
`node-2.1.0-rc.4`, and both equal `main` at `b2f85e1626edb8dec8e49841e69f95943ec7b4e0`.
`node-2.0.0-rc.1` to `rc.4` have 154 codes, lacking only 140 (`SystemTransaction.NotAllowedForCaller`).
The `SPLIT` map (which 2.x codes replace a 1.0.x code) was checked against both tables: every new
code's name starts with the old code's name, or with the old name minus `Error` or `Failure`
(182, 186, 187, 188). The catch-alls come from `ledger/src/versions/common/conversions.rs` at
`node-1.0.400` (L48-51 and L137-139: unmapped ledger variants become `Invalid.UnknownError` 109
or `Malformed.UnknownError` 139).

The docs pages were compared with these tables by the same parser:
`docs/nodes/error-codes.mdx` at `9c10c788d677519d4a5eaf70f7cc53419138da54` (2026-09-23) matches
node 1.0.400 except that 211 is missing; `docs/troubleshoot/decode-1010-transaction-rejection-errors.mdx`
at `1bd43d50d6feba0332bb3897cc21648bdf1d4794` (2026-08-12) matches node 2.x except that 140 is
missing, and marks 168, 182, 186, 187, 188, 193 and 205 as retired. After midnight-docs#1454
(merged 2026-10-07, `6a971bf2845645599c5f49e21fb13cbdae6f91dc`) the Node error codes page matches
node 1.0.400 code for code, and the decode page links to it instead of carrying a table.

## Verified before hand-off (2026-10-07)

### Reproductions

Local network from `midnight-local-dev` (`902561d`) with `midnightntwrk/midnight-node:1.0.400`
(`system_version` `1.0.400-87c0fbdb`), `indexer-standalone` 4.3.3 and `proof-server` 8.1.0;
client `ledger-v8` 8.1.0, `wallet-sdk-facade` 4.1.0, `effect` 3.22.0, Node 24.20.0. The genesis
wallet sent itself 1 NIGHT per case. `WalletFacade.submitTransaction` resolves only once the
transaction is finalized (14 to 22 s here), so the "pending" cases start the first submission
without awaiting it. The awaited cases ran twice (2026-10-06), the pending and midnight-js ones
once (2026-10-07). On 2026-10-07 preprod and mainnet made 10 blocks a minute and finalized 2 to 3
blocks behind (`chain_getHeader`, `chain_getFinalizedHead`).

| Case | Result | Node log |
|---|---|---|
| Intent TTL now - 5 min | `1010: Invalid Transaction: Custom error: 182` | `Intent TTL has expired. TTL: …, Current block: …`, then `Transaction Error: Malformed(TransactionApplicationError)` |
| Intent TTL now + 30 days | `Custom error: 182` | `Intent TTL is too far in the future. TTL: Timestamp(1793912570), Maximum allowed: Timestamp(1792530186)`, block time + 14 days |
| Intent TTL now + 30 min | accepted | none |
| Same transaction again 1 s after the first submission, while it was pending | accepted; both calls resolved with the same id | none |
| Same transaction again right after the first `submitTransaction` resolved (finalized) | accepted, same id, 19 ms | none |
| Same transaction again 30 s after it was finalized | `Custom error: 193` | `… from mempool: guaranteed execution would fail: ReplayProtectionViolation(IntentAlreadyExists)` |
| Second wallet instance on the same seed spends the same DUST 1 s after the first submission, while it was pending | no code: `[cause]: TransactionInvalidError: Transaction is invalid and was rejected by the node`, after 5.9 s; the first was accepted | `dust double spend …`, then `Rejecting transaction … at pre-dispatch: guaranteed execution would fail: DustDoubleSpend(DustNullifier(…))` |
| Second wallet instance spends the same DUST after the first was finalized, and again 30 s later | `Custom error: 196` both times | `dust double spend …`, then `… from mempool: guaranteed execution would fail: DustDoubleSpend(…)` |
| Same expired transaction three times (at once, at once, after 5 s) | 182; then no code, `[cause]: Error: disconnected from <local node>: 1000:: Normal Closure`; then 182 again; never 1012 | one rejection for the first, none for the immediate second (checked on the 2026-10-07 run) |
| NIGHT transfer proved by `midnightntwrk/proof-server:8.0.3` (`/version` 8.0.3, one `POST /prove` logged) | accepted | none |
| midnight-js 4.1.1: `deployContract` of a counter (compiler 0.31.1, compact-runtime 0.16.0) | deployed | none |
| midnight-js `callTx.increment()`, with testkit-js's `balanceTx` given a TTL 5 minutes in the past | `Error: Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) SubmissionError: …`; `err.message` contains `Custom error: 182`; `err.cause` is the `FiberFailure` | `Transaction Error: Malformed(TransactionApplicationError)` |
| the same call inside `withContractScopedTransaction(…, { scopeName: 'bump' })` | the same, with `'bump'` | the same |
| the same call again with the default TTL (`ttlOneHour()`) | accepted | none |
| `tx.identifiers().at(-1)` read before submitting vs `submitTransaction`'s result | equal | none |
| `watchForTxData(id)` raced with a timeout: landed id; id of a transaction never submitted | resolved (`SucceedEntirely`); still waiting at the 30 s timeout | none |
| One wallet instance: two transfers built back to back from the same state, submitted 1 s apart | both accepted | none |
| One wallet instance: next transfer built right after the previous `submitTransaction` resolved, no sync wait | accepted | none |

What each way of printing the rejected error showed (expired-TTL case):

| Expression | Has `Custom error: 182` |
|---|---|
| `err.name` / `err.message` | no: `(FiberFailure) SubmissionError` / `Transaction submission error` |
| `err.stack` | no |
| `JSON.stringify(err)` | no |
| `err.cause` | `undefined` |
| `String(err)` | yes |
| `util.inspect(err)` (what `console.error` prints in Node.js) | yes |
| stderr | yes, `RPC-CORE: submitAndWatchExtrinsic(…): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 182`, twice per rejection |

### Not reproduced

- **170:** a transfer proved by proof server 8.0.3 was accepted, so 170 is documented from
  `servicedesk#52` and `servicedesk#150` only.
- 168, 186, 231, 232 and `Transaction would exhaust the block limits`: taken from the worked
  cases and the ledger source.
- Browser consoles and the DApp Connector path.
- A deploy rejected through midnight-js (`deployContract` and `submitTx` pass the wallet's error
  on unchanged per `servicedesk#225`).
- The public networks' TTL limit: the node's RPC has no method for ledger parameters (`rpc_methods`
  on preprod lists `midnight_apiVersions`, `contractState`, `ledgerStateRoot`, `ledgerVersion` and
  `zswapStateRoot`). Also 242 or 243 on any node (on node 1.0.400 both TTL cases
  were caught by the well-formedness check as 182).
- A client clock that is off: from source (`ttlOneHour()` in `midnight-js-utils` 4.1.1 is
  `Date.now()` + 1 hour).
- Separate seeds for independent submitters (advice, not tested).

### Script test runs

On Node 20.19.1, macOS, unless noted; 47 cases, all as expected.

| Input | Exit | Output |
|---|---|---|
| reproduction log with 182, 193 and 196 `RPC-CORE` lines | 0 | all three decoded once each |
| node log, awaited run (9 lines) | 0 | `Malformed(TransactionApplicationError)` → 182, `Invalid(ReplayProtectionViolation(IntentAlreadyExists))` → 193, `Invalid(DustDoubleSpend(DustNullifier))` → 196; with `--node 2.x`: 244, 196, and no match for the 1.0.x-only variant |
| node log, pending run | 0 | pre-dispatch `DustDoubleSpend` → 196, with the note that the client got no code |
| wallet stdout and stderr, pending run | 0 | 182, `TransactionInvalidError`, and the submission disconnect |
| midnight-js scoped-call error (`String(err)`), its stderr, and the node log of that run | 0 | 182 each |
| `servicedesk#100` text (168 plus the FiberFailure tail), `servicedesk#54` JSON envelope | 0 | 168, split into 231 and 232 on 2.x |
| JSON with keys reordered; JSON escaped inside a JSON log line | 0 | 196; `Transaction is outdated` with the Substrate hint |
| `servicedesk#225` text | 0 | points at the batched deploy runbook |
| colour codes around the line; UTF-16LE file; stdin via `-` | 0 | decoded |
| `1010: Invalid Transaction` with no data, bare `1010` | 0 | envelope explanation |
| `1014: Priority is too low: (5 vs 7)` | 0 | pool meaning |
| `Transaction is invalid and was rejected by the node`; a submission's `disconnected … Normal Closure` | 0 | the no-code explanations |
| `subscribeRuntimeVersion … Normal Closure` (a normal shutdown line) | 2 | not mistaken for a failure |
| node log `Error while getting transaction context`; `guaranteed execution would fail: DivideByZero` | 0 | 165; 109 as the node's catch-all |
| `231`; `182 --node 2.x`; `225 --node 2.x`; `243 --node 2.x` | 0 | cross-version pointers (168; 228 to 230; 187; 193) |
| `Custom error: 12`, `Custom error: 0x1a`, `{"code":1006,"message":"Abnormal Closure"}`, wrapper only | 2 | nothing explained; the wrapper case says how to get the code |
| `300`; missing `./app.log`; a directory; `-n 2.x`; `--node 3`; `--rpc` with `--node`; `--rpc notaurl`; `--rpc http://127.0.0.1:1` | 1 | one-line error |
| `--rpc` https and wss preprod, ws local node | 0 | `1.0.400-c338b9ac`, `1.0.400-87c0fbdb`; 1.0.x table |
| a file named `182` | 0 | `182` is the code, `./182` the file |
| 3,000 output blocks into a slow pipe | 0 | not truncated |
| Blockfrost preprod RPC with a fake `BLOCKFROST_PROJECT_ID`; a local server checking where the key goes | 1 / 0 | `HTTP 403 (Blockfrost rejected the project token; tokens are per network)`, key not printed; not sent to a non-Blockfrost host |
| Node 18.20.5 | 1 | refused |

## Re-verify when versions move

- When a network upgrades its node, check `system_version`. If it reports 2.x, the decoder
  already has the table, but check it against that release's `types.rs` with `gen-tables.mjs`
  (2.x was taken from a release candidate), and swap the runbook's 1.0.x examples for their 2.x
  codes.
- On a new node line (neither 1.0.x nor 2.x), run `gen-tables.mjs` on that tag's `types.rs`, add
  the output as a new table, and re-run the checks above.
- Re-run the reproductions on a local network with the new node image: the 182, 193 and 196
  cases each take under a minute once the wallet has synced.

## Ledger 9 fork re-check (2026-11-07)

- Live RPC: mainnet and preview `system_version` `2.1.101-913ec011`, preprod `1.0.400-c338b9ac`.
  `--rpc https://rpc.mainnet.midnight.network` picks the 2.x table and prints the caution line.
- `gen-tables.mjs` on `ledger/src/ledger_8/types.rs` and `ledger/src/ledger_9/types.rs`, at
  `node-2.1.0-rc.4` and at `main` (newest commit 2026-11-06): all four give the same 155-code
  table, identical to the embedded `NODE_2_X`. Node 2.1.101's own source isn't public yet, so the
  table isn't checked against it.
- #838 (231, `OutsideTimeToDismiss`, one DUST spend) and #839 (104, coin write-back out of gas
  budget) come from the ledger 9.1.0.0 release notes' known defects and the issues themselves (both
  open on 2026-11-07); neither was reproduced here. #838's triage comment expects the fix as a
  client package upgrade.


## Codes node 2.x dropped or split (kept from the old page)

The runbook page moved to the lean template in #292. The page as it was before that is in git
history at `2e0b50f` (`runbooks/node-1010-custom-error-runbook/node-1010-custom-error-runbook.md`),
with its pinned sources. This table is the one part of it the page points to. From midnight-node
`node-1.0.400` (`ledger/src/versions/common/types.rs`) and `main` (`ledger/src/ledger_9/types.rs`):

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

140, 156, 157, 248 and 249 are new on node 2.x.
