# Runbook: Deploying a contract too large for one block ("exceeded block limit" / "would exhaust the block limits")

A Compact contract with many exported circuits **cannot be deployed**. The deploy carries one
verifier key per circuit, and together they overflow the **per-block bytes-written limit**. You'll
see one of two failures:

- `deployContract()` fails while pricing or balancing the transaction, before anything is
  submitted.
- The node rejects the transaction as too heavy for a block.

Use this runbook to confirm that this is the cause. The fix is to deploy in batches: deploy the
contract with the keys that fit, then add the rest one at a time with signed maintenance updates.

_Compiled 2026-09-29. Sources, pinned:_

- _midnight-js `v4.1.1` (`5f8a5d14247cb238b52187f33ed31695a5fde85d`)_
- _midnight-ledger `ledger-8` (`9f9842ebed66cdff0f54d3fb09efc6a7cd077ed8`)_
- _midnight-node (`eaecadc03efd06464bcf1dbaf2c7c770967ae9e9`)_
- _the npm packages `@midnight-ntwrk/compact-js@2.5.1` and `@midnight-ntwrk/ledger-v8@8.1.0`_

_Verified end to end on a **live local stack**: midnight-node `0.22.1`, indexer-standalone `4.0.1`
and proof-server `8.0.3`, the mainnet image set in midnight-js 4.1.1's testkit, `CFG_PRESET=dev`,
with the same ledger limits as mainnet. The run used a 40-circuit contract. The one-shot deploy
failed; the batched deploy succeeded after a simulated crash and a resume; every circuit was then
callable. Not yet run on preview, preprod or mainnet: do the first real run on preview or preprod.
Verify line references and versions against current source before asserting anything, because the
Midnight ecosystem changes fast._

---

## Symptom

Which error you see depends on how far over the limit the deploy is.

- **Deploy exceeds a whole block** (≥ 100% of a block limit): `deployContract(...)` or
  `submitDeployTx` throws while the wallet balances the transaction. Nothing is submitted. Seen
  live:

  ```text
  (FiberFailure) Error: exceeded block limit in transaction fee computation
  ```

  This is ledger `FeeCalculationError::BlockLimitExceeded`, node code **155**.
- **Deploy fits a block but is too heavy for one transaction** (about 65–100% of a block limit):
  - The wallet balances the transaction and the node logs
    `Validated transaction <hash> for mempool`.
  - `author_submitAndWatchExtrinsic` then returns
    `{"code":1010,"message":"Invalid Transaction","data":"Transaction would exhaust the block limits"}`.
  - The SDK shows this as a generic **`Error: Transaction submission error`**. The node's reason
    is still on the error, three levels down behind Effect's `FiberFailure`. To see it, run
    `Cause.pretty(e[Runtime.FiberFailureCauseId], { renderErrorCause: true })` (from `effect`), or
    follow `Cause.failures(...)` → `.cause` → `.cause` to the `RpcError: 1010 ...`. In one live
    run it didn't surface at all: the deploy call **hung**, and no block ever included the
    transaction.
- The contract compiles fine, and small contracts deploy fine from the same wallet and setup. The
  failing contract has **many exported circuits**, roughly 15 or more for small circuits.
- Rarer relatives:
  - `transaction too large (size: N, limit: 1048576)`: `TransactionTooLarge`, node code **111**.
    This needs around 500 or more circuits, so the bytes-written limit binds long before it.
  - `exceeded block limit during post-block update declaration`: node code 154.
- **Not this runbook:** a deploy that hangs with the **CPU pinned and memory growing**. That is the
  [WalletFacade DUST balancing hang](../wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md).
  The 1010 hang above leaves the CPU idle. The hang runbook can also hit deploys whose constructor
  mints a token.

## Root cause

1. **Every circuit's verifier key goes into the deploy.**
   - compact-js `ContractExecutable.initialize` loops over every provable circuit ID and writes
     each one's verifier key into the initial `ContractState`
     (`compact-js/dist/esm/effect/ContractExecutable.js` in 2.5.1, around line 79:
     `Failed to find a verifier key for circuit ...`).
   - midnight-js `deployContract` → `submitDeployTx` → `createUnprovenDeployTx`
     (`packages/contracts/src/unproven-deploy-tx.ts`) has **no option to deploy only some
     circuits**. `DeployContractOptionsBase` offers only constructor args, `signingKey` and
     `additionalCoinEncPublicKeyMappings`.
2. **The per-block `bytesWritten` limit is small.** Mainnet, preprod, preview, qanet, devnet, dev
   and local all use the same limits (`midnight-node/res/<net>/ledger-parameters-config.json`):

   | limit | value |
   |---|---|
   | `transaction_byte_limit` | 1,048,576 B (per tx) |
   | `block_limits.bytesWritten` | **50,000** (per block) ← the one that binds |
   | `block_limits.blockUsage` | 1,000,000 |
   | `block_limits.bytesChurned` | 50,000,000 |
   | `block_limits.readTime` / `computeTime` | 2 s each (2e12 ps) |

   A deploy writes about **1.2 × its verifier-key bytes**.
3. **A single transaction can use only about 65% of a block, not 100%.** Two separate checks apply:
   1. **The ledger's fee computation** (`Transaction::fees` → `normalize(block_limits)`,
      `ledger/src/structure.rs` around line 1841) refuses anything over 100% of a block limit. That
      is the case-1 error.
   2. **The node's weight check.** midnight-node converts the ledger cost into Substrate weight as
      *largest normalized cost dimension × max block weight*: `get_transaction_cost` →
      `scale_normalized_cost` (`midnight-node/ledger/src/ledger_8/mod.rs` around lines 1050–1073
      and 1598–1611). Normal transactions get only `NORMAL_DISPATCH_RATIO = 75%`
      (`runtime/src/lib.rs:308`), minus on-initialize and inherent weight. The pallet's
      `check_weight` then returns `ExhaustsResources`, the 1010 error
      (`pallets/midnight/src/lib.rs` around lines 541–567).

   Measured live with node 0.22.1 and the 40-circuit test contract (compiler 0.31.1, keys of
   1,351–2,119 B, 69,400 B in total). The `bytesWritten` figures are for the balanced transaction;
   wallet balancing adds only about 224:

   | circuits in deploy | `bytesWritten` | % of 50,000 | result |
   |---|---|---|---|
   | 13 | 29,795 | 59.6% | **included** |
   | 14 | 31,291 | 62.6% | **included** |
   | 15 | 34,067 | 68.1% | rejected: 1010 exhaust the block limits |
   | 16 | 35,562 | 71.1% | rejected: 1010 |
   | 40 | 84,182 | 168% | rejected by fee computation (`exceeded block limit ...`) |
4. **The ledger itself allows deploying a subset.**
   - A deploy may contain only some operations (circuits). `ContractState::well_formed` requires
     only that the maintenance-authority counter is 0 and that every operation present has a key;
     a missing key gives `VerifierKeyNotSet`, code 110 (`ledger/src/verify.rs` lines 354–391).
   - The remaining keys can be added later with a `MaintenanceUpdate` carrying `VerifierKeyInsert`
     entries, signed by the **contract maintenance authority (CMA)** (`ledger/src/structure.rs`
     lines 2687–2749, `ledger/src/semantics.rs` lines 1472–1522).
   - midnight-js exposes this as `submitInsertVerifierKeyTx`, which inserts **one** circuit per tx
     (`packages/contracts/src/governance/submit-insert-vk-tx.ts` lines 73–103). A single insert
     costs a fixed **3,003 `bytesWritten`** (6% of a block), because the cost model charges a flat
     `VERIFIER_KEY_SIZE`. So each insert tx fits easily.

The SDK is not defective in the deploy path; it simply has no batch mode, so the batching has to
be done by hand. This runbook and its companion script do that. One arguable SDK/wallet defect:
the 1010 rejection is hidden behind a generic `Transaction submission error`, and at least once it
caused a hang. See "Upstream follow-ups" below.

## Key identifiers

- **Packages** (as of compile date): `@midnight-ntwrk/midnight-js-contracts@4.1.1`, plus `-types`,
  `-protocol`, `-network-id` and `-utils` at 4.1.1. These bundle `compact-js@2.5.1`,
  `compact-runtime@0.16.0` and `ledger-v8@8.1.0`. The matching compiler is Compact 0.31.x, whose
  output checks `checkRuntimeVersion('0.16.0')`.
- **SDK functions used:**
  - `createUnprovenDeployTx`
  - `submitTx`
  - `submitInsertVerifierKeyTx`
  - `findDeployedContract`
  - `createCircuitCallTxInterface`
  - error classes `DeployTxFailedError`, `InsertVerifierKeyTxFailedError` and `ContractTypeError`
  - private-state provider calls `setSigningKey` and `getSigningKey`
- **Ledger types** (`@midnight-ntwrk/midnight-js-protocol/ledger`): `ContractDeploy`
  (address = SHA-256 of the tagged deploy, **including a random nonce**), `ContractState`,
  `MaintenanceUpdate`, `VerifierKeyInsert`, `ContractOperationVersionedVerifierKey('v3', vk)`, and
  `Transaction.cost(params)`, which returns a `SyntheticCost`.
- **Default CMA:** a one-key committee with **threshold 1** (`DEFAULT_CMA_THRESHOLD = 1` in
  compact-js 2.5.1). The key is sampled by `sampleSigningKey()` unless you pass one.
- **Node constants:** `NORMAL_DISPATCH_RATIO = 75%`, and `BlockWeights` with a max of 2 s ref time
  (`midnight-node/runtime/src/lib.rs`).
- **Node error codes** (`midnight-node/ledger/src/ledger_{8,9}/types.rs`) and RPC errors:

  | code | error |
  |---|---|
  | RPC 1010 | "Transaction would exhaust the block limits" (Substrate `ExhaustsResources`) |
  | 107 | `VerifierKeyAlreadyPresent` |
  | 108 | `ReplayCounterMismatch` |
  | 110 | `VerifierKeyNotSet` |
  | 111 | `TransactionTooLarge` |
  | 113 | `VerifierKeyNotPresent` |
  | 135 | `InvalidCommitteeSignature` |
  | 136 | `ThresholdMissed` |
  | 154 | block limit (post-block update) |
  | 155 | fee calculation / block limit |
- **Compiler output:** `<out>/keys/<circuit>.verifier` holds one file per provable circuit. These
  are the bytes that go into the deploy.

## Diagnose (no API key, no node)

1. **Count the circuits and size the keys** from the compiler output. Do not compile with
   `--skip-zk`, because that produces no keys.

   ```sh
   ls <out>/keys/*.verifier | wc -l
   cat <out>/keys/*.verifier | wc -c         # total VK bytes; > ~25,000 is suspect
   ```
2. **Price the deploy exactly** with [`scripts/measure-deploy-cost.mjs`](scripts/measure-deploy-cost.mjs).
   It needs no wallet, node or API key, and nothing is signed.

   ```sh
   mkdir /tmp/measure && cd /tmp/measure && npm i @midnight-ntwrk/ledger-v8@8.1.0
   cp <this-repo>/runbooks/contract-batched-deploy-runbook/scripts/measure-deploy-cost.mjs .
   node measure-deploy-cost.mjs <out>            # exit 3 = needs batching, 0 = fits, 2 = bad input
   # optional: a specific network's limits (<network> = mainnet | preprod | preview), pinned to the
   # midnight-node commit in the header; switch to a newer ref only if the limits have changed
   curl -fsSLO https://raw.githubusercontent.com/midnightntwrk/midnight-node/eaecadc03efd06464bcf1dbaf2c7c770967ae9e9/res/<network>/ledger-parameters-config.json
   node measure-deploy-cost.mjs <out> --params ledger-parameters-config.json
   ```

   Example output for the 40-circuit test contract:

   ```text
   bytesWritten 83261 (block limit 50000)
   RESULT: DOES NOT FIT in one block — exceeds: bytesWritten 83261 > 50000
   batch plan at 60% of limits (worst case: largest keys first):
     first deploy can carry at least 12 verifier keys
     => 1 deploy tx + at most 28 single-insert txs
   ```

   12 is a worst case: the script packs the largest keys first. `batchDeploy` fills in
   priority/compiled order and usually fits more (14 for the same contract in the live run).

   The default `--headroom 0.6` reflects the live ceiling of about 65%. Anything over it needs
   batching, even when it is under 100%. The script slightly under-estimates the real deploy: it
   leaves out the constructor's ledger data and the ~224 `bytesWritten` that wallet balancing adds.
3. If the result is "fits", the problem is something else. Check the DUST hang runbook, wallet
   funding, and the proof server.

## Remediation options (least invasive first)

1. **Shrink the deploy (no batching needed).** Only *exported, impure* circuits get verifier keys.
   Non-exported helpers and `export pure circuit`s get none (checked with compiler 0.31.1).
   - Make helpers non-exported, or make them `pure` where the logic doesn't touch the ledger.
   - Merge near-duplicate entry points into one circuit with a selector argument.
   - Re-run the diagnostic.

   *Trade-off:* changes the contract API; merged circuits may cost more to prove.
2. **Batched deploy: deploy a subset, then insert the remaining keys.** Use
   [`scripts/batch-deploy.ts`](scripts/batch-deploy.ts); see
   [`batch-deploy.NOTES.md`](scripts/batch-deploy.NOTES.md) for setup. The user runs it
   **locally** with their own providers; nobody else ever handles their keys.
   1. **Dry run first** (the default). It runs the constructor locally, builds the full deploy tx,
      then shrinks the tx to as many circuits as fit within **60%** of the block limits, taken in
      order (`priorityCircuits` first, then compiled order; it stops at the first that doesn't
      fit). It prints the plan and submits nothing.
   2. **Execute** (`execute: true`).
      - **Batch 1:** the subset deploy. The CMA signing key, and the initial private state if the
        contract has one, are saved to the private state provider under the new address
        **before** submitting, and the address is printed.
      - **Batches 2..N:** `submitInsertVerifierKeyTx` runs once per remaining circuit,
        sequentially. On-chain state is re-checked before each insert.
      - Live timing was about **18 s per insert** (3 blocks). The 40-circuit contract was 1 deploy
        (14 circuits) plus 26 inserts, about 8 minutes in total.
   3. **If it is interrupted**, re-run with `contractAddress: '<printed address>'`. It compares the
      on-chain operations with the compiled circuits and inserts only the missing ones; live, it
      resumed at 17/40. It stops if a circuit on chain has a *different* key, or is missing from
      the compiled build; either means the contract was recompiled. See the caveats below.
      **Not sure whether batch 1 landed** (the call hung, or the process died while waiting)?
      Don't re-run with `execute: true` yet: that samples a new nonce and deploys a second
      partial contract. First do a dry run with `contractAddress: '<printed address>'`. If it
      throws `no contract state on chain`, nothing landed; check again after a few blocks in case
      the tx is still pending, then re-run *without* `contractAddress`. Otherwise it prints the
      resume plan.
   4. **When all keys are in**, use `findDeployedContract()` as normal.

   *Trade-off:* 1 + (N − fit) transactions, each paying DUST fees, and they must run one after
   another (see the caveats).
3. **Split into several contracts.** Move groups of circuits into separate contracts that call each
   other or share state by design.

   *Trade-off:* this is a redesign, with cross-contract calls and shared-state concerns. It is only
   worth it if the contract would keep growing.
4. **Optimization, not in the script: several inserts per maintenance tx.** The ledger accepts many
   `VerifierKeyInsert`s in one `MaintenanceUpdate` (tested in `ledger/tests/maintenance.rs` around
   lines 325–345). About 10 keys fit per tx at 60% headroom, since each costs a flat ~2.9 KB of
   `bytesWritten`. midnight-js 4.1.1 has **no API** for this, so you would have to sign the update
   yourself with the tagged CMA key. Only do it if the transaction count really matters.

### Operational caveats (read before `execute: true`)

- **The CMA signing key is the only way to finish the deploy.** It lives in the private state
  provider under the contract address (`getSigningKey(address)`). If it is lost after batch 1, the
  missing circuits can **never** be added and you have to redeploy. Back up the private state store,
  or pass your own `signingKey` and keep it safe. Never send it to anyone.
- **Until all keys are in, the contract is partly usable.** Seen live:
  - Circuits from batch 1 and circuits already inserted can be called normally.
  - Calling a circuit that has no key yet fails **in the SDK, before submission**, with
    `Operation '<circuit>' is undefined for contract state ...`. If you bypass the SDK, the ledger
    rejects it with `VerifierKeyNotPresent` (113).
  - `findDeployedContract()` throws `ContractTypeError`:
    `Following operations: c17, ..., c39, are undefined or have mismatched verifier keys ...`.
    This is because `verifyContractState` requires every compiled circuit on chain
    (`packages/contracts/src/find-deployed-contract.ts` lines 120–135 and 271–274).
  - To call circuits before everything is in, build the interface directly with
    `createCircuitCallTxInterface(providers, compiledContract, address, privateStateId)`.
  - Use `priorityCircuits` to deploy admin, pause or initialisation circuits first. Don't announce
    the address until the final insert has landed.
- **Batches must run in order, one at a time.** Each maintenance update signs the current CMA
  counter, which goes up by one on success. A second update that is in flight at the same time
  lands **on chain as a partial success, and its fee is still paid**, with
  `the signed counter for ... did not match the expected one; likely replay attack` (108). Don't
  run two copies of the script against the same address.
- **An insert never overwrites a key.** Inserting a circuit that already has a key is a partial
  success with `the verifier key for <c> version V3 was already present` (107), and the fee is
  still paid. The script's on-chain check before each insert avoids this. To *change* a key, run
  `submitRemoveVerifierKeyTx` first and then insert.
- **Recompiling in the middle of a deploy changes the keys.** If you recompile (for example with a
  new compiler version) between batches, the keys already on chain won't match the new ones. If a
  circuit was removed or renamed, the old one stays on chain with no counterpart in the new build.
  The script refuses to continue in either case. Either finish with the original build artefacts,
  or remove the stale circuits with `submitRemoveVerifierKeyTx` and re-insert any that changed
  (each remove costs one more maintenance tx). `findDeployedContract()` alone would not catch a
  leftover circuit: it only checks that every compiled circuit is on chain.
- **A wrong CMA key is rejected up front** (`InvalidCommitteeSignature` / well-formedness failure).
  No fee is paid, but nothing progresses.
- **The address is only known at execute time.** It includes a random nonce, so the dry-run
  address is **not** the real one. Use the address printed by the `execute: true` run.
- **If batch 1 is rejected** (1010, or any submission error), nothing is on chain. The CMA key
  (and private state) the script stored under that unused address is harmless. Lower
  `budget.headroom` and re-run *without* `contractAddress`.
- **If you don't know whether batch 1 landed** (hang, killed process), don't re-run with
  `execute: true` blindly: you'd deploy a second partial contract next to the first. Dry-run with
  `contractAddress: '<printed address>'` first, as in step 3 above.

## Upstream follow-ups

- [servicedesk#225](https://github.com/midnightntwrk/servicedesk/issues/225) (bug): wallet SDK
  hides node RPC 1010 ("Transaction would exhaust the block limits") behind a generic
  `Transaction submission error`; the hang seen once is noted there as unreproduced.
- [servicedesk#226](https://github.com/midnightntwrk/servicedesk/issues/226) (feature): a
  `deployContract` option to deploy a subset of circuits, a multi-insert maintenance API, and
  optionally an SDK-level batched deploy.

## Reference material

- **Source** (refs in the header):
  - midnight-js `packages/contracts/src/`:
    - `unproven-deploy-tx.ts` (`createUnprovenDeployTxFromVerifierKeys`)
    - `utils/ledger-utils.ts` (`createUnprovenLedgerDeployTx`, which is not exported)
    - `submit-tx.ts` (prove → balance → submit)
    - `submit-deploy-tx.ts`
    - `deploy-contract.ts`
    - `governance/submit-insert-vk-tx.ts`
    - `governance/unproven-tx.ts`
    - `find-deployed-contract.ts`
  - compact-js `src/effect/ContractExecutable.ts`: `initialize`, `addOrReplaceContractOperation`,
    `createSignedMaintenanceUpdate`, `createMaintenanceAuthority`.
  - midnight-ledger `ledger/src/`:
    - `structure.rs` (`ContractDeploy`, `SingleUpdate`, `MaintenanceUpdate`, and the fee/normalize
      logic around lines 1840–1860)
    - `verify.rs` (deploy and maintenance well-formedness)
    - `semantics.rs` (applying updates)
    - `error.rs` (display strings)
  - midnight-ledger tests: `ledger/tests/maintenance.rs`.
  - midnight-node:
    - `res/<net>/ledger-parameters-config.json` (limits)
    - `runtime/src/lib.rs` (`NORMAL_DISPATCH_RATIO`, `BlockWeights`)
    - `pallets/midnight/src/lib.rs` (`get_tx_weight`, `check_weight`)
    - `ledger/src/ledger_8/mod.rs` (`get_transaction_cost`, `scale_normalized_cost`)
    - `ledger/src/ledger_{8,9}/types.rs` (error codes)
- **Local stack used for live verification:** midnight-js `testkit-js/compose.yml`, using the
  images from `testkit-js/env/mainnet.env` at `v4.1.1` (Docker Hub `midnightntwrk/*`), with the
  genesis seed `...0001` as the funded wallet.
- **SDK tests to crib from:**
  - midnight-js `packages/contracts/src/test/governance/*.test.ts`
  - `testkit-js/testkit-js-e2e/test/contracts.snarkupgrade*.it.test.ts` (live insert and remove of
    keys)
- **Changelog context:** compact-js #182 ("Add contract maintenance operations to
  `ContractExecutable`"). At compile date there is **no** upstream batch-deploy feature, PR or
  issue in midnight-js or compact-js.
- **Related, but a different problem:**
  [WalletFacade balance/finalization hang](../wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md),
  where the CPU is pinned and memory grows rather than the deploy being rejected.
