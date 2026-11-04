# Runbook: Toolchain and package version mismatch ("Version mismatch: compiled code expects …")

A contract compiles, and then fails before anything reaches the network: on import, while
`deployContract` builds the deploy, or at the proof server. Some part of the stack isn't the
version the networks support. The usual way in is "latest": the newest compiler and the npm
`latest` runtime packages are ahead of every network, and coding agents reach for them by
default. Contracts from compilers 0.34, 0.35 and 0.36 target an on-chain runtime that no network
runs yet, and since 2026-11-04 a plain `compact update` installs 0.36.0. Use this runbook to match
the error to the cause, confirm it with one read-only script, and pin the project back to the
supported set.

_Compiled 2026-10-05 from local reproductions; re-checked 2026-11-04 for toolchain 0.36.0 and
`compact-runtime` 0.21.0 (method and results in
[`scripts/check-versions.NOTES.md`](scripts/check-versions.NOTES.md)). Sources, pinned:_

- _support matrix: `midnight-docs` `docs/relnotes/support-matrix.json` at
  `f0d3fdc6b799fcffaad16ab89b5aac9a88c28a0d` (2026-10-09, unchanged on 2026-11-04)_
- _midnight-js `v4.1.1` (`5f8a5d14247cb238b52187f33ed31695a5fde85d`)_
- _midnight-ledger `ledger-8.1.0` (`d89e0b6334f83bc9477152fb5edf7eca71660237`)_
- _npm `@midnight-ntwrk/compact-runtime` 0.16.0, 0.19.0, 0.20.0 and 0.21.0; compilers 0.31.1,
  0.34.0, 0.35.0, 0.36.0 (`compactc-v0.36.0`, `b5d9e4dfc532fe47011c4f6296e254f4853eb469`)_
- _proof server 8.1.0 and 8.1.3 (local)_
- _live node RPC on preview, preprod and mainnet_

_Versions move with every release: re-check them before asserting anything._

---

## Symptom

Each error below was reproduced unless marked otherwise. None needs a network: they happen
before anything is submitted.

- **Importing the compiled contract throws** (→ Remediation 1 and 2):

  ```text
  CompactError: Version mismatch: compiled code expects 0.19.0, runtime is 0.16.0
  ```

  The contract was compiled for one runtime and another is installed. Each compiler pins one:
  0.31.1 → 0.16.0, 0.34.0 → 0.19.0, 0.35.0 → 0.20.0, 0.36.0 → 0.21.0. Adding the runtime unpinned
  (`npm i @midnight-ntwrk/compact-runtime` in a project that doesn't list it yet, or `…@latest`)
  installs npm `latest` (0.21.0 at the last check), so a supported 0.31.1 contract fails the same
  way (`expects 0.16.0, runtime is 0.21.0`).
- **`deployContract` fails with an error that doesn't mention versions** (→ Remediation 1 and 2):

  ```text
  ContractConfigurationError: Failed to configure constructor context with coin public key
    [cause]: TypeError: Cannot read properties of undefined (reading 'coinPublicKey')
  ```

  The contract was compiled by 0.34, 0.35 or 0.36 and the runtime it asks for (0.19, 0.20 or 0.21)
  is installed, so it loads. midnight-js 4.1.1 is built for runtime 0.16 and can't set it up. This
  is the "upgraded everything to latest" case.
- **Deploy construction fails** (→ Remediation 3):

  ```text
  Error: Unexpected error: Error: expected instance of ContractMaintenanceAuthority
  ```

  The contract and midnight-js reach two different copies of `@midnight-ntwrk/onchain-runtime-v3`,
  even when both copies are the same version. Typical layout: a generated contract package with its
  own `node_modules` (`servicedesk#105`).
- **The app fails at module load** (→ Remediation 4):

  ```text
  SyntaxError: The requested module '@midnight-ntwrk/wallet-sdk-utilities' does not provide an export named 'Clock'
  ```

  `wallet-sdk-facade` 4.1.0 with `wallet-sdk-utilities` 1.2.0 (`servicedesk#88`). Fresh installs
  now get utilities 1.2.1; a lockfile or override still holding 1.2.0 brings it back.
- **Proving fails at the proof server** (→ Remediation 5):

  ```text
  Failed Proof Server response: url="http://…/check", code="400", status="Bad Request"
  ```

  The proof server's response body and log say `bad input`. The circuits are ZKIR v3, which proof
  servers 8.1.0 and 8.1.3 can't read. Compiler 0.36.0 always writes ZKIR v3; older compilers,
  0.31.1 included, write it with `--feature-zkir-v3`. Reproduced on the proof server's `/k`
  endpoint, which answers `Unsupported ZKIR version`; the `/check` message above is from the
  proof server and midnight-js source. A custom zk-config provider that sends the `.zkir` (JSON)
  file instead of the `.bzkir` gets the same rejection.
- **The compiler prints only its usage line** (→ Remediation 2 and 5):

  ```text
  Usage: compactc.bin <flag> ... <source-pathname> <target-directory-pathname>
         --help displays detailed usage information
  ```

  A build script passes `--feature-zkir-v3` to compiler 0.36.0, which removed the flag. The
  message doesn't name the flag; the exit code is 1.
- **Not this runbook:**
  - `400` / `bad input` from `/check` when the circuits are ZKIR v2 and the versions match
    (`servicedesk#81`): the request is malformed, for example missing the circuit's `.bzkir`.
  - Compiler crashes (`Internal error (please report)`): compiler bugs, not drift. Example:
    `servicedesk#130`, 0.33.0-rc.2 with `--feature-zkir-v3`, fixed in 0.34.0.
  - `RPC-CORE: subscribeRuntimeVersion(): … disconnected … 1000:: Normal Closure` during wallet
    sync: seen in healthy runs too.

## Root cause

**npm `latest` is not the network.** The support matrix lists the one set tested against each
network; at the last check it was the same for preview, preprod and mainnet. The newest releases
were ahead of it for the compiler and the runtime packages, level for midnight-js, and behind it
for one wallet SDK tag:

| Component | Network (matrix) | Newest release |
|---|---|---|
| Compact compiler (`compact list`, not npm) | 0.31.1 | 0.36.0 |
| `@midnight-ntwrk/compact-runtime` | 0.16.0 | 0.21.0 |
| `@midnight-ntwrk/compact-js` | 2.5.1 | 2.5.3 |
| `@midnight-ntwrk/onchain-runtime-v3` | 3.0.0 | 3.1.2 |
| `@midnight-ntwrk/platform-js` | 2.2.4 | 3.0.0 |
| `@midnight-ntwrk/midnight-js-*` | 4.1.1 | 4.1.1 (pins compact-runtime 0.16.0, compact-js 2.5.1, ledger-v8 8.1.0) |
| `@midnight-ntwrk/wallet-sdk` | 1.2.0 | `latest` tag is **1.1.0** (1.2.0 is published; `@midnightntwrk/wallet-sdk` `latest` is 1.2.0) |

Four couplings turn that drift into the errors above:

1. **The compiled contract pins its runtime.** The compiler writes
   `checkRuntimeVersion('<version>')` into `contract/index.js`. While the runtime is `0.x`, it
   throws unless the installed runtime has the same minor and a patch at least as new
   (`compact-runtime` `dist/version.js`).
2. **midnight-js pins the runtime too, and the newest runtimes are a different generation.**
   midnight-js 4.1.1 brings `compact-js` 2.5.1 and `compact-runtime` 0.16.0, which run on
   `@midnight-ntwrk/onchain-runtime-v3`. `compact-runtime` 0.19, 0.20 and 0.21 (compilers 0.34,
   0.35 and 0.36) run on `@midnightntwrk/onchain-runtime-v4`, a 4.0.0 release candidate. No
   released midnight-js can deploy those contracts. Installing the newer runtime only turns the
   version error into the `coinPublicKey` one. The midnight-js 5.0.0 release candidates (npm `rc`
   tag, 5.0.0-rc.5 at the last check) do depend on the newer runtimes (0.20.0 in
   `midnight-js-protocol`, 0.21.0-rc.0 in `midnight-js-contracts`) and `onchain-runtime-v4`, but
   they're built for the ledger-9 line, which no network runs yet, so they aren't the way out
   either.
3. **The on-chain runtime's classes are checked with `instanceof`.** `onchain-runtime-v3` owns
   WASM classes such as `ContractMaintenanceAuthority`. The contract (through its
   `compact-runtime`) and midnight-js (through `compact-js`'s `compact-runtime`) must reach the
   **same physical copy**. Two `compact-runtime` copies are fine if both reach one
   `onchain-runtime-v3`. Two `onchain-runtime-v3` copies are normal with the matrix set
   (midnight-js pins 3.0.0, `compact-runtime` accepts `^3.0.0`) and deploy construction still
   works, because both sides reach the same one.
4. **Wallet SDK packages ship as a set.** `wallet-sdk-facade` 4.1.0 imports `Clock`, which only
   `wallet-sdk-utilities` 1.2.1 and later export, but it declares utilities only as a dev
   dependency, and the `wallet-sdk` 1.2.0 umbrella accepts `^1.2.0`. The packages are published
   under two scopes, `@midnight-ntwrk/` and `@midnightntwrk/`, whose `latest` tags differ.
   testkit-js 4.1.1 pins `@midnight-ntwrk/wallet-sdk` 1.1.0, so a project that also installs the
   matrix's wallet-sdk 1.2.0 has both.

**Not a cause in these reproductions: the ledger.** The matrix doesn't list a ledger version on
purpose: it ships with the node (midnight-docs PR #1032). A local node accepted a NIGHT transfer
and a DUST registration from a client whose ledger was three patches newer, and from one three
patches older (8.1.0 and 8.1.3). Contract transactions weren't tested. `servicedesk#54` reported
`1010 … Custom error: 168` with an 8.0.3 client on an 8.0.2 node; that wasn't reproduced. To see
what a node runs, query it (Key identifiers below): image tags and the matrix's node label don't
reliably identify the build.

## Key identifiers

- **Support matrix:** page `https://docs.midnight.network/relnotes/support-matrix`;
  machine-readable `midnight-docs/docs/relnotes/support-matrix.json`
  (`components[].versions.<network>.version`, e.g. `0.31.1`. Copies from before 2026-10-09 have
  only `tag`, e.g. `toolchain-0.31.1`; the tag is often `null` now).
- **npm package for each matrix component:** Compact runtime → `@midnight-ntwrk/compact-runtime`;
  On-chain runtime → `@midnight-ntwrk/onchain-runtime-v3` (`@midnightntwrk/onchain-runtime-v4`
  for runtime 0.19+); Compact JS → `@midnight-ntwrk/compact-js`; Platform JS →
  `@midnight-ntwrk/platform-js`; Midnight.js → `@midnight-ntwrk/midnight-js-*`; testkit-js →
  `@midnight-ntwrk/testkit-js`; DApp Connector API → `@midnight-ntwrk/dapp-connector-api`; Wallet
  SDK → `@midnight-ntwrk/wallet-sdk` or `@midnightntwrk/wallet-sdk`. Ledger (not in the matrix) →
  `@midnight-ntwrk/ledger-v8`.
- **Compiled output:** `<out>/contract/index.js` contains `checkRuntimeVersion('<version>')`.
  `<out>/zkir/*.bzkir` starts with `midnight:ir-source[v2]`; with `--feature-zkir-v3` it is
  `[v3]` (0.31.1) or `[v3-generic]` (0.34, 0.35). 0.36.0 always writes `[v3-generic]`.
- **Toolchain:** `compact --version` (devtools), `compact compile --version` (default compiler),
  `compact compile +<version> …` (one build with a specific compiler), `compact list`.
- **Proof server:** `GET /version` (plain text, e.g. `8.1.0`), `GET /proof-versions`,
  `GET /health`; midnight-js calls `POST /check` and `POST /prove`.
- **Node RPC (JSON-RPC):** `midnight_ledgerVersion` (e.g. `=8.1.2`), `system_version` (build, e.g.
  `1.0.400-c338b9ac`), `state_getRuntimeVersion` (`specVersion`). The official endpoints need no
  key but are scheduled to shut down (see the
  [Blockfrost migration runbook](../indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md));
  Blockfrost's RPC needs a project token.

## Diagnose (no API key)

1. **Run the check.** It needs Node >= 20, no install, and only reads files. `<out>` is the
   compiler output directory: the second argument you gave `compact compile`, the one with
   `contract/`, `keys/` and `zkir/` (e.g. `contracts/managed/counter`).

   ```sh
   mkdir -p /tmp/check-versions
   curl -fsSL -o /tmp/check-versions/check-versions.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/toolchain-version-mismatch-runbook/scripts/check-versions.mjs
   node /tmp/check-versions/check-versions.mjs --network preprod --project <dapp dir> --compiled <out>
   ```

   Pass `--compiled`: the contract checks, including whether the contract and midnight-js share
   one on-chain runtime, need it. Optional: `--proof-server http://localhost:6300` and
   `--rpc <node RPC URL>` (for Blockfrost, `export BLOCKFROST_PROJECT_ID=…` first; the key is
   never printed).

   Exit code: 0 = no mismatch found, 2 = at least one `MISMATCH`, 1 = it could not run.
   `MISMATCH` marks a combination shown to break or one that can't load; `DIFFERS` means "not the
   tested version" without evidence that it breaks. Each `MISMATCH` comes with a fix under
   "What to do". Example, for a 0.36.0 contract with an unpinned runtime:

   ```text
   component                                            installed                 matrix   status
   Compact runtime                                      3 copies: 0.16.0, 0.21.0  0.16.0   MISMATCH
   …
   Compiled contract wants runtime                      0.21.0                    0.16.0   MISMATCH
   Runtime the contract loads                           0.21.0                    0.21.0   OK
   Contract and midnight-js share the on-chain runtime  no                        yes      MISMATCH
   ZKIR format                                          v3 (1 circuits)           v2       MISMATCH
   …
   RESULT: 4 mismatch(es). See the runbook for the matching error text.
   ```

   In the "Runtime the contract loads" row, the matrix column shows the runtime the contract
   wants. If `--project` has no `node_modules`, the script stops with exit 1 rather than report a
   clean result. Yarn Plug'n'Play projects have no `node_modules` either; the script says so and
   skips the package checks.
2. **By hand, if you can't run it:**

   ```sh
   compact compile --version                                  # default compiler
   grep -o "checkRuntimeVersion([^)]*)" <out>/contract/index.js
   npm ls @midnight-ntwrk/compact-runtime @midnight-ntwrk/onchain-runtime-v3 @midnightntwrk/onchain-runtime-v4   # or pnpm why / yarn why
   head -c 40 <out>/zkir/*.bzkir      # ir-source[v2] is what proof server 8.1.x reads (full build; --skip-zk writes no .bzkir)
   curl -s http://localhost:6300/version
   ```

   Compare each value with the matrix for your network.
3. **If everything matches and it still fails,** it isn't this runbook. Open an issue at the
   [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) and
   include the script's output.

## Remediation

1. **Pin the matrix set exactly.** At the last check, for all three networks:
   `@midnight-ntwrk/compact-runtime` 0.16.0, every `@midnight-ntwrk/midnight-js-*` 4.1.1, and
   `@midnight-ntwrk/wallet-sdk` 1.2.0 (its `latest` tag is 1.1.0, so name the version). Use exact
   versions in `package.json` and commit the lockfile. Take versions from the matrix, not from
   `npm view <pkg> version` or an unpinned install, which give `latest`. **Don't match the runtime
   to the contract:** match both to the matrix, and do this together with step 2, or the
   `coinPublicKey` error comes back as `Version mismatch`.

   *Trade-off:* upgrades become deliberate; re-run the check whenever the matrix moves.
   testkit-js 4.1.1 still brings wallet-sdk 1.1.0 with it, which the check reports as expected.
2. **Recompile with the supported compiler.** `compact compile +0.31.1 <src> <out>` builds with
   0.31.1 without changing your default; install it side by side with
   `compact update 0.31.1 --no-set-default`. A bare `compact update` makes the newest release your
   default (0.36.0 at the last check), so give it a version. Rebuild every artefact: old builds keep
   the runtime they were built for. If the contract doesn't compile with 0.31.1 (newer language features or a
   higher `pragma language_version`), it can't be deployed to any network yet; open a servicedesk
   issue rather than mixing versions.

   *Trade-off:* 0.31.1 doesn't have the newer compilers' fixes and features.
3. **Give the contract and midnight-js one on-chain runtime.** Install
   `@midnight-ntwrk/compact-runtime` once, where both resolve it (usually the workspace root), and
   not inside the generated contract package. If a dependency pulls another copy, force one with
   npm `overrides` (yarn `resolutions`, pnpm `overrides`), reinstall, and check with `npm ls`
   (`pnpm why` / `yarn why`). Review the lockfile diff rather than deleting the lockfile.

   *Trade-off:* an override forces a version a dependency didn't ask for; re-run the check after
   upgrading that dependency.
4. **Install the wallet SDK as one set, from one scope.** Use the `wallet-sdk` umbrella at the
   matrix version rather than individual packages, and don't mix `@midnight-ntwrk/` and
   `@midnightntwrk/`. For the `Clock` error, update `wallet-sdk-utilities` to 1.2.1 or later and
   drop any pin holding it at 1.2.0.

   *Trade-off:* the umbrella brings every wallet package, used or not.
5. **Compile ZKIR v2 for proof server 8.1.x.** Compile with the matrix compiler (step 2) and
   without `--feature-zkir-v3`: 0.36.0 has no ZKIR v2 output and rejects the flag. Run
   `midnightntwrk/proof-server` at the matrix's proof server version (8.1.3 at the last check).

   *Trade-off:* anything that needs ZKIR v3 (for example contract-to-contract calls, per
   `servicedesk#130`) waits for a proof server that supports it.

## Upstream follow-ups

- [servicedesk#236](https://github.com/midnightntwrk/servicedesk/issues/236): midnight-js deploy
  errors that don't name the cause (`coinPublicKey`, `expected instance of
  ContractMaintenanceAuthority`).
- [midnight-docs#1494](https://github.com/midnightntwrk/midnight-docs/issues/1494): support-matrix
  `tag`, `github` and `container` fields that don't resolve.
- [midnight-wallet#791](https://github.com/midnightntwrk/midnight-wallet/issues/791): `latest` on
  the `@midnight-ntwrk` wallet SDK packages still points at the 1.1.0 line.
- `servicedesk#88`: the `Clock` export, fixed by `wallet-sdk-utilities` 1.2.1.

## Reference material

- **Reproductions:** [`scripts/check-versions.NOTES.md`](scripts/check-versions.NOTES.md): every
  reproduction, the script's test runs, and what was not reproduced.
- **Worked cases:** `servicedesk#105` (two runtime copies, Midnight.js 4.0.4; resolved by the
  matrix set), `servicedesk#88` (`Clock` export), `servicedesk#54` (`Custom error: 168`, 8.0.3
  client on an 8.0.2 node; not reproduced), `servicedesk#81` (proof server `/check`
  `bad input`), `servicedesk#130` (0.33.0-rc.2 `--feature-zkir-v3` compiler crash).
- **Context:** the internal AI Dev Friction Report (Notion), Issue 1 "Version drift": agents reach
  for compiler and runtime versions that no network accepts. midnight-expert's `install-cli`
  installs the network-supported compiler
  (`plugins/midnight-tooling/network-supported-compiler.txt`, `midnightntwrk/midnight-expert`
  PR #262); package versions still have to come from the matrix.
- **Source:**
  - `@midnight-ntwrk/compact-runtime` 0.16.0 `dist/version.js` (`checkRuntimeVersion`), and its
    `package.json` (`onchain-runtime-v3`) vs 0.19.0, 0.20.0 and 0.21.0 (`onchain-runtime-v4`)
  - midnight-js `v4.1.1`: `packages/contracts` (`createUnprovenDeployTxFromVerifierKeys`),
    `packages/http-client-proof-provider` (`Failed Proof Server response`)
  - midnight-ledger `ledger-8.1.0`: `proof-server/src/endpoints.rs` (`/version`, `/k`, `/check`,
    `/prove`; IR errors become `WorkError::BadInput`), `proof-server/src/worker_pool.rs`
    (`bad input`), `proof-server/src/lib.rs` (`/health`)
  - midnight-docs PR #1032 ("remove ledger from compat")
- **Support matrix:** its version numbers are what this runbook relies on; its `tag`, `github` and
  `container` fields mostly don't resolve yet (midnight-docs#1494). Use the versions, not the tags.
