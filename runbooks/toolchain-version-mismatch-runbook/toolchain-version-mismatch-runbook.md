# Runbook: Toolchain and package version mismatch ("Version mismatch: compiled code expects …", `EraMismatchError`)

A contract compiles, and then fails before anything reaches the network: on import, while
`deployContract` builds the deploy, or at the proof server. Some part of the stack isn't the set
the target network runs. Since the ledger 9 fork the networks don't run the same set: Mainnet and
Preview are on ledger 9 (compiler 0.36.0, midnight-js 5.0.0), Preprod is still on ledger 8
(compiler 0.31.1, midnight-js 4.1.1). npm `latest` and a plain `compact update` give the ledger 9
set, which is right for Mainnet and Preview and wrong for Preprod, and a project built before the
fork has the ledger 8 set, which can no longer deploy to Mainnet or Preview. Use this runbook to match
the error to the cause, confirm it with one read-only script, and pin the project to its network's
set.

_Compiled 2026-10-05 from local reproductions; re-checked 2026-11-04 for toolchain 0.36.0;
reworked 2026-11-07 for the ledger 9 fork, with the `EraMismatchError`s reproduced against the live
Preview and Preprod indexers using providers that throw if touched, so nothing was proved or sent
(method and results in [`scripts/check-versions.NOTES.md`](scripts/check-versions.NOTES.md)).
Sources, pinned:_

- _support matrix: `midnight-docs` `docs/relnotes/support-matrix.json` at
  `f52df4d3f8` (2026-11-06, "Preview reset to a new ledger 9 chain, Preprod stays on ledger 8")_
- _midnight-js `v5.0.0` (`39725c71dc5c7681b0a424efae01afcb23107b1c`): `packages/contracts/src/errors.ts`
  (`EraMismatchError` and its reasons), `packages/contracts/src/internal/era.ts` (which runtime is
  which era), `docs/releases/v5.0.0/migration-guide.md`; and `v4.1.1`
  (`5f8a5d14247cb238b52187f33ed31695a5fde85d`)_
- _midnight-ledger `ledger-8.1.0` (`d89e0b6334f83bc9477152fb5edf7eca71660237`)_
- _npm `@midnight-ntwrk/compact-runtime` 0.16.0, 0.19.0, 0.20.0 and 0.21.0; compilers 0.31.1,
  0.34.0, 0.35.0, 0.36.0 (`compactc-v0.36.0`, `b5d9e4dfc532fe47011c4f6296e254f4853eb469`)_
- _proof server 8.1.0 and 8.1.3 (local)_
- _live node RPC and indexers on preview, preprod and mainnet_

_Versions move with every release: re-check them before asserting anything._

---

## Symptom

Each error below was reproduced unless marked otherwise. They all happen before anything is
submitted. Know which network you deploy to first; the right versions depend on it.

- **midnight-js 5 refuses the contract with `EraMismatchError`** (→ Remediation 1 and 2). Each
  message names its `reason`. Raised before anything is proved; midnight-js reads the network's
  ledger from the indexer first.

  ```text
  EraMismatchError: A contract produced by the ledger 8 (pre-fork) Compact toolchain cannot be deployed to a network that has crossed the fork. …
  ```

  Reason `ledger8-deploy-on-ledger9-network`: a contract built by 0.31.1, deployed to Mainnet or
  Preview. (Reason `ledger8-maintenance-on-ledger9-network` is the same for a maintenance update;
  not reproduced.)

  ```text
  EraMismatchError: This contract was produced by the ledger 9 Compact toolchain, but the network is still on ledger 8, which cannot execute it. …
  ```

  Reason `ledger9-artifact-on-ledger8-network`: a contract built by 0.36.0, deployed to Preprod.

  ```text
  EraMismatchError: These artifacts declare a compact-runtime this version of midnight-js places on no ledger era, … The artifacts declare compact-runtime 0.20.0.
  ```

  Reason `unknown-artifact-runtime-version`: a contract from compilers 0.33 to 0.35. Reason
  `ledger8-artifacts-in-ledger9-container`: a 0.31.1 build wrapped in `CompiledContract.make`; pass
  `new Contract(witnesses)` for a ledger 8 build instead (Remediation 6).
- **midnight-js 5 refuses a 0.31.1 build's artifacts** (→ Remediation 6):

  ```text
  ZkArtifactIntegrityError: no ZK artifact manifest (compiler/contract-manifest.json) was found; integrity verification is required. …
  ```

  `NodeZkConfigProvider` checks the artifacts against `compiler/contract-manifest.json` by default,
  and 0.31.1 doesn't write one.
- **Importing the compiled contract throws** (→ Remediation 1 and 2):

  ```text
  CompactError: Version mismatch: compiled code expects 0.19.0, runtime is 0.16.0
  ```

  The contract was compiled for one runtime and another is installed. Each compiler pins one:
  0.31.1 → 0.16.0, 0.34.0 → 0.19.0, 0.35.0 → 0.20.0, 0.36.0 → 0.21.0. An unpinned runtime install
  gets npm `latest` (0.21.0), so a 0.31.1 contract for Preprod fails the same way.
- **`deployContract` fails with an error that doesn't mention versions** (→ Remediation 1 and 2):

  ```text
  ContractConfigurationError: Failed to configure constructor context with coin public key
    [cause]: TypeError: Cannot read properties of undefined (reading 'coinPublicKey')
  ```

  midnight-js 4.1.1 with a contract from 0.34, 0.35 or 0.36 and the runtime it asks for: 4.1.1 is
  built for runtime 0.16. A 0.36.0 contract needs midnight-js 5.0.0, on Mainnet or Preview.
- **Deploy construction fails** (→ Remediation 3):

  ```text
  Error: Unexpected error: Error: expected instance of ContractMaintenanceAuthority
  ```

  The contract and midnight-js reach two copies of `@midnight-ntwrk/onchain-runtime-v3`, even of
  the same version, typically a contract package with its own `node_modules` (`servicedesk#105`).
  Reproduced with midnight-js 4.1.1 only.
- **The app fails at module load** (→ Remediation 4):

  ```text
  SyntaxError: The requested module '@midnight-ntwrk/wallet-sdk-utilities' does not provide an export named 'Clock'
  ```

  `wallet-sdk-facade` 4.1.0 with `wallet-sdk-utilities` 1.2.0 (`servicedesk#88`), from a lockfile
  or override holding 1.2.0.
- **Proving fails at the proof server** (→ Remediation 5):

  ```text
  Failed Proof Server response: url="http://…/check", code="400", status="Bad Request"
  ```

  The body says `bad input`: ZKIR v3 circuits (0.36.0 always, older compilers with
  `--feature-zkir-v3`) sent to proof server 8.1.x, Preprod's, which can't read them; 9.0.0 can.
  Reproduced on `/k` (`Unsupported ZKIR version`); the `/check` text is from source.
- **The compiler prints only its usage line** (→ Remediation 2 and 5):

  ```text
  Usage: compactc.bin <flag> ... <source-pathname> <target-directory-pathname>
         --help displays detailed usage information
  ```

  A build script passes `--feature-zkir-v3` to compiler 0.36.0, which removed the flag. The
  message doesn't name the flag; the exit code is 1.
- **Not this runbook:** `bad input` with ZKIR v2 and matching versions (`servicedesk#81`, a
  malformed request); compiler crashes (`Internal error (please report)`, `servicedesk#130`).

## Root cause

**Each network runs one set, and npm `latest` is only one of them.** The support matrix lists the
set tested against each network. Since the ledger 9 fork on 2026-11-06 there are two:

| Component | Mainnet and Preview (ledger 9) | Preprod (ledger 8) |
|---|---|---|
| Compact compiler (`compact list`, not npm) | 0.36.0 | 0.31.1 |
| `@midnight-ntwrk/compact-runtime` | 0.21.0 | 0.16.0 |
| `@midnight-ntwrk/compact-js` | 3.0.0 | 2.5.1 |
| On-chain runtime | `@midnightntwrk/onchain-runtime-v4` 4.0.0 | `@midnight-ntwrk/onchain-runtime-v3` 3.0.0 |
| `@midnight-ntwrk/platform-js` | 3.0.0 | 2.2.4 |
| `@midnight-ntwrk/midnight-js-*` | 5.0.0 | 4.1.1 |
| `@midnight-ntwrk/testkit-js` | 5.0.0 | 4.1.1 |
| Wallet SDK | `@midnightntwrk/wallet-sdk` 2.0.0 | `@midnight-ntwrk/wallet-sdk` 1.2.0 |
| DApp Connector API | 4.1.0 | 4.0.1 |
| Proof server (`midnightntwrk/proof-server`) | 9.0.0 | 8.1.3 |

npm `latest` and a plain `compact update` give the left column. A project started from npm today
fails on Preprod; a project built before the fork can't deploy on Mainnet or Preview. One build of
a contract can't serve both: compile it once with 0.31.1 for Preprod and once with 0.36.0 for
Mainnet and Preview.

Five couplings turn the drift into errors:

1. **The compiled contract pins its runtime.** The compiler writes
   `checkRuntimeVersion('<version>')` into `contract/index.js`. While the runtime is `0.x`, it
   throws unless the installed runtime has the same minor and a patch at least as new
   (`compact-runtime` `dist/version.js`).
2. **midnight-js pins the runtime too.** midnight-js 4.1.1 brings `compact-runtime` 0.16.0 on
   `onchain-runtime-v3`; runtimes 0.19 to 0.21 (compilers 0.34 to 0.36) run on
   `onchain-runtime-v4`, which 4.1.1 can't use (the `coinPublicKey` error). midnight-js 5.0.0
   carries both: 0.21.0, and 0.16.0 under the alias `compact-runtime-ledger8`. It picks a ledger
   path from `runtime-version` in `compiler/contract-info.json`, and knows only 0.16 (ledger 8)
   and 0.21 (ledger 9).
3. **The on-chain runtime's classes are checked with `instanceof`.** The contract and midnight-js
   must reach the **same physical copy** of the on-chain runtime (`ContractMaintenanceAuthority`
   lives there). Two copies are normal with Preprod's set (midnight-js pins 3.0.0,
   `compact-runtime` accepts `^3.0.0`) and work as long as both sides reach the same one.
4. **Wallet SDK packages ship as a set.** `wallet-sdk-facade` 4.1.0 imports `Clock`, which only
   `wallet-sdk-utilities` 1.2.1 and later export, but the 1.2.0 umbrella accepts `^1.2.0`. The
   packages are published under `@midnight-ntwrk/` and `@midnightntwrk/`; both scopes' `latest` is
   2.0.0, the Mainnet and Preview set. testkit-js 4.1.1 pins wallet-sdk 1.1.0.
5. **midnight-js 5 checks the contract against the network before proving.** It reads the
   network's protocol version from the indexer (`queryLatestProtocolVersion`). It refuses a
   ledger 9 contract on a ledger 8 network, and a new deploy or maintenance update of a ledger 8
   contract on a ledger 9 network. Calls to a ledger 8 contract deployed before the fork are still
   allowed. That's the `EraMismatchError` family.

**Not a cause in these reproductions: a ledger patch difference** (an era difference is, coupling
5). Clients on ledger 8.1.0 and 8.1.3 both worked against one local node; `servicedesk#54`'s
`Custom error: 168` (8.0.3 client, 8.0.2 node) wasn't reproduced. To see what a node runs, query it
(Key identifiers below).

## Key identifiers

The daily facts check tests the rows below. They hold the matrix values this runbook and
`check-versions.mjs` rely on, so a change to the matrix's format or versions shows up there. If a
source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| Preprod's compiler (ledger 8), read from each entry's `version` field | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"component": "Compact toolchain"` `"version": "0.31.1"` |
| Mainnet's and Preview's compiler (ledger 9), read the same way | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"component": "Compact toolchain"` `"version": "0.36.0"` |
| Preprod's Compact runtime | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"component": "Compact runtime"` `"version": "0.16.0"` |
| Mainnet's and Preview's Compact runtime | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"component": "Compact runtime"` `"version": "0.21.0"` |
| midnight-js 5 places runtime 0.16 on ledger 8 and 0.21 on ledger 9, and no other | `github:midnightntwrk/midnight-js/packages/contracts/src/internal/era.ts` | `'0.16': 'v8'` `'0.21': 'v9'` |

- **Support matrix:** page `https://docs.midnight.network/relnotes/support-matrix`;
  machine-readable `midnight-docs/docs/relnotes/support-matrix.json`
  (`components[].versions.<network>.version`, e.g. `0.31.1`. Copies from before 2026-10-09 have
  only `tag`, e.g. `toolchain-0.31.1`; the tag is often `null` now).
- **npm package for each matrix component:** the matrix names it, per network where it differs
  (`versions.<network>.npmPackage`, else the component's `npmPackage`); the Root cause table has
  them. Ledger (not in the matrix): `ledger-v8` and `ledger-v9`, under either scope.
- **Compiled output:** `<out>/contract/index.js` contains `checkRuntimeVersion('<version>')`, and
  `<out>/compiler/contract-info.json` has `"runtime-version"`, which is what midnight-js 5 reads.
  0.35.0 and 0.36.0 also write `compiler/contract-manifest.json`; 0.31.1 doesn't.
  `<out>/zkir/*.bzkir` starts with `midnight:ir-source[v2]`; with `--feature-zkir-v3` it is
  `[v3]` (0.31.1) or `[v3-generic]` (0.34, 0.35). 0.36.0 always writes `[v3-generic]`.
- **Toolchain:** `compact compile --version` (default compiler), `compact compile +<version> …`
  (one build with a specific compiler), `compact list`.
- **Proof server:** `GET /version` (plain text, e.g. `9.0.0`); midnight-js calls `POST /check`
  and `POST /prove`.
- **Node RPC (JSON-RPC):** `midnight_ledgerVersion` (`=8.1.2` on Preprod; on Mainnet and Preview
  `1.0.1 (tag: crate-ledger-9.1.0.1, …)`, where the ledger is the `crate-ledger-` part) and
  `system_version` (`1.0.400-c338b9ac` on Preprod's public endpoint, `2.1.101-913ec011` on Mainnet
  and Preview). Blockfrost's Preprod RPC reports `2.1.101-913ec011` and ledger `8.1.3`.
  midnight-js 5 reads the ledger from the indexer's `protocolVersion` (2001100 on ledger 9). For
  official endpoints and Blockfrost, see the
  [Blockfrost migration runbook](../indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md).

## Diagnose (no API key)

1. **Run the check.** It needs Node >= 20, no install, and only reads files. `<out>` is the
   compiler output directory: the second argument you gave `compact compile`, the one with
   `contract/`, `keys/` and `zkir/` (e.g. `contracts/managed/counter`).

   ```sh
   mkdir -p /tmp/check-versions
   curl -fsSL -o /tmp/check-versions/check-versions.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/toolchain-version-mismatch-runbook/scripts/check-versions.mjs
   node /tmp/check-versions/check-versions.mjs --network <mainnet|preview|preprod> --project <dapp dir> --compiled <out>
   ```

   `--network` is the network you deploy to: the script takes that network's set from the matrix
   and knows its ledger era. Pass `--compiled`: the contract checks, including whether the contract and midnight-js share
   one on-chain runtime, need it. Optional: `--proof-server http://localhost:6300` and
   `--rpc <node RPC URL>` (for Blockfrost, `export BLOCKFROST_PROJECT_ID=…` first; the key is
   never printed).

   Exit code: 0 = no mismatch found, 2 = at least one `MISMATCH`, 1 = it could not run.
   `MISMATCH` marks a combination shown to break or one that can't load; `DIFFERS` means "not the
   tested version" without evidence that it breaks. Each `MISMATCH` comes with a fix under
   "What to do". Example, a contract still built by 0.31.1 in a midnight-js 5.0.0 project, checked
   for Mainnet (real output, trimmed):

   ```text
   component                                            installed                 matrix         status
   Compact runtime                                      2 copies: 0.21.0, 0.16.0  0.21.0         OK        0.16.0 is midnight-js 5's ledger 8 copy
   On-chain runtime (v4)                                4.0.0                     4.0.0          OK
   …
   Midnight.js                                          5.0.0                     5.0.0          OK
   …
   Compiled contract wants runtime                      0.16.0                    0.21.0         WARN      ledger 8 build: calls to pre-fork contracts only
   Runtime the contract loads                           0.21.0                    0.16.0         MISMATCH
   ZKIR format                                          v2                        v3             DIFFERS   built by a compiler before 0.36
   …
   RESULT: 1 mismatch(es). See the runbook for the matching error text.
   ```

   Its fix names `ledger8-deploy-on-ledger9-network` and says to recompile with 0.36.0.

   In the "Runtime the contract loads" row, the matrix column shows the runtime the contract
   wants. With `--rpc`, the script also warns when the node runs a different ledger era from the
   `--network` set, which usually means the wrong network or RPC URL. If `--project` has no `node_modules`, the script stops with exit 1 rather than report a
   clean result. Yarn Plug'n'Play projects have no `node_modules` either; the script says so and
   skips the package checks.
2. **By hand, if you can't run it:**

   ```sh
   compact compile --version                                  # default compiler
   grep -o "checkRuntimeVersion([^)]*)" <out>/contract/index.js
   grep '"runtime-version"' <out>/compiler/contract-info.json    # 0.16.0 = ledger 8, 0.21.0 = ledger 9
   npm ls @midnight-ntwrk/compact-runtime @midnight-ntwrk/onchain-runtime-v3 @midnightntwrk/onchain-runtime-v4   # or pnpm why / yarn why
   head -c 40 <out>/zkir/*.bzkir      # ir-source[v2] for Preprod (proof server 8.1.x); 0.36.0 writes [v3-generic] (full build; --skip-zk writes no .bzkir)
   curl -s http://localhost:6300/version
   ```

   Compare each value with the matrix for your network.
3. **If everything matches and it still fails,** it isn't this runbook. Open an issue at the
   [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) and
   include the script's output.

## Remediation

1. **Pin your network's set exactly.** Take it from the matrix for the network you deploy to (the
   table under Root cause has both sets at the last check):
   - **Mainnet and Preview:** `@midnight-ntwrk/compact-runtime` 0.21.0, every
     `@midnight-ntwrk/midnight-js-*` 5.0.0, `@midnightntwrk/wallet-sdk` 2.0.0, testkit-js 5.0.0.
     Coming from 4.1.1, follow midnight-js's v5.0.0 migration guide.
   - **Preprod:** `@midnight-ntwrk/compact-runtime` 0.16.0, every `@midnight-ntwrk/midnight-js-*`
     4.1.1, `@midnight-ntwrk/wallet-sdk` 1.2.0, testkit-js 4.1.1. npm `latest` is the other set for
     every one of these, so name each version.

   Use exact versions in `package.json` and commit the lockfile. Take versions from the matrix, not
   from `npm view <pkg> version` or an unpinned install, which give `latest`. **Don't match the
   runtime to the contract:** match both to the matrix, and do this together with step 2, or the
   `coinPublicKey` error comes back as `Version mismatch`.

   *Trade-off:* upgrades become deliberate; re-run the check whenever the matrix moves. A DApp for
   both Preprod and Mainnet needs midnight-js 5.0.0 (the matrix tests 4.1.1 on Preprod) and a
   contract build per ledger; on Preprod the check then reports midnight-js 5's own 0.21.0 as `WARN`.
2. **Recompile with your network's compiler.** `compact compile +0.36.0 <src> <out>` for Mainnet
   and Preview, `compact compile +0.31.1 <src> <out>` for Preprod. Install them side by side with
   `compact update <version> --no-set-default`; a bare `compact update` makes the newest release
   your default (0.36.0 at the last check). Rebuild every artefact: old builds keep the runtime
   they were built for. Contracts from 0.33 to 0.35 have no network: rebuild them with 0.36.0.
   Source that only compiles with 0.36.0 can't go to Preprod until Preprod moves to ledger 9.

   *Trade-off:* each ledger's compiler has its own features: 0.31.1 has no cross-contract calls,
   and 0.36.0 output only runs on ledger 9.
3. **Give the contract and midnight-js one on-chain runtime.** Install
   `@midnight-ntwrk/compact-runtime` once, where both resolve it (usually the workspace root), and
   not inside the generated contract package. If a dependency pulls another copy, force one with
   npm `overrides` (yarn `resolutions`, pnpm `overrides`), reinstall, and check with `npm ls`
   (`pnpm why` / `yarn why`). Review the lockfile diff rather than deleting the lockfile. With
   midnight-js 5, its own `compact-runtime-ledger8` copy (0.16.0) is expected; leave it.

   *Trade-off:* an override forces a version a dependency didn't ask for; re-run the check after
   upgrading that dependency.
4. **Install the wallet SDK as one set, from one scope.** Use the `wallet-sdk` umbrella at the
   matrix version rather than individual packages, and don't mix `@midnight-ntwrk/` and
   `@midnightntwrk/`. For the `Clock` error (wallet SDK 1.2.0 set), update `wallet-sdk-utilities`
   to 1.2.1 or later and drop any pin holding it at 1.2.0.

5. **Match the proof server to the ZKIR the compiler writes.** With `--proof-server`, the check
   reports ZKIR v3 circuits with a proof server before 9.0.0 as `MISMATCH`. On Preprod, compile with 0.31.1
   without `--feature-zkir-v3` (ZKIR v2) and run `midnightntwrk/proof-server:8.1.3`. On Mainnet and
   Preview, 0.36.0 writes ZKIR v3 only and rejects the flag; run `midnightntwrk/proof-server:9.0.0`.

   *Trade-off:* on Preprod, anything that needs ZKIR v3 (for example contract-to-contract calls,
   per `servicedesk#130`) waits for Preprod's ledger 9 upgrade.
6. **A ledger 8 contract on a ledger 9 network.** A contract deployed to Mainnet before the fork
   can still be called with its 0.31.1 build; a new deploy or a maintenance update needs a 0.36.0
   build. Calling it from midnight-js 5 needs `NodeZkConfigProvider(dir, { verify:
   'require-if-present' })`, since 0.31.1 writes no `contract-manifest.json` (reproduced), and
   runtime 0.16.0 for the 0.31.1 module, on the same `onchain-runtime-v3` copy as midnight-js 5's
   ledger 8 runtime. Use the layout in the midnight-js 5.0.0 migration guide ("Dependencies of a
   ledger 8 contract"): the contract in a workspace package depending on
   `@midnight-ntwrk/compact-runtime@0.16.0`, with `onchain-runtime-v3` pinned to 3.1.2. A contract
   package with its own `node_modules` gets its own copy and fails the check's on-chain runtime row.
   Pass `new Contract(witnesses)`, not a `CompiledContract`. With that the check reports the build
   as `WARN` (calls only) and exits 0. A pre-fork call wasn't reproduced.

   *Trade-off:* the contract keeps its ledger 8 keys until a 0.36.0 build and a maintenance update.

## Upstream follow-ups

- [servicedesk#236](https://github.com/midnightntwrk/servicedesk/issues/236): midnight-js deploy
  errors that don't name the cause (`coinPublicKey`, `expected instance of
  ContractMaintenanceAuthority`).
- [midnight-docs#1494](https://github.com/midnightntwrk/midnight-docs/issues/1494): support-matrix
  `tag`, `github` and `container` fields that don't resolve.
- [midnight-wallet#791](https://github.com/midnightntwrk/midnight-wallet/issues/791): `latest` on
  the wallet SDK packages isn't the matrix version (now 2.0.0, the Mainnet and Preview set).

## Reference material

- **Reproductions:** [`scripts/check-versions.NOTES.md`](scripts/check-versions.NOTES.md): every
  reproduction, the script's test runs, and what was not reproduced.
- **Worked cases:** `servicedesk#105` (two runtime copies), `#88` (`Clock`), `#54` (`Custom
  error: 168`, not reproduced), `#81` (`bad input`), `#130` (compiler crash).
- **Source:**
  - `@midnight-ntwrk/compact-runtime` 0.16.0 `dist/version.js` (`checkRuntimeVersion`), and its
    `package.json` (`onchain-runtime-v3`) vs 0.19.0, 0.20.0 and 0.21.0 (`onchain-runtime-v4`)
  - midnight-js `v4.1.1`: `packages/contracts` (`createUnprovenDeployTxFromVerifierKeys`),
    `packages/http-client-proof-provider` (`Failed Proof Server response`)
  - midnight-js `v5.0.0`: `packages/contracts/src/errors.ts`, `internal/era.ts`,
    `packages/protocol/package.json`, `docs/releases/v5.0.0/migration-guide.md`
  - midnight-ledger `ledger-8.1.0`: `proof-server/src/endpoints.rs` and `worker_pool.rs` (`bad input`)
  - midnight-docs PR #1032 ("remove ledger from compat")
- **Support matrix:** use its versions, not its `tag` fields (midnight-docs#1494).
