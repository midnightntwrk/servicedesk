---
title: "Toolchain and package version mismatch"
when_to_use: "A contract compiles, then fails on import, while midnight-js builds the deploy, or at the proof server, because the compiler, runtime, midnight-js, wallet SDK or proof server isn't the set the network runs, or the contract and midnight-js load different on-chain runtime copies."
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-05"
last_reviewed: "2026-11-25"
error_strings:
  - "EraMismatchError"
  - "ledger8-deploy-on-ledger9-network"
  - "ledger8-maintenance-on-ledger9-network"
  - "ledger9-artifact-on-ledger8-network"
  - "unknown-artifact-runtime-version"
  - "ledger8-artifacts-in-ledger9-container"
  - "no ZK artifact manifest (compiler/contract-manifest.json) was found"
  - "Version mismatch: compiled code expects"
  - "Failed to configure constructor context with coin public key"
  - "expected instance of ContractMaintenanceAuthority"
  - "does not provide an export named 'Clock'"
  - "Usage: compactc.bin <flag> ..."
review_when:
  - "A network leaves the ledger 9 set, or a new ledger era starts: re-check the Symptom table, Remediation 2 and 6, and the script's era rules."
  - "midnight-js changes how it refuses a contract (EraMismatchError reasons) or drops the ledger 8 path: re-check Symptom and Remediation 6."
  - "A compiler release changes the ZKIR format or removes a flag: re-check Remediation 5 and the usage-line row."
---

# Runbook: Toolchain and package version mismatch

A contract compiles, then fails on import, while midnight-js builds the deploy, or at the proof server, because part of the stack isn't the support matrix's set for the network. Usually a pre-fork project still has the ledger 8 set, or a partial upgrade mixed the two. Find the part with one read-only script, then pin the matrix set and recompile.

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported**, **inferred** or **not tested** has none, so trust it less.

## Symptom

Nothing has been submitted yet. **Measured**: each row was reproduced unless it says otherwise; the notes under Reference material record how.

| If you see | Go to |
|---|---|
| `EraMismatchError` with reason `ledger8-deploy-on-ledger9-network` or `ledger8-maintenance-on-ledger9-network` (the second **not tested**) | Diagnose 1, Remediation 1 and 2 |
| `EraMismatchError` with reason `ledger9-artifact-on-ledger8-network` | Diagnose 1 with `--rpc`, and check the app's indexer URL, where midnight-js reads the era. Both right: Stop and escalate |
| `EraMismatchError` with reason `unknown-artifact-runtime-version` (compilers 0.33 to 0.35) | Remediation 2 |
| `EraMismatchError` with reason `unwrapped-ledger9-contract`: a bare contract instance with a ledger 9 build | Wrap it with `CompiledContract.make`, as the message says |
| `EraMismatchError` with reason `ledger8-artifacts-in-ledger9-container`: the ZK config provider serves a ledger 8 build | Point the provider at the ledger 9 output (Remediation 2); Remediation 6 only for a ledger 8 build you meant to use |
| `ZkArtifactIntegrityError: no ZK artifact manifest (compiler/contract-manifest.json) was found` | Ledger 9 build: serve its `compiler/` from the same base as `keys/` and `zkir/`. Ledger 8 build: Remediation 6 |
| `CompactError: Version mismatch: compiled code expects X, runtime is Y` on import | X isn't the matrix runtime: Remediation 1 and 2 together. X is: Remediation 1 and 3 |
| `ContractConfigurationError: Failed to configure constructor context with coin public key`: midnight-js 4 with a newer contract | Remediation 1 and 2 |
| `Error: expected instance of ContractMaintenanceAuthority` (reproduced with midnight-js 4 only) | Remediation 3 |
| `SyntaxError: … does not provide an export named 'Clock'` from `wallet-sdk-utilities` | Remediation 4 |
| `Failed Proof Server response: url="…/check", code="400"`, body `bad input` (the `/check` text is from source) | Diagnose 1 with `--proof-server`, then Remediation 5. Versions match: [proof server runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/proof-server-proving-failures-runbook/proof-server-proving-failures-runbook.md), Remediation 4 |
| The compiler prints only `Usage: compactc.bin <flag> ...`, and the command passes `--feature-zkir-v3`, which 0.36 removed | Remediation 5 |

Any other `EraMismatchError` reason: its message names the fix, so follow it first.

### Not this runbook

- **`bad input` with matching versions.** Not a version: see the [proof server runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/proof-server-proving-failures-runbook/proof-server-proving-failures-runbook.md), Remediation 4.
- **The usage line with no `--feature-zkir-v3`.** A wrong flag or a missing output directory: the command is `compact compile <src> <out>`.
- **`Internal error (please report)` from the compiler.** A compiler crash ([servicedesk#130](https://github.com/midnightntwrk/servicedesk/issues/130)): Stop and escalate.
- **The compiler rejects the source.** See the [compile errors runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md).
- **The node rejects a submitted transaction** (`1010`). See the [1010 runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-1010-custom-error-runbook/node-1010-custom-error-runbook.md).

## Root cause

The matrix lists one set per network. Five couplings turn a part outside that set into an error:

1. **The compiled contract pins its runtime.** The compiler writes `checkRuntimeVersion('<version>')` into `contract/index.js`; on import it throws unless the installed `compact-runtime` has the same minor and a patch at least as new.
2. **midnight-js pins an era per runtime.** It reads `runtime-version` from `compiler/contract-info.json` and places each runtime minor on a ledger era. A runtime it doesn't place is refused; midnight-js 4 knows only the ledger 8 runtime.
3. **midnight-js 5 checks the era against the network** (from the indexer's protocol version) before proving. It refuses a new deploy or maintenance update of a ledger 8 build on a ledger 9 network, but still allows calls to a contract deployed before the fork (**not tested**).
4. **The on-chain runtime's classes are checked with `instanceof`.** The contract and midnight-js must load the same physical copy, even of the same version.
5. **Wallet SDK packages and the proof server ship as sets.** A facade from one release with utilities from another fails at load; a proof server that can't read the ZKIR format the compiler writes answers `bad input` (from source).

## Before you start

- **You need** Node 20 or later, the DApp directory with its installed `node_modules`, the compiler output directory, and which network you deploy to.
- **Safety.** Diagnose only reads files and asks for versions; nothing is signed or submitted. The script reads a Blockfrost project id only from `BLOCKFROST_PROJECT_ID` and never prints it. Remediation changes dependencies: commit first, and review the lockfile diff.

## Diagnose

1. **Which part differs from the matrix?** `<out>` is the second argument you gave `compact compile`, the directory with `contract/`, `compiler/` and `zkir/`.

   ```sh
   mkdir -p /tmp/check-versions
   curl -fsSL -o /tmp/check-versions/check-versions.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/toolchain-version-mismatch-runbook/scripts/check-versions.mjs
   node /tmp/check-versions/check-versions.mjs --network <mainnet|preview|preprod> --project <dapp dir> --compiled <out>
   ```

   Add `--proof-server http://localhost:6300` to check the proof server, and `--rpc <node RPC URL>` to check the node's ledger. Only a Blockfrost `--rpc` URL needs `BLOCKFROST_PROJECT_ID`.

   Expect exit 0. Exit 2 means a `MISMATCH` (shown to break, or can't load), each with a fix under "What to do". `DIFFERS` is untested, not shown to break: move it to the matrix, but look elsewhere for the cause. Exit 1 means it couldn't run (for example no `node_modules`), never a verdict. Yarn Plug'n'Play skips the package rows. With `--rpc`, a node on another era than `--network` means the wrong network or URL.

   A `WARN` "ledger 8 build: calls to pre-fork contracts only" is fine only for Remediation 6; otherwise recompile.

2. **By hand, if you can't run it:**

   ```sh
   compact compile --version
   grep -o "checkRuntimeVersion([^)]*)" <out>/contract/index.js
   grep '"runtime-version"' <out>/compiler/contract-info.json
   npm ls @midnight-ntwrk/compact-runtime @midnight-ntwrk/onchain-runtime-v3 {@midnight-ntwrk,@midnightntwrk}/onchain-runtime-v4
   npm ls {@midnight-ntwrk,@midnightntwrk}/{midnight-js-contracts,wallet-sdk,wallet-sdk-facade,wallet-sdk-utilities}
   head -c 40 <out>/zkir/*.bzkir
   curl -s http://localhost:6300/version
   ```

   Compare each value with your network's column on the [support matrix](https://docs.midnight.network/relnotes/support-matrix). Two copies of the on-chain runtime or `compact-runtime` under different paths is coupling 4, except midnight-js 5's own `compact-runtime-ledger8` copy (use `pnpm why` or `yarn why` on those managers). In the `.bzkir` header, `ir-source[v2]` is a build from before 0.36, and `ir-source[v3]` without `-generic` is 0.31.1 with `--feature-zkir-v3`, which the matrix proof server rejects (Remediation 5). `--skip-zk` writes no `.bzkir`.

3. **Everything matches and it still fails?** Not this runbook: Stop and escalate.

## Remediation

1. **Pin the matrix set exactly.** Take versions from the matrix (the check prints the set), not `npm view` or an unpinned install, which give whatever `latest` is. Use exact versions in `package.json` and commit the lockfile. Coming from midnight-js 4, follow midnight-js's [v5.0.0 migration guide](https://github.com/midnightntwrk/midnight-js/blob/main/docs/releases/v5.0.0/migration-guide.md). Match the runtime and the contract to the matrix, not to each other: do it with Remediation 2.

   *Trade-off:* re-run the check whenever the matrix moves.

2. **Recompile with the matrix compiler.** `compact update <version>`, then `compact compile +<version> <src> <out>`, and rebuild every artefact: an old build keeps its runtime. For Remediation 6, keep 0.31.1 beside the default with `compact update 0.31.1 --no-set-default`.

   *Trade-off:* a contract already deployed from a ledger 8 build keeps its ledger 8 keys until a maintenance update with the new build.

3. **Give the contract and midnight-js one on-chain runtime.** Install `@midnight-ntwrk/compact-runtime` once, where both resolve it (usually the workspace root), not inside the generated contract package. If a dependency pulls another copy, force one with `overrides` (yarn: `resolutions`), reinstall, and confirm with `npm ls`. With midnight-js 5, its own `compact-runtime-ledger8` copy is expected: leave it.

   *Trade-off:* an override forces a version a dependency didn't ask for.

4. **Install the wallet SDK as one set, from one scope.** Use the `wallet-sdk` umbrella at the matrix version, from one npm scope. For `Clock` (facade 4.1.0), update `wallet-sdk-utilities` to 1.2.1 or later and drop any pin holding 1.2.0 ([servicedesk#88](https://github.com/midnightntwrk/servicedesk/issues/88)).

   *Trade-off:* none beyond a reinstall.

5. **Match the proof server to the compiler.** Run the proof server version the matrix lists (`curl -s <proof server>/version` shows yours; the [proof server runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/proof-server-proving-failures-runbook/proof-server-proving-failures-runbook.md) shows how to start it), and drop `--feature-zkir-v3` from build scripts: 0.36 always writes ZKIR v3 and rejects the flag, and a 0.31.1 build with it can't be proved.

   *Trade-off:* it moves every project sharing that proof server.

6. **Call a contract deployed before the fork, on Mainnet or Preprod.** Preview relaunched as a new chain, so its old contracts are gone: recompile and redeploy. A contract deployed while its network was on ledger 8 can still be called with its ledger 8 build; a new deploy or maintenance update needs a ledger 9 build. From midnight-js 5 a ledger 8 build needs `NodeZkConfigProvider(dir, { verify: 'require-if-present' })`, since compiler 0.31.1 writes no manifest, and `new Contract(witnesses)`, not a `CompiledContract`. Lay out its dependencies as the migration guide's "Dependencies of a ledger 8 contract" says. The check then reports the build as `WARN` and exits 0. **Not tested**: a call to a real pre-fork contract.

   *Trade-off:* the contract keeps its ledger 8 keys until a ledger 9 build and a maintenance update.

## Confirm fixed

- The check exits 0 for your network, run with `--proof-server` if you prove locally.
- Import no longer throws `Version mismatch`, and `npm ls` shows one on-chain runtime path for the contract.
- Each Symptom error you had is gone: the deploy or call reaches the proof server and `/check` answers without `400`.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- The check exits 0, and one of the Symptom errors still appears.
- An `EraMismatchError` survives the fix its message or the Symptom table gives.
- A deploy error that doesn't name a version (`coinPublicKey`, `ContractMaintenanceAuthority`) survives Remediation 1 to 3: add it to [servicedesk#236](https://github.com/midnightntwrk/servicedesk/issues/236).
- A source in Key identifiers disagrees with its row and no step covers that.

Never edit the generated `contract/index.js`, `contract-info.json` or manifest to get past a refusal. Include the check's output, the network, and the full error. Remove any project id first.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). [check-runbook.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/authoring/check-runbook.mjs) tests every row daily against each source's newest version, or the npm version a row pins. For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| Every network's compiler (ledger 9), read from each entry's `version` field | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"component": "Compact toolchain"` `"version": "0.36.1"` |
| Every network's Compact runtime | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"component": "Compact runtime"` `"version": "0.21.0"` |
| Every network's midnight-js | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"tag": "v5.0.1", "npmPackage": "@midnight-ntwrk/midnight-js"` |
| Every network's proof server | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"tag": "proof-server-9.0.2"` |
| Preprod is on ledger 9, like Mainnet and Preview | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `Preprod network node (ledger 9)` |
| Preview relaunched as a new chain | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `Preview relaunched as a new chain` |
| midnight-js 5 places runtime 0.16 on ledger 8 and 0.21 on ledger 9, and no other | `github:midnightntwrk/midnight-js/packages/contracts/src/internal/era.ts` | `'0.16': 'v8'` `'0.21': 'v9'` |
| The EraMismatchError reasons in the Symptom table | `github:midnightntwrk/midnight-js/packages/contracts/src/errors.ts` | `'ledger8-deploy-on-ledger9-network'` `'ledger8-maintenance-on-ledger9-network'` `'ledger9-artifact-on-ledger8-network'` `'unknown-artifact-runtime-version'` `'ledger8-artifacts-in-ledger9-container'` `'unwrapped-ledger9-contract'` |
| A missing manifest is refused unless the provider is told otherwise | `github:midnightntwrk/midnight-js/packages/utils/src/zk-artifact-manifest.ts` | `no ZK artifact manifest (` `'require-if-present'` |
| The runtime's import check and its message | `npm:@midnight-ntwrk/compact-runtime/dist/version.js` | `export const checkRuntimeVersion` `Version mismatch: compiled code expects` |
| The ledger 8 contract layout, with the pinned on-chain runtime | `github:midnightntwrk/midnight-js/docs/releases/v5.0.0/migration-guide.md` | `### Dependencies of a ledger 8 contract` `to 3.1.2 (the version the framework is tested` |
| Deploy errors that don't name the cause, still open | `issue:midnightntwrk/servicedesk#236` | `open` |

## Reference material

- **Measurements:** [check-versions.NOTES.md](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/toolchain-version-mismatch-runbook/scripts/check-versions.NOTES.md): every reproduction, the script's test runs, and what was not reproduced.
- **Worked case:** [servicedesk#105](https://github.com/midnightntwrk/servicedesk/issues/105) (two runtime copies).
- **Script:** [scripts/check-versions.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/toolchain-version-mismatch-runbook/scripts/check-versions.mjs) compares a project with the matrix for one network, and signs nothing.
