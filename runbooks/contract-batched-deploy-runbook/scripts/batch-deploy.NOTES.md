# Notes: running `batch-deploy.ts`

How to set up and run the batched deploy from
[contract-batched-deploy-runbook](../contract-batched-deploy-runbook.md), and what was verified
before it was handed out. **The user runs it**, in their own DApp repo, with their own wallet and
providers. Never ask for their seed, wallet file or CMA signing key.

## Where it goes

Copy `batch-deploy.ts` into the DApp repo that already deploys the contract, next to the code that
builds `ContractProviders` and calls `deployContract`. It imports only published packages, so no
relative imports need fixing:

- `@midnight-ntwrk/midnight-js-contracts`
- `@midnight-ntwrk/midnight-js-protocol` (`/ledger`, `/compact-js`, `/compact-runtime`)
- `@midnight-ntwrk/midnight-js-types`

It was written and type-checked against **midnight-js 4.1.1**. On another version, re-check the
imports and signatures listed under "Re-verify when versions move".

## Usage

Replace the `deployContract` call with this:

```ts
import { batchDeploy } from './batch-deploy';

// 1. Dry run (default) — prints the plan, submits nothing, touches no private state.
await batchDeploy(providers, {
  compiledContract,                 // same CompiledContract you pass to deployContract
  args: [/* constructor args */],
  // privateStateId / initialPrivateState — same as deployContract, if the contract has private state
  priorityCircuits: ['pause', 'setAdmin'], // optional: deploy these first
});

// 2. Real run.
const r = await batchDeploy(providers, { compiledContract, args: [...], execute: true });

// 3. If interrupted: resume with the address printed by step 2.
await batchDeploy(providers, { compiledContract, contractAddress: '<addr>', execute: true });

// 4. Afterwards, as normal:
const contract = await findDeployedContract(providers, { compiledContract, contractAddress: r.contractAddress! });
```

Options:

- `budget` overrides the network limits. The default is `MAINNET_BUDGET`, with `headroom: 0.6`.
  Preview, preprod and qanet used the same limits at compile date. Don't raise the headroom above
  about 0.62:
  - The node's weight check lets a single tx use only about 65% of a block.
  - Live, 62.6% of `bytesWritten` was included and 68.1% was rejected with RPC 1010.
  - At 0.7 and at 0.8 the first batch was rejected: once with a thrown `Transaction submission
    error`, and once the SDK call simply hung.
- `signingKey` sets your own CMA key (see the runbook caveats).
- `log` redirects the output.

**Test on preview or preprod first.** Mainnet transactions cost real DUST.

## What the script does, precisely

1. It reads every provable circuit ID (`ContractExecutable.make(compiledContract).getProvableCircuitIds()`)
   and its key (`zkConfigProvider.getVerifierKeys`).
2. It calls the SDK's `createUnprovenDeployTx`. This runs the constructor locally and builds the
   full deploy tx, with every key, without submitting it.
3. It **rewrites that tx in place** (`restrictDeployTo`):
   - It builds a new ledger `ContractState` holding the constructor's `data`,
     `maintenanceAuthority` and `balance`, plus only the chosen operations.
   - It wraps that state in a fresh `ContractDeploy`, swaps it into the intent, and reassigns
     `tx.intents`. The tx is unproven and unbound, so the binding is recomputed.
   - The Zswap offers built by the SDK are kept unchanged, so constructor-minted coins still work.
4. It adds circuits one by one while `tx.cost(LedgerParameters.initialParameters())` and the tx
   size stay within `headroom × limit`. It compares against the limits in `budget`, not the ones
   in `initialParameters`, whose `blockUsage` is lower than mainnet's.
5. With `execute: true`:
   1. It saves the signing key (`setContractAddress` + `setSigningKey`) **before** the deploy is
      submitted.
   2. It submits with `submitTx` (the same path `submitDeployTx` uses: prove → balance → submit)
      and throws `DeployTxFailedError` on anything other than `SucceedEntirely`.
   3. It then stores the private state.
   4. It calls `submitInsertVerifierKeyTx` for each remaining circuit, one at a time.

## Verified before hand-off (2026-09-29)

### Live, on a local stack

The stack: midnight-node `0.22.1`, indexer-standalone `4.0.1` and proof-server `8.0.3`. These are
the `mainnet.env` images from midnight-js `v4.1.1` testkit, run with `CFG_PRESET=dev`, which has
the same ledger limits as mainnet. The funded wallet was built with testkit-js 4.1.1
`MidnightWalletProvider` from genesis seed `...0001`, and the contract had 40 circuits.

- **One-shot `deployContract`:** throws `(FiberFailure) Error: exceeded block limit in transaction
  fee computation`. Nothing is submitted.
- **Headroom ceiling:** subset deploys of 13 and 14 circuits (balanced `bytesWritten` 29,795 and
  31,291) were **included** (`SucceedEntirely`). 15 circuits (34,067) got RPC
  `1010 Transaction would exhaust the block limits`. Wallet balancing adds only 224 `bytesWritten`.
- **`batchDeploy` with `execute: true`, default budget, `priorityCircuits: ['c40']`:**
  - Batch 1 was 14 circuits (stopped at `c14`: 32,560 > 30,000) and was finalized in block 338.
  - Inserts of c14, c15 and c16 followed, each about 18 s apart, then a simulated crash.
- **Partial state:**
  - `findDeployedContract` threw `ContractTypeError`: "Following operations: c17, …, c39, are
    undefined or have mismatched verifier keys".
  - `c40` (batch 1) and `c15` (inserted) were called successfully.
  - `c39` (missing) failed before submission with `Operation 'c39' is undefined for contract
    state`.
- **Resume with `contractAddress`:**
  - It detected 17/40 already on chain and inserted the other 23, in blocks 372–439.
  - `findDeployedContract` then succeeded, a `c39` call returned `SucceedEntirely`, and 40
    operations were on chain.

### Offline

- `tsc --strict` type-check against the midnight-js 4.1.1 npm packages: clean.
- **Ledger simulation** (`ledger-v8` 8.1.0 `LedgerState` + `wellFormed` + `apply`, with proof and
  balance checks off and signatures checked):
  - A subset deploy from `restrictDeployTo` succeeds, with the counter at 0.
  - 24 sequential single-key updates succeed, and every on-chain key is byte-identical to the
    compiled one.
  - Stale counter → `partialSuccess` ("signed counter … did not match").
  - Duplicate insert → `partialSuccess` ("… was already present"), and the counter does not move.
  - Wrong key → rejected at well-formedness ("signature for key id 0 invalid").
- The module's own `batchDeploy`, run with stub providers:
  - The dry run calls no provider write or submit method.
  - Resume against a partial state inserts only the missing circuits.
  - A mismatched on-chain key aborts, and a missing CMA key aborts.

**Not yet verified:** preview, preprod or mainnet. The first real-network run should add its tx
hashes here.

## Re-verify when versions move

- midnight-js still exports `createUnprovenDeployTx`, `submitTx`, `submitInsertVerifierKeyTx` and
  `DeployTxFailedError` from `@midnight-ntwrk/midnight-js-contracts`.
- `deployContract` still has no batch option. If one appears upstream, use it and retire this
  script.
- Ledger `Intent.actions`, `Transaction.intents` (setter), `ContractState` (`data`,
  `maintenanceAuthority`, `balance`, `setOperation`) and `Transaction.cost` keep their shapes.
- The network limits in `midnight-node/res/<net>/ledger-parameters-config.json`, especially
  `bytesWritten`.
