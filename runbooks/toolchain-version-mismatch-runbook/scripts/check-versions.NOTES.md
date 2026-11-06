# Notes: `check-versions.mjs`

What the script checks, how each symptom in the
[version-mismatch runbook](../toolchain-version-mismatch-runbook.md) was reproduced, and how the
script was tested. **The user runs it** against their own DApp repo.

## What the script checks

| Row | Source | `MISMATCH` when |
|---|---|---|
| Compact devtools | `compact --version` | never (`DIFFERS` only) |
| Compact compiler (default) | `compact compile --version` | never: `WARN`, because a build can pin `+<version>`; the compiled-contract rows decide |
| Compact runtime | every physical copy, plus the copies the project root, the contract and midnight-js resolve | a **loaded** copy fails the runtime's own version rule against the matrix runtime; other copies are `WARN` |
| On-chain runtime (v3) | every copy of `@midnight-ntwrk/onchain-runtime-v3` | never: two copies are normal with the matrix set |
| On-chain runtime (v4) | every copy of `@midnightntwrk/onchain-runtime-v4` | never: `WARN`, it comes with runtime 0.19+ |
| Compact JS, Platform JS, Midnight.js, testkit-js, DApp Connector API, Wallet SDK | every physical copy | never (`DIFFERS` only) |
| Wallet SDK via testkit-js | testkit-js installed with wallet-sdk 1.1.0 | never: `INFO` |
| midnight-js-* packages, Wallet SDK scopes | all copies | never: `WARN` |
| wallet-sdk-utilities | utilities resolved from each `wallet-sdk-facade` 4.1.0 | it resolves to 1.2.0 |
| Ledger (ledger-v8) | every physical copy | never: `INFO`, or `WARN` for several versions |
| Compiled contract wants runtime | `checkRuntimeVersion(…)` in `<out>/contract/index.js` (any quote style) | the matrix runtime wouldn't satisfy it |
| Runtime the contract loads | the copy Node resolves from `<out>/contract` | none, or one that fails the runtime's rule |
| Contract and midnight-js share the on-chain runtime | the on-chain runtime each side's `compact-runtime` depends on, resolved from it | different directories (different copies or different packages) |
| ZKIR format | header of `<out>/zkir/*.bzkir` | `ir-source[v3…]`; `SKIP` when there's no `.bzkir` (a `--skip-zk` build) |
| Proof server | `GET <url>/version` | never (`DIFFERS` only) |
| Node build, Node ledger | RPC `system_version`, `midnight_ledgerVersion` | never: `INFO`; `WARN` if a ledger copy differs in minor version |

The runtime's own version rule is copied from `compact-runtime` `dist/version.js`: same major;
while the major is 0, the same minor; a patch at least as new; prerelease suffixes ignored.

Package discovery walks `<project>/node_modules`, follows symlinks to their real directories
(npm and pnpm workspaces, `file:` links), and reads pnpm's `.pnpm` and Yarn's `.store`. Each real
directory is counted once. Copies outside every `node_modules` (a contract package that isn't
linked in) are only found through `--compiled`. Yarn Plug'n'Play is detected and skipped.

Each expected version comes from the network entry's `version` field, or, in matrix copies from
before midnight-docs `f0d3fdc` (2026-10-09), from the version at the end of its `tag`.

If the matrix has no `Compact toolchain` or `Compact runtime` entry for the network, the script
stops with exit 1 rather than compare against nothing. The same goes for a `--project` with no
`node_modules` (unless it's Yarn Plug'n'Play): every package check depends on it, so carrying on
would print a false clean result. Empty argument values are rejected. Unreadable files and
directories become `WARN` rows; they never turn into a `MISMATCH` or a crash.

## Verified before hand-off (2026-10-05)

Machine: macOS x86_64, Node 20.19.1 (Node 24.20.0 for the local network), Docker 28.0.4.
Contract: a one-circuit counter (`export circuit increment(): [] { round.increment(1); }`).

### Reproductions

1. **Runtime check.** Compiled with 0.31.1, 0.34.0 and 0.35.0 and imported with runtimes 0.16.0,
   0.19.0 and 0.20.0. Each compiler loaded only with its own runtime (0.16.0, 0.19.0, 0.20.0);
   every other pair threw `CompactError: Version mismatch: compiled code expects X, runtime is Y`
   at import.
2. **Through midnight-js 4.1.1.** A harness called `createUnprovenDeployTxFromVerifierKeys` with a
   real `NodeZkConfigProvider` (offline: no proof, no signing, no submit).

   | Layout | Result |
   |---|---|
   | One runtime, 0.31.1 contract | OK |
   | Contract package with its own `compact-runtime` 0.16.0 and its own `onchain-runtime-v3` 3.1.2 | `Error: Unexpected error: Error: expected instance of ContractMaintenanceAuthority` |
   | Own `compact-runtime` 0.16.0, sharing midnight-js's `onchain-runtime-v3` | OK |
   | Own `compact-runtime` 0.16.0 and own `onchain-runtime-v3` 3.0.0 (same version as midnight-js's) | `expected instance of ContractMaintenanceAuthority` |
   | 0.34.0 contract with its own runtime 0.19.0 (on `onchain-runtime-v4` 4.0.0-rc) | `ContractConfigurationError: Failed to configure constructor context with coin public key`, cause `TypeError: Cannot read properties of undefined (reading 'coinPublicKey')` |
   | 0.35.0 contract after an unpinned `npm i @midnight-ntwrk/compact-runtime` (0.20.0) | the same `coinPublicKey` error |
   | 0.31.1 contract in that same project | `Version mismatch: compiled code expects 0.16.0, runtime is 0.20.0` |
   | The matrix set (midnight-js 4.1.1 + `compact-runtime` 0.16.0 + wallet-sdk 1.2.0), with two `onchain-runtime-v3` copies (3.0.0 and 3.1.2) | OK |

   So the copy that has to be shared is `onchain-runtime-v3`, not `compact-runtime`.
3. **Wallet SDK.** `wallet-sdk-facade@4.1.0` loads with `wallet-sdk-utilities` 1.2.1 (today's
   fresh install). With utilities forced to 1.2.0 through npm `overrides`: `SyntaxError: The
   requested module '@midnight-ntwrk/wallet-sdk-utilities' does not provide an export named
   'Clock'`.
4. **Proof server 8.1.0** (`midnightntwrk/proof-server:8.1.0`, local). `GET /version` → `8.1.0`.
   `POST /k` with each compiler's normal `.bzkir` (`ir-source[v2]`): `5`, HTTP 200. With
   `--feature-zkir-v3`, from 0.31.1 (`ir-source[v3]`) and from 0.34.0 (`ir-source[v3-generic]`):
   `Unsupported ZKIR version`, HTTP 400. The `.zkir` JSON instead of `.bzkir`: the same 400. Not run
   through midnight-js: from source, `/check` and `/prove` wrap the same error as `bad input`, and
   midnight-js reports `Failed Proof Server response: url="…", code="400", status="Bad Request"`.
5. **Ledger vs node** (`midnight-local-dev` 902561d, headless funding: a real NIGHT transfer and a
   DUST registration per run).

   | Node image (reported build) | Node ledger | Client ledger | Result |
   |---|---|---|---|
   | `1.0.0` (`1.0.0-8af7d08a`) | 8.1.0 | 8.1.0 | both accepted |
   | `1.0.0` | 8.1.0 | 8.1.3 (npm `overrides`) | both accepted |
   | `1.0.400` (`1.0.400-87c0fbdb`) | 8.1.3 | 8.1.0 | both accepted |

   The live networks reported `1.0.400-c338b9ac` and ledger `8.1.2` on the same day, so that
   image was a different build from what the networks run.

**Not reproduced:** `servicedesk#54`'s `1010 … Custom error: 168`. An 8.0.x client against an
8.1.x node was not tested: the only 8.0.x setup at hand (`midnight-local-dev` 8db3b06) also
changes the node, indexer and wallet SDK generation, so a failure couldn't be pinned on the
ledger. Contract deploy and call transactions were not submitted on the local network.

### Script test runs

On Node 20.19.1 unless noted. "Compiler WARN" appears in every run on this machine (its default
compiler is 0.34.0) and is left out below.

| Project | Expected | Exit | Flagged |
|---|---|---|---|
| Matrix set, no `--compiled` | no mismatch | 0 | on-chain runtime 2 copies, `DIFFERS` |
| 0.31.1 contract + runtime 0.16.0 | no mismatch | 0 | — |
| 0.34.0 contract + runtime 0.16.0 | mismatch | 2 | contract wants 0.19.0; contract loads 0.16.0 |
| Contract package with its own runtime and on-chain runtime | mismatch | 2 | on-chain runtime not shared |
| Own runtime, shared on-chain runtime | no mismatch | 0 | — |
| Own runtime and own on-chain runtime, same versions | mismatch | 2 | on-chain runtime not shared |
| 0.34.0 contract with its own runtime 0.19.0 | mismatch | 2 | loaded runtime 0.19.0; contract wants 0.19.0 |
| Unpinned `compact-runtime`, no `--compiled` | mismatch | 2 | loaded runtime 0.20.0 |
| 0.35.0 contract, unpinned runtime | mismatch | 2 | loaded runtime; contract wants 0.20.0; v3 vs v4 on-chain runtime |
| facade 4.1.0 + utilities 1.2.0 | mismatch | 2 | `wallet-sdk-utilities` |
| facade 4.1.0, fresh install | no mismatch | 0 | — |
| ZKIR v3 output | mismatch | 2 | ZKIR format v3 |
| Real pnpm install, healthy / with `compact-runtime@latest` | 0 / mismatch | 0 / 2 | — / loaded runtime 0.20.0 |
| Real pnpm workspace (root and member) | no mismatch | 0 | unused 0.20.0 copy `WARN` |
| Real Yarn classic | no mismatch | 0 | two ledger versions `WARN` |
| Real Yarn Plug'n'Play | no verdict | 0 | packages `SKIP` |
| Real Yarn `nodeLinker: pnpm` with 0.20.0 and 0.16.0 | mismatch | 2 | loaded runtime 0.20.0 |
| Real npm workspaces (two layouts) | per layout | 2 / 0 | loaded 0.20.0 / unused 0.20.0 `WARN` |
| `npm link`ed runtime 0.20.0 | mismatch | 2 | loaded runtime 0.20.0 |
| `--compiled` through a symlink, or with different letter case | no mismatch | 0 | — |
| Runtime 0.16.1, or 0.16.0-rc.0, for a 0.16.0 contract | no mismatch | 0 | — |
| Runtime pin in double quotes | checked | 0 | pin found |
| Unreadable `index.js`, `.bzkir`, scope folder, `node_modules`; `.bzkir` that is a folder | no crash | 0 | `WARN` rows |
| Wrong runtime plus an unreadable `.bzkir` | mismatch | 2 | mismatches kept, `.bzkir` `WARN` |
| Unrelated tool nesting runtime 0.20.0 | no mismatch | 0 | unused copy `WARN` |
| Matrix with `Compact runtime` renamed, missing for the network, no components, `null` | could not run | 1 | one message |
| Live proof server 8.1.0 + live preprod RPC | no mismatch | 0 | node `1.0.400-c338b9ac`, ledger 8.1.2 |
| Proof server not running | no mismatch | 0 | proof server `WARN` |
| No `--network`, bad `--network`, missing or file `--project`, missing `--compiled`, unknown flag, flag without value, empty value (`--compiled ""`, `--rpc ""`), bad URL, unreadable `--matrix` | could not run | 1 | message (plus the usage line where useful) |
| Run from a directory with no `node_modules`, without `--project` | could not run | 1 | "pass --project" |
| Unreadable `zkir/` directory on a 0.34.0 contract | mismatch | 2 | both real mismatches kept, unreadable path `WARN` |
| `--skip-zk` build | no mismatch | 0 | ZKIR `SKIP` |
| 0.31.1 contract with an unpinned runtime 0.20.0 | mismatch | 2 | loaded runtime; contract loads 0.20.0; v4 vs v3 on-chain runtime (fix text names the unpinned install) |
| Stub RPC answering `result: null`, or a `null` body | no mismatch | 0 | node `WARN` bad response |
| Stub proof server answering 200 with HTML | no mismatch | 0 | proof server `WARN` no version |
| `--matrix <local file>` | works offline | 0 | — |
| `BLOCKFROST_PROJECT_ID` set, Blockfrost refusing | no key in output | 0 | node `WARN` HTTP 403 |

The Blockfrost success path (a valid token) was not tested. In review on #237, the script and the
facts were re-checked independently on Linux with Node 24.16.0.

## Re-checked 2026-11-04 (toolchain 0.36.0, `compact-runtime` 0.21.0)

Toolchain 0.36.0 was released on 2026-11-04 and `compact-runtime` 0.21.0 became npm `latest` on
2026-11-03. Machine: macOS x86_64, Node 24.20.0, Docker 28.0.4. Same one-circuit counter.

1. **The script could not run against the live matrix.** midnight-docs `f0d3fdc` (2026-10-09)
   moved each version into a `version` field and set most `tag`s to `null` (the toolchain's became
   `compactc-v0.31.1`). The script read only `tag`, so every run since then stopped with exit 1:
   `the support matrix has no 'Compact runtime' version for preprod`. It now reads `version` and
   falls back to `tag`; runs against the live matrix and against the 2026-10-01 copy
   (`a7a9cfe`) give the same expected versions.
2. **Runtime check.** Compiled with 0.31.1, 0.35.0 and 0.36.0 (`checkRuntimeVersion('0.16.0')`,
   `('0.20.0')`, `('0.21.0')`) and imported with runtimes 0.16.0, 0.20.0 and 0.21.0. Each loaded
   only with its own runtime; the other six pairs threw `CompactError: Version mismatch: compiled
   code expects X, runtime is Y`, including `expects 0.16.0, runtime is 0.21.0` for 0.31.1.
3. **Through midnight-js 4.1.1** (the same offline `createUnprovenDeployTxFromVerifierKeys`
   harness). A 0.31.1 contract with the stack's own runtime: OK. After an unpinned
   `npm i @midnight-ntwrk/compact-runtime` (0.21.0, on `@midnightntwrk/onchain-runtime-v4`
   4.0.0-rc.5): a 0.36.0 contract gives `ContractConfigurationError: Failed to configure
   constructor context with coin public key`, cause `TypeError: Cannot read properties of undefined
   (reading 'coinPublicKey')`; a 0.31.1 contract gives `Version mismatch: compiled code expects
   0.16.0, runtime is 0.21.0`.
4. **ZKIR.** 0.36.0 writes `midnight:ir-source[v3-generic]` with no flag (0.31.1 and 0.35.0 still
   write `[v2]`). `compact compile +0.36.0 --feature-zkir-v3 …` prints only the `Usage: compactc.bin
   …` line and exits 1. Proof server 8.1.3 (`midnightntwrk/proof-server:8.1.3`, the matrix
   version now): `POST /k` with the 0.31.1 `.bzkir` → `5`, HTTP 200; with the 0.36.0 `.bzkir` →
   `Unsupported ZKIR version`, HTTP 400.
5. **Script runs** (preprod unless noted):

   | Project | Expected | Exit | Flagged |
   |---|---|---|---|
   | Empty `node_modules`, live matrix (before the fix) | could not run | 1 | no `Compact runtime` version |
   | Empty `node_modules`, live matrix / 2026-10-01 matrix | no mismatch | 0 / 0 | compiler `WARN` |
   | 0.36.0 contract, unpinned runtime 0.21.0 | mismatch | 2 | loaded runtime 0.21.0; contract wants 0.21.0; v4 vs v3 on-chain runtime; ZKIR v3 |
   | 0.31.1 contract, unpinned runtime 0.21.0 | mismatch | 2 | loaded runtime; contract loads 0.21.0; v4 vs v3 on-chain runtime |
   | 0.31.1 contract, no runtime added (preprod and preview) | no mismatch | 0 | — |
   | 0.31.1 contract with `--feature-zkir-v3`, mainnet / 2026-10-01 matrix | mismatch | 2 | ZKIR v3; the fix names proof server 8.1.3 / 8.1.0 |
   | Matrix with the runtime's `version` removed | could not run | 1 | no `Compact runtime` version |

   The ZKIR row's note and fix now say that 0.36 writes v3 without a flag, take the proof server
   version from the matrix, and point at `compact compile +<matrix compiler>`.

Not re-run: the wallet SDK, ledger-vs-node and package-manager layouts above. Nothing they depend
on changed in the matrix or on npm `latest`.

### npm `latest` moved again (2026-11-06)

midnight-js 5.0.0, compact-js 3.0.0, testkit-js 5.0.0, wallet SDK 2.0.0 (both scopes) and
`wallet-sdk-facade` 5.0.0 became npm `latest` on 2026-11-05 and 2026-11-06; `onchain-runtime-v4`
4.0.0 on 2026-11-04. midnight-js 5.0.0 pins `compact-runtime` 0.21.0 and 0.16.0 (as
`compact-runtime-ledger8`), `ledger-v8` 8.1.3 and `ledger-v9` 1.0.0, and its deploy functions take
a `MidnightConfig` and have separate ledger 8 and ledger 9 overloads. The support matrix still
lists midnight-js 4.1.1 and wallet SDK 1.2.0. The runbook's table and wording were updated; none of
the reproductions above were re-run on 5.0.0.

## Re-verify when versions move

- The matrix: component names (`Compact runtime`, `Compact toolchain`, …) and the `version`
  field (or, in older copies, the `tag` format `toolchain-0.31.1`) are what the script looks up.
- Which runtime each compiler pins (`checkRuntimeVersion` in the compiled `contract/index.js`),
  and which on-chain runtime package each `compact-runtime` depends on.
- What midnight-js pins: `compact-runtime`, `compact-js`, `onchain-runtime-v3`, `ledger-v8`
  (`npm view @midnight-ntwrk/midnight-js-protocol@<v> dependencies`). When midnight-js 5.0.0
  (today's `rc`, on runtime 0.20.0, `onchain-runtime-v4` and the ledger-9 line) ships and a
  network moves to it, the runtime and on-chain runtime expectations here change with it.
- `wallet-sdk-facade` / `wallet-sdk-utilities` pairing, which scope's `latest` is current, and
  what testkit-js pins.
- The proof server's ZKIR support (`POST /k` with a `.bzkir` from the new compiler) and the
  `ZKIR format` row's hard-coded v2.
- The upstream issues linked in the runbook.
