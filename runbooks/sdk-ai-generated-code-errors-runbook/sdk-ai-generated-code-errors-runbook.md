# Runbook: AI-written SDK code that won't install, compile or load (`has no exported member`, `No matching version found`, `checkRuntimeVersion is not a function`)

A DApp's TypeScript came from an AI assistant, or from a tutorial or template written with one,
and it fails before it does anything on chain. `npm install` can't find a version. `tsc` reports
names that don't exist. Or everything installs and compiles, and the contract fails on import.
The cause is nearly always the same: the assistant wrote against the generation of the Midnight
SDK before the one the networks run. It pins old versions, imports names that have moved or been
renamed, and fills gaps with names that never existed. Use this runbook to find every such line
with one read-only script, and to replace each one with the form the network set has.

_Compiled 2026-10-11 from a recall test and local reproductions (method and results in
[`scripts/check-sdk.NOTES.md`](scripts/check-sdk.NOTES.md)). Sources, pinned:_

- _support matrix: `midnight-docs` `docs/relnotes/support-matrix.json` at
  `5263f4045dfbfb3ec9c62fa07a8f806134ac272e` (2026-10-09)_
- _the network set, installed from npm and read from its type declarations: midnight-js 4.1.1,
  wallet SDK 1.2.0, `compact-runtime` 0.16.0, `compact-js` 2.5.1, `dapp-connector-api` 4.0.1,
  `testkit-js` 4.1.1; TypeScript 5.6.3_
- _the older generation, installed the same way: midnight-js 3.0.0, wallet SDK 1.0.0,
  `compact-runtime` 0.9.0, `dapp-connector-api` 3.0.0, `ledger-v7` 7.0.3,
  `@midnight-ntwrk/wallet` 4.0.0_
- _a corpus of 30 files written from memory by three AI models for ten everyday DApp tasks
  ([`scripts/cases/`](scripts/cases/))_
- _Midnight's own example code, for the false-positive test: `midnight-examples` `95d4f50`,
  `example-bboard` `f9df09a`, `midnight-local-dev` `902561d`, `example-counter` `273f083` (the
  last three are archived now)_

_Versions, `latest` tags and package names move with every release: re-check them before
asserting anything._

---

## Symptom

The failure shows up at one of four points. Every error below was reproduced, or is quoted from
the issue named next to it.

**`npm install`:**

| Error | Cause |
|---|---|
| `npm error notarget No matching version found for @midnight-ntwrk/compact-js@2.0.0.` | A version that was never published (→ 1) |
| `npm error 404 Not Found - GET https://registry.npmjs.org/@midnight-ntwrk%2fcompact-compiler - Not found` | A package that was never published (→ 1) |
| `… npm.pkg.github.com …: Invalid authentication (as an unknown user)` ([midnight-js#173](https://github.com/midnightntwrk/midnight-js/issues/173)) | A custom registry for the Midnight scope (→ 4) |
| Nothing: the install succeeds | An older generation, which installs fine (→ 2) |

**`tsc`, against the network set:**

| Error | Cause |
|---|---|
| `TS2307: Cannot find module '@midnight-ntwrk/wallet'` (or `ledger-v7`, `ledger`, `zswap`) | A package from the older generation (→ 2) |
| `TS2305: Module '"@midnight-ntwrk/wallet-sdk-unshielded-wallet"' has no exported member 'InMemoryTransactionHistoryStorage'.` | A name that moved to another package (→ 3) |
| `TS2724: '"@midnight-ntwrk/compact-runtime"' has no exported member named 'constructorContext'. Did you mean 'ConstructorContext'?` | A renamed name; tsc's suggestion is the type, not the function (→ 3) |
| `TS2459: Module '"@midnight-ntwrk/midnight-js-types"' declares 'FinalizedTransaction' locally, but it is not exported.` | A name that lives in another package (→ 3) |
| `TS2724: '"@midnight-ntwrk/midnight-js-contracts"' has no exported member named 'createProviders'. Did you mean 'ContractProviders'?` | An invented name (→ 3) |
| `TS2673: Constructor of class 'WalletFacade' is private and only accessible within the class declaration.` | `new WalletFacade(…)` (→ 3) |
| `TS2554: Expected 1-2 arguments, but got 0.` on `new InMemoryTransactionHistoryStorage()` | The history storage takes a schema (→ 3) |
| `TS2339: Property 'walletBalance' does not exist on type 'DustWalletState<string>'.` | An invented method (→ 3) |
| `TS2339: Property 'data' does not exist on type 'ChargedState'.` | A changed state shape (→ 3) |
| `TS2353: … 'walletProvider' does not exist in type 'Partial<LevelPrivateStateProviderConfig> & Pick<…, "privateStoragePasswordProvider" \| "accountId">'.` (or TS2345 with the same type) | The midnight-js 4 private-state config (→ 3) |
| `TS2322: Type '() => Promise<any>' is not assignable to type '() => string'.` | Async key getters on a `WalletProvider` (→ 3) |
| `TS2315: Type 'ProofProvider' is not generic.` | A type argument that 4.x dropped (→ 3) |
| `TS2307: Cannot find module './contract/out/contract/index.cjs'` | The compiler writes `index.js` (→ 3) |
| `TS2305: … has no exported member 'DAppConnectorAPI'.`, `TS2339: Property 'enable' does not exist on type 'InitialAPI'.` | The DApp connector before 4.0 (→ 5) |
| `TS2339: Property 'midnight' does not exist on type 'Window & typeof globalThis'.`, `TS2717: Subsequent property declarations must have the same type. Property 'midnight' must be of type '{ [key: string]: InitialAPI; }' …` | The connector's typings (→ 5) |

A single missing package usually brings a crowd of `TS2339: Property '…' does not exist on type
'unknown'` errors after it: in the corpus, 43 of 126 errors were these. Fix the first error in the
file, not the last.

**Node, on import or at run time:**

| Error | Cause |
|---|---|
| `TypeError: __compactRuntime.checkRuntimeVersion is not a function` | `compact-runtime` far older than the compiler (→ 2) |
| `SyntaxError: The requested module '@midnight-ntwrk/wallet-sdk-utilities' does not provide an export named 'Clock'` ([servicedesk#88](https://github.com/midnightntwrk/servicedesk/issues/88)) | Wallet SDK packages from different sets (→ 2) |
| `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@midnight-ntwrk/midnight-js-utils' imported from …` ([midnight-docs#1069](https://github.com/midnightntwrk/midnight-docs/issues/1069)) | A real package that isn't installed (→ 3) |
| `Error: unknown network ID: 109` ([midnight-wallet#162](https://github.com/midnightntwrk/midnight-wallet/issues/162)) | Old- and new-generation packages mixed (→ 2) |
| `Wallet.Other: Transaction.fromParts(...).addIntent is not a function` ([servicedesk#81](https://github.com/midnightntwrk/servicedesk/issues/81)) | `ledger-v8` pinned below what midnight-js 4.1.1 needs (→ 2) |
| `providers.privateStateProvider.setContractAddress is not a function` ([midnight-js#853](https://github.com/midnightntwrk/midnight-js/issues/853)) | A hand-written private-state provider (→ 3) |
| `TypeError: state.pendingOutputs.values.map is not a function` ([midnight-wallet#648](https://github.com/midnightntwrk/midnight-wallet/issues/648), [midnight-docs#1135](https://github.com/midnightntwrk/midnight-docs/pull/1135)) | An old shielded wallet, or Node 20 (→ 2) |

## Root cause

AI assistants learned the Midnight SDK mostly from the generation before the one the networks
run. To measure it, three models (Claude Haiku, Sonnet and Opus) each wrote ten everyday tasks
from memory: build a wallet, configure the providers, deploy, call, subscribe, connect a browser
wallet, register for DUST, transfer, unit-test a circuit, set endpoints. Every one of the 100
midnight-js versions they pinned was 3.0.0; the networks run 4.1.1. Against the network set, 27
of the 30 files fail `tsc`, with 70 errors that are SDK mistakes. The same mistakes repeat across
tasks and across models, which is what makes them worth a runbook. They fall into five groups.

1. **Packages and versions that were never published.** npm catches these at install, which makes
   them the cheapest kind.
   - **Versions:** `compact-js` 2.0.0, `compact-runtime` 0.11.0 and `ledger-v6` 6.1.0 from the
     corpus. Docs make the same mistake: `wallet-sdk-hd` 3.1.0 in
     [midnight-docs#1068](https://github.com/midnightntwrk/midnight-docs/issues/1068).
   - **Packages:** the compiler as an npm package (`@midnight-ntwrk/compact-compiler`, `compactc`,
     `compact`), `@midnight-ntwrk/zkir` (it's `zkir-v2`), anything in a `@midnight/` scope, and
     `@openzeppelin-compact/contracts-simulator` (it's `@openzeppelin/compact-simulator`).
     midnight-expert removed the compiler package and the simulator name from its own skills in
     [midnightntwrk/midnight-expert@ce137e5](https://github.com/midnightntwrk/midnight-expert/commit/ce137e55100e0e85fb7070900a1fc5a56ee9ef2f).
2. **An older generation, which installs without complaint.** This is the expensive kind: npm is
   happy, and the failure comes later.
   - **The pins.** midnight-js 3.0.0, `compact-runtime` 0.9.0, `ledger-v7` or `ledger` 4,
     `@midnight-ntwrk/wallet` (the pre-SDK `WalletBuilder` API, last published 2025-05-12) and
     `wallet-sdk-*` 1.0.0 all install. Their APIs are what the type errors in group 3 come from.
   - **The runtime check.** A contract compiled with 0.31.1 calls
     `checkRuntimeVersion('0.16.0')` on import, and `compact-runtime` 0.9.0 has no such function.
     The corpus's own pins, installed as written, fail exactly that way. A runtime that exists but
     differs gives `Version mismatch: compiled code expects …` instead; that belongs to the
     [toolchain runbook](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md).
   - **Mixing generations.** Old and new packages exchange data badly. `ledger` 4 output read by
     `zswap` 4 gives `unknown network ID: 109`, which is the `m` of `midnight:`
     ([midnight-wallet#162](https://github.com/midnightntwrk/midnight-wallet/issues/162)).
     `ledger-v8` overridden to 8.0.3 breaks the wallet SDK's `addIntent`
     ([servicedesk#81](https://github.com/midnightntwrk/servicedesk/issues/81)).
   - **Ranges that pick the past.** npm installs the `latest` tag whenever it satisfies a range,
     and some `latest` tags lag. `@midnight-ntwrk/wallet-sdk`'s `latest` is 1.1.0
     ([midnight-wallet#791](https://github.com/midnightntwrk/midnight-wallet/issues/791)), so
     `"^1.0.0"` installs 1.1.0, not 1.2.0. The sub-packages lag the same way
     (`wallet-sdk-facade` `latest` 4.0.1, the set has 4.1.0).
   - **The other scope.** The wallet SDK and a few other packages are also published as
     `@midnightntwrk/…`, whose `latest` is current. Listing both scopes installs two copies of one
     package.
   - **`pendingOutputs.values.map is not a function` has two reported causes.**
     [midnight-wallet#648](https://github.com/midnightntwrk/midnight-wallet/issues/648) (open)
     hits it with `wallet-sdk-shielded` 2.1.0 once the wallet has a pending output, and the
     network set has 3.0.2. The docs give it as the Node 20 crash signature and require Node 22
     ([midnight-docs#1135](https://github.com/midnightntwrk/midnight-docs/pull/1135)). None of the
     SDK packages declares `engines`, so npm doesn't warn.
3. **Names that moved, changed or never existed.** Each row was checked against the network
   set's type declarations; the right-hand column compiles (`scripts/cases/right-forms.ts`).

   | AI-written | In the network set |
   |---|---|
   | `MidnightProviders` from `midnight-js-contracts` | `@midnight-ntwrk/midnight-js-types` |
   | `FinalizedTransaction`, `UnprovenTransaction` from `midnight-js-types` | `@midnight-ntwrk/midnight-js-protocol/ledger` (`midnight-js-types` 2.x and earlier re-exported `UnprovenTransaction`; `WalletProvider.balanceTx` now takes an `UnboundTransaction`) |
   | `ContractAddress` from `midnight-js-types` | `@midnight-ntwrk/compact-runtime` |
   | `sampleCoinPublicKey` from `compact-runtime` | `@midnight-ntwrk/midnight-js-protocol/ledger` |
   | `InMemoryTransactionHistoryStorage` from `wallet-sdk-unshielded-wallet` (1.0.0 had it) | `@midnight-ntwrk/wallet-sdk`, as `new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries)` |
   | `ImpureCircuitId` (`compact-js` 2.4.0) | `Contract.ProvableCircuitId<C>` from `@midnight-ntwrk/compact-js` |
   | `constructorContext(…)` (`compact-runtime` 0.9.0) | `createConstructorContext(initialPrivateState, coinPublicKey)` |
   | `new WalletFacade(shielded, unshielded, dust)` | `await WalletFacade.init({ configuration, shielded: () => …, unshielded: () => …, dust: () => … })` |
   | `state.dust.walletBalance` (invented) | `state.dust.balance(new Date())` |
   | `createProviders(…)` (invented) | no such helper: build each provider (see Remediation 2) |
   | `levelPrivateStateProvider({ privateStateStoreName, walletProvider })` | `levelPrivateStateProvider({ privateStateStoreName, privateStoragePasswordProvider, accountId })` |
   | `async getCoinPublicKey()` on a `WalletProvider` | synchronous `getCoinPublicKey()` and `getEncryptionPublicKey()`, in 3.x and 4.x |
   | `ProofProvider<string>` | `ProofProvider` |
   | `ledger(ctx.currentQueryContext.state.data)` | `ledger(ctx.currentQueryContext.state)`: the state is a `ChargedState`, which `ledger()` accepts |
   | `./contract/out/contract/index.cjs` | `./contract/out/contract/index.js` (0.28.0, 0.29.0, 0.31.1 and 0.35.0 all write `index.js`) |
   | A hand-written `PrivateStateProvider` | implement `setContractAddress` too, required since midnight-js 3.1.0 ([midnight-js#853](https://github.com/midnightntwrk/midnight-js/issues/853)), or use `levelPrivateStateProvider` |

   tsc's "Did you mean" suggestions point the wrong way here. For `constructorContext` it offers
   the type `ConstructorContext`; for `ContractAddress` from `midnight-js-types` it offers
   `asContractAddress`.
4. **A custom registry.** Agents add an `.npmrc` or `.yarnrc.yml` entry that sends the Midnight
   scope to a custom registry. They likely copy it from the `.yarnrc.yml` files in SDK
   repositories, which are there for the SDK's own builds
   ([midnight-expert#22](https://github.com/midnightntwrk/midnight-expert/issues/22)). Every
   `@midnight-ntwrk` package is on public npm. Pointed at GitHub Packages, the install fails with
   `Invalid authentication`
   ([midnight-js#173](https://github.com/midnightntwrk/midnight-js/issues/173)).
5. **The DApp connector.**
   - **The API changed in 4.0.** Up to `dapp-connector-api` 3.0.0, `window.midnight.<key>` was a
     `DAppConnectorAPI` with `enable()`, which returned a `DAppConnectorWalletAPI`. In 4.0.1 it
     is an `InitialAPI`, and `connect(networkId)` returns a `ConnectedAPI`.
   - **The 4.0.1 typings don't load under NodeNext.** `dist/index.d.ts` re-exports `./api`,
     `./errors` and `./globals` without file extensions, and TypeScript's NodeNext (and Node16)
     resolution doesn't load those. With `skipLibCheck`, a common setting, every connector type is
     then silently `any`. `const c: ConnectedAPI = 42` compiles, and so does any wrong
     wallet call. Under `"moduleResolution": "bundler"`, which Vite uses, the types load and the
     mistakes show. This is fixed upstream but not released; see Upstream follow-ups for the
     status and how to check it.
   - **Conflicting declarations.** Models often add their own `declare global { interface Window
     { midnight?: { mnLace?: … } } }`. Where the package's declaration loads, any type but
     `{ [key: string]: InitialAPI }` fails with TS2717.

**Not causes, or other runbooks:**
- **A `Version mismatch` with versions that all exist** is the toolchain set, not AI drift: see
  the [toolchain runbook](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md).
- **Compact compile errors in a contract the AI wrote** are covered by the Compact compile-errors
  runbook ([servicedesk#241](https://github.com/midnightntwrk/servicedesk/pull/241), in review).
- **Indexer errors** aren't SDK errors, even when an assistant wrote the endpoint URL: see the
  [indexer migration runbook](../indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md).

## Key identifiers

- **The ledger 8 set** (the support matrix's set for every network until the ledger 9 upgrade; since
  2026-11-09 Mainnet, Preview and Preprod all use compiler 0.36.0, midnight-js 5.0.0, wallet SDK
  2.0.0 and proof server 9.0.0, which this page and its script don't cover yet): compiler 0.31.1,
  `compact-runtime` 0.16.0, `compact-js` 2.5.1, every `midnight-js-*` 4.1.1, `wallet-sdk` 1.2.0,
  `dapp-connector-api` 4.0.1, `testkit-js` 4.1.1, proof server 8.1.3.
- **Scopes.** Every package is published as `@midnight-ntwrk/…` on public npm. The wallet SDK,
  `dapp-connector-api`, `ledger-v8`, `zkir-v2` and the on-chain runtimes are also published as
  `@midnightntwrk/…`. There is no `@midnight/` scope.
- **Barrels.**
  - `@midnight-ntwrk/wallet-sdk` exports the facade, the three wallets, `HDWallet` and the
    history storage. Its subpaths are `/facade`, `/shielded`, `/unshielded`, `/dust`, `/hd`,
    `/address-format` and more.
  - `@midnight-ntwrk/midnight-js-protocol` re-exports the ledger, runtime and `compact-js` that
    midnight-js was built with: `/ledger`, `/compact-runtime`, `/compact-js`, `/onchain-runtime`.
  - `@midnight-ntwrk/midnight-js` is the midnight-js barrel (4.0.3 and later).
- **Old-generation packages still on npm:**
  - `@midnight-ntwrk/wallet` (`latest` 5.0.0) and `wallet-api`;
  - `ledger` (4.0.0), `ledger-v6`, `ledger-v7`, `zswap` (4.0.0);
  - `onchain-runtime`, `-v1`, `-v2`, and `midnight-js-testing`.
- **What the compiler writes:** `<out>/contract/index.js` and `index.d.ts`, with
  `checkRuntimeVersion('<runtime version>')` near the top (`'0.16.0'` from 0.31.1).
- **Declarations to read when in doubt** (in `node_modules/@midnight-ntwrk/`):
  - `wallet-sdk-facade/dist/index.d.ts`: `InitParams` and `static init`, with the constructor
    marked private;
  - `wallet-sdk-abstractions/dist/InMemoryTransactionHistoryStorage.d.ts`: the constructor;
  - `wallet-sdk-dust-wallet/dist/DustWallet.d.ts`: `balance(time: Date)`;
  - `midnight-js-level-private-state-provider/dist/level-private-state-provider.d.ts`: the
    config type;
  - `midnight-js-types/dist/wallet-provider.d.ts`: the key getters and
    `balanceTx(tx: UnboundTransaction, ttl?)`;
  - `compact-runtime/dist/constructor-context.d.ts` and `circuit-context.d.ts`;
  - `dapp-connector-api/dist/api.d.ts` and `globals.d.ts`.

## Diagnose (no API key)

1. **Run the checker on the project.** It needs Node 20 or later and no install, and it only
   reads files:

   ```bash
   node runbooks/sdk-ai-generated-code-errors-runbook/scripts/check-sdk.mjs <project directory>
   ```

   What it reads:
   - every `package.json`, `tsconfig*.json`, `.npmrc` and `.yarnrc(.yml)`;
   - every `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` source, skipping `node_modules`,
     `dist` and `build`.

   It compares them with `scripts/sdk-index.json`, which lists every export of the network set
   and of the generation before it, and every published version of each Midnight package. It
   reports:
   - packages and versions that don't exist, are of the older generation, or that a range
     resolves below the set;
   - mixed scopes and custom registries;
   - each imported name the network set doesn't export, with where it lives now, what it was
     renamed to, or that it looks invented;
   - the call shapes in Root cause 3 and 5;
   - a NodeNext tsconfig in a project that uses the DApp connector. If the connector is installed,
     the checker reads its `dist/index.d.ts` and stays quiet once that version has the fix.

   Workspace packages are recognised and skipped. Exit code 0 means no findings, 2 means at least
   one, and 1 means it couldn't run. On a two-file project built from one corpus answer's pins and
   its deploy script:

   ```text
   package.json:5: `@midnight-ntwrk/midnight-js-contracts` 3.0.0 is an older generation than the network set's 4.1.1; its API differs (the import findings show where). See the toolchain runbook (runbooks/toolchain-version-mismatch-runbook) for the full set to pin.
   package.json:6: `@midnight-ntwrk/compact-js@2.0.0` was never published (npm install: No matching version found). Published 2.x versions: 2.4.3, 2.5.0, 2.5.1, 2.5.3. The network set uses 2.5.1.
   package.json:7: `@midnight-ntwrk/compact-runtime` 0.9.0 is an older generation than the network set's 0.16.0; its API differs (the import findings show where). A contract from compiler 0.31.1 needs compact-runtime 0.16.0 exactly; a much older runtime fails on import with `checkRuntimeVersion is not a function`. See the toolchain runbook (runbooks/toolchain-version-mismatch-runbook) for the full set to pin.
   package.json:8: `@midnight-ntwrk/midnight-js-types` 3.0.0 is an older generation than the network set's 4.1.1; its API differs (the import findings show where). See the toolchain runbook (runbooks/toolchain-version-mismatch-runbook) for the full set to pin.
   package.json:9: `@midnight-ntwrk/wallet-sdk`: "^1.0.0" installs 1.1.0, not the network set's 1.2.0: npm installs the `latest` tag (1.1.0) whenever it fits the range, and that tag lags behind. Pin "1.2.0".
   src/deploy.ts:5: Compact 0.28 and later write the compiled contract as `contract/index.js` (an ES module), not `index.cjs`. Import `…/contract/index.js`.

   6 finding(s) in 2 of 2 file(s), against the network set (midnight-js 4.1.1, wallet SDK 1.2.0, compact-runtime 0.16.0; index 2026-10-11).
   ```

   And on one of the corpus's wallet scripts (`scripts/cases/opus/t01.ts`):

   ```text
   opus/t01.ts:10: `@midnight-ntwrk/ledger-v7` is ledger 7. The networks run ledger 8: `@midnight-ntwrk/ledger-v8` (or `@midnight-ntwrk/midnight-js-protocol/ledger`).
   opus/t01.ts:18: `InMemoryTransactionHistoryStorage` isn't exported by `@midnight-ntwrk/wallet-sdk-unshielded-wallet` (@midnight-ntwrk/wallet-sdk-unshielded-wallet 1.0.0 exported it here). Import it from `@midnight-ntwrk/wallet-sdk` or `@midnight-ntwrk/wallet-sdk-abstractions`.
   opus/t01.ts:84: `InMemoryTransactionHistoryStorage` takes a schema (TS2554 without one): `new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries)`, all three from `@midnight-ntwrk/wallet-sdk`.
   opus/t01.ts:96: `WalletFacade`'s constructor is private in wallet-sdk-facade 4.x (TS2673). Create it with `await WalletFacade.init({ configuration, shielded: () => shieldedWallet, unshielded: () => unshieldedWallet, dust: () => dustWallet })`: the three wallets are passed as functions.
   opus/t01.ts:113: The DUST wallet state has no `walletBalance`. Use `state.dust.balance(new Date())`, from `wallet.state()` or `await wallet.waitForSyncedState()`.
   ```

   On the corpus it flags the line of 68 of the 70 SDK errors `tsc` reports. The two misses are
   wallet configuration objects with missing fields, which `tsc` reports. It also flags 16 lines
   that `tsc` only reaches once an earlier error is fixed. On Midnight's own example code
   (`midnight-examples`, `example-bboard`, `midnight-local-dev`; 614 files) it reports nothing.
2. **Or paste the error.** `--explain` takes npm, tsc or Node error text and says what it means
   and what to use:

   ```bash
   node runbooks/sdk-ai-generated-code-errors-runbook/scripts/check-sdk.mjs --explain "error TS2724: '\"@midnight-ntwrk/compact-runtime\"' has no exported member named 'constructorContext'. Did you mean 'ConstructorContext'?"
   ```

   ```text
   - `constructorContext` isn't exported by `@midnight-ntwrk/compact-runtime`: compact-runtime 0.9.0 had `constructorContext`; 0.16.0 has `createConstructorContext`.
   ```

   It exits 2 for errors it doesn't know, such as Compact compiler errors.
3. **Confirm with `tsc` against the network set,** once the checker is quiet. Install the set
   (Remediation 1) and run `npx tsc --noEmit`. For browser code, typecheck with
   `"moduleResolution": "bundler"` (Root cause 5), or the connector's types are `any`. Then run
   it, starting with a contract import: the `checkRuntimeVersion` and `Version mismatch` errors
   only appear at run time.
4. **Without Node:**
   - Check each pin with `npm view @midnight-ntwrk/<package> versions dist-tags` and compare it
     with the support matrix, not with `latest`.
   - After an install, `npm ls @midnight-ntwrk/compact-runtime @midnight-ntwrk/wallet-sdk
     @midnight-ntwrk/ledger-v8` shows what actually resolved.
   - Search the code for the left-hand column of the table in Root cause 3.

## Remediation

1. **Install the network set, exactly, from one scope.** Pin the versions the matrix lists. The
   [toolchain runbook](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md),
   Remediation 1 to 4, has the full set and why. For a typical DApp:

   ```json
   {
     "dependencies": {
       "@midnight-ntwrk/compact-js": "2.5.1",
       "@midnight-ntwrk/compact-runtime": "0.16.0",
       "@midnight-ntwrk/midnight-js-contracts": "4.1.1",
       "@midnight-ntwrk/midnight-js-http-client-proof-provider": "4.1.1",
       "@midnight-ntwrk/midnight-js-indexer-public-data-provider": "4.1.1",
       "@midnight-ntwrk/midnight-js-level-private-state-provider": "4.1.1",
       "@midnight-ntwrk/midnight-js-network-id": "4.1.1",
       "@midnight-ntwrk/midnight-js-node-zk-config-provider": "4.1.1",
       "@midnight-ntwrk/midnight-js-types": "4.1.1",
       "@midnight-ntwrk/wallet-sdk": "1.2.0"
     }
   }
   ```

   - **Add what the app needs from the same set:** `dapp-connector-api` 4.0.1 and
     `midnight-js-fetch-zk-config-provider` 4.1.1 for a browser app, and `testkit-js` 4.1.1 for
     tests.
   - **Remove the older generation:** `@midnight-ntwrk/wallet`, `wallet-api`, `ledger`,
     `ledger-v6`, `ledger-v7`, `zswap`, any `onchain-runtime*`, the separate `wallet-sdk-*`
     packages (the umbrella brings them), and any `overrides` that pin `ledger-v8` below 8.1.
   - **Reinstall from scratch,** deleting `node_modules` and the lockfile. Then check with `npm ls
     @midnight-ntwrk/onchain-runtime-v3` that one copy is left.
   - **Run Node 22 or later.**

   *Trade-off:* exact pins don't pick up fixes on their own. Re-run the checker whenever the
   matrix moves.
2. **Replace each name with the network set's form.** The checker's message names it, and the
   table in Root cause 3 lists them all. Two need more than a rename:
   - **The wallet.** Build the three wallets, then pass them to `WalletFacade.init` as functions.
     Start it with the shielded and DUST secret keys before waiting for sync. The shape, as
     `midnight-examples` uses it at `95d4f50`
     ([`packages/fast-sync/src/fast-wallet.ts`](https://github.com/midnightntwrk/midnight-examples/blob/95d4f50/packages/fast-sync/src/fast-wallet.ts),
     [`scripts/fund-wallet.ts`](https://github.com/midnightntwrk/midnight-examples/blob/95d4f50/packages/fast-sync/scripts/fund-wallet.ts)):

     ```ts
     import { InMemoryTransactionHistoryStorage, mergeWalletEntries, WalletEntrySchema, WalletFacade } from '@midnight-ntwrk/wallet-sdk';

     const configuration = {
       indexerClientConnection: { indexerHttpUrl, indexerWsUrl },
       provingServerUrl: new URL(proofServerUrl),
       networkId,
       relayURL: new URL(nodeWsUrl),
       txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
       costParameters: { feeBlocksMargin: 5 },
     };
     const wallet = await WalletFacade.init({
       configuration,
       shielded: () => shielded,
       unshielded: () => unshielded,
       dust: () => dust,
     });
     await wallet.start(zswapSecretKeys, dustSecretKey);
     const state = await wallet.waitForSyncedState();
     const dustBalance = state.dust.balance(new Date());
     ```

     For tests and scripts, testkit-js's wallet helpers do the same assembly.
   - **The providers.** There is no `createProviders`: each provider comes from its own package.
     The private-state provider in 4.x needs a password function and an account id:

     ```ts
     import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';

     const privateStateProvider = levelPrivateStateProvider({
       privateStateStoreName: 'counter-private-state',
       privateStoragePasswordProvider: async () => readPasswordFromYourSecretStore(),
       accountId: walletAddress,
     });
     ```

     Keep the password out of the source: read it from the user's own secret store or
     environment, never from a value pasted into a chat.
   - **A contract unit test, without a network:**

     ```ts
     import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
     import { sampleCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
     import * as Counter from './contract/out/contract/index.js';

     const contract = new Counter.Contract({});
     const { currentContractState } = contract.initialState(createConstructorContext({}, sampleCoinPublicKey()));
     const ctx = createCircuitContext(sampleContractAddress(), sampleCoinPublicKey(), currentContractState.data, {});
     const next = contract.circuits.increment(ctx);
     Counter.ledger(next.context.currentQueryContext.state).round; // 1n
     ```

     Run against the corpus's Counter, this incremented twice and read `1n`, then `2n`.

   `scripts/cases/right-forms.ts` has every replacement in one file, and it compiles against the
   network set.
3. **Remove custom registries.** Delete any `@midnight-ntwrk:registry=` line from `.npmrc`, and
   any `npmScopes` entry for `midnight-ntwrk` from `.yarnrc.yml`. The packages are on
   registry.npmjs.org.
4. **Use the 4.0.1 connector, and typecheck browser code as the bundler resolves it.**
   - **Connect** with `const api = await window.midnight?.[walletId]?.connect('preprod')`, where
     `walletId` is the wallet's key under `window.midnight`. Read keys and addresses from the
     returned `ConnectedAPI` (for example `getShieldedAddresses()`); there is no `enable()`.
   - **Set `"moduleResolution": "bundler"`** (and `"module": "ESNext"`) in the browser package's
     tsconfig, as Vite templates do. Under NodeNext, 4.0.1's types are `any`. This step stops
     being needed once a stable release with the fix is in the support matrix; see Upstream
     follow-ups for how to check.
   - **Delete any `Window.midnight` declaration** of your own. If a NodeNext build needs one, it
     must be exactly `midnight?: { [key: string]: InitialAPI }`.

   *Trade-off:* a package compiled with NodeNext for Node and bundler for the browser needs two
   tsconfigs; keep the connector code in the browser one.
5. **Give the assistant the ground truth, and check what it writes.**
   - **Tell it the network set,** and point it at the support matrix, or at the docs' MCP server
     (set up as described in the docs' AI integration section), rather than relying on memory.
   - **Run `check-sdk.mjs`, then `tsc`,** on everything it writes, before running it. An agent
     resolving an issue for a user can run the checker itself: it sends nothing and needs no
     keys.
   - **Paste failures into `--explain`.**

## Upstream follow-ups

- **`dapp-connector-api` typings under NodeNext (Root cause 5): fixed upstream, not yet
  released.**
  - **The fix:** [midnight-dapp-connector-api#61](https://github.com/midnightntwrk/midnight-dapp-connector-api/pull/61),
    merged 2026-08-05 (commit `3bed777`). It adds `.js` to the internal imports and also
    declares `midnight` on `globalThis`.
  - **Where it is, as of 2026-10-11:** no stable release has it. 4.0.1 (the network set, npm
    `latest`) and 4.1.0-beta.1 were built before it; only the `canary` builds from 2026-08-19 on
    have it. Checked on a clean install with TypeScript 5.6.3 and 7.0.2: on 4.0.1 three wrong
    connector lines compile, and on the canary all three are errors.
  - **How to tell whether a version has it.** These checks need no API key:
    - `npm view @midnight-ntwrk/dapp-connector-api dist-tags` shows whether a stable version
      newer than 4.0.1 exists.
    - The support matrix shows which version the networks use.
    - The installed `node_modules/@midnight-ntwrk/dapp-connector-api/dist/index.d.ts` decides it:
      `from './api.js'` means fixed, `from './api'` means not.
  - **When a stable release with the fix is in the matrix,** NodeNext projects get the connector's
    types again. The `bundler` advice in Remediation 4 then becomes optional, and the checker's
    tsconfig finding stops on its own once that version is installed.
- **[midnight-wallet#791](https://github.com/midnightntwrk/midnight-wallet/issues/791):** move
  `latest` on `@midnight-ntwrk/wallet-sdk` to 1.2.0 (open). Until it lands, `^1` ranges install
  1.1.0.
- **[midnight-wallet#648](https://github.com/midnightntwrk/midnight-wallet/issues/648):**
  `pendingOutputs.values.map is not a function` with `wallet-sdk-shielded` 2.1.0 (open).
- **SDK packages declare no `engines`,** so npm can't warn about Node 20. Not filed.

## Reference material

- **The corpus and the method:** [`scripts/check-sdk.NOTES.md`](scripts/check-sdk.NOTES.md),
  [`scripts/cases/`](scripts/cases/) (the 30 files, `expected.json`, `explain.json` and
  `right-forms.ts`), and `scripts/test-check-sdk.mjs`, which re-runs it all (`--tsc <dir>`
  re-checks the type errors against an installed network set).
- **Worked cases:**
  - [servicedesk#81](https://github.com/midnightntwrk/servicedesk/issues/81) and [#79](https://github.com/midnightntwrk/servicedesk/issues/79): a `ledger-v8` 8.0.3 pin breaks `addIntent`.
  - [servicedesk#88](https://github.com/midnightntwrk/servicedesk/issues/88): `Clock` from mismatched wallet SDK packages.
  - [midnight-docs#1068](https://github.com/midnightntwrk/midnight-docs/issues/1068): a guide pins `wallet-sdk-hd` 3.1.0, which doesn't exist.
  - [midnight-docs#1069](https://github.com/midnightntwrk/midnight-docs/issues/1069): `Cannot find package '@midnight-ntwrk/midnight-js-utils'`.
  - [midnight-docs#1135](https://github.com/midnightntwrk/midnight-docs/pull/1135): the Node 22 requirement.
  - [midnight-wallet#162](https://github.com/midnightntwrk/midnight-wallet/issues/162): `unknown network ID: 109`.
  - [midnight-wallet#648](https://github.com/midnightntwrk/midnight-wallet/issues/648): `pendingOutputs.values.map`.
  - [midnight-wallet#791](https://github.com/midnightntwrk/midnight-wallet/issues/791): the `latest` tag.
  - [midnight-js#173](https://github.com/midnightntwrk/midnight-js/issues/173): GitHub Packages authentication.
  - [midnight-js#853](https://github.com/midnightntwrk/midnight-js/issues/853): `setContractAddress`.
  - [midnight-expert#22](https://github.com/midnightntwrk/midnight-expert/issues/22): agents invent custom registries.
  - [midnightntwrk/midnight-expert@ce137e5](https://github.com/midnightntwrk/midnight-expert/commit/ce137e55100e0e85fb7070900a1fc5a56ee9ef2f): non-existent packages removed from the plugin's skills.
- **Context:** the internal AI Dev Friction Report (Notion), Issue 3 "Models don't know Compact:
  confidently broken code and invented SDK calls". This runbook is its invented-SDK-calls half.
  Its evidence includes Zealy rejecting submissions for _"fabricated SDK functions"_. The Kapa
  traffic review's npm and Node error cluster (38 pasted errors,
  [midnight-docs#1377](https://github.com/midnightntwrk/midnight-docs/issues/1377)) hasn't been
  matched against this runbook yet.
- **Docs:** `docs/relnotes/support-matrix.json`, the AI integration section's MCP setup page
  ([midnight-docs#1384](https://github.com/midnightntwrk/midnight-docs/issues/1384)).
- **Related runbooks:**
  - [Toolchain mismatch](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md):
    the version set, `Version mismatch`, two runtime copies.
  - [Proof server](../proof-server-proving-failures-runbook/proof-server-proving-failures-runbook.md):
    failures while proving, once the code runs.
