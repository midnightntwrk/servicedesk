---
title: "Wallet sync on Preprod takes hours, starts over on every restart, or never settles"
when_to_use: "A wallet SDK 2.x wallet on Preprod spends hours or days on its first DUST sync, pays for it again after every restart, stops moving, or reports itself synced while the facade stays `Crossing` and can't build a transaction."
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-13"
last_reviewed: "2026-11-18"
error_strings:
  - "Waiting to receive tokens"
  - "Wallet.Sync: [object ErrorEvent]"
  - "Wallet.Sync: [object Object]"
  - "Could not read the dust event at"
  - "Normal Closure"
  - "values inserted non-linearly"
  - '"_tag":"Crossing"'
  - "Wallet sync timeout after"
  - "skipLedgerV8DustHistory"
review_when:
  - "A wallet SDK release makes skipLedgerV8DustHistory find the ledger 9 start through Blockfrost, turns it on by default, or adds a shielded equivalent: Root cause 1 and 2 and Remediation 1 change"
  - "DustWallet stops reading a dustTimelineStartProbe from its configuration, or its type starts listing it: Remediation 1's code"
  - "testkit-js or midnight-examples ship a fast DUST start that works on Preprod: Remediation 1 should point at it"
  - "Preprod is reset onto a new chain: the ledger 8 history and the cursor are gone, and most of this runbook with them"
---

# Runbook: Wallet sync on Preprod takes hours, starts over on every restart, or never settles

Preprod moved to ledger 9 in place on 9 November 2026, so a fresh wallet SDK 2.x wallet still reads every DUST event since genesis, about two million: hours to days. The SDK's skip option silently does nothing through Blockfrost, and its eventless sync leaves a wallet that can't transact. Start new wallets at the ledger 9 boundary with your own probe answer, save wallet state, and restart a stalled sync from it.

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported**, **inferred** or **not tested** has none, so trust it less.

## Symptom

| If you see | Go to |
|---|---|
| A fresh Preprod wallet waits for DUST for an hour or more: `Waiting to receive tokens...`, or testkit's `Wallet sync timeout after …` | Diagnose 1 (synced but no DUST: [test funds runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-test-funds-runbook/wallet-test-funds-runbook.md)) |
| `skipLedgerV8DustHistory: true` is set and DUST still replays from the start, sometimes after `Could not read the dust event at N` | Diagnose 1, then Remediation 1 |
| All three sub-wallets report complete, but the facade's `protocol` stays `{"_tag":"Crossing","from":"0",…,"behind":["dust"]}` and nothing can be built | Diagnose 3 |
| The same long sync again after every restart | Remediation 2 |
| DUST's `appliedIndex` doesn't move for 10 minutes or more | Diagnose 2 |
| `values inserted non-linearly…` (any tree's name), repeating | Remediation 4 |
| A few `Wallet.Sync: [object ErrorEvent]` or `Wallet.Sync: [object Object]` lines, or `RPC-CORE: … 1000:: Normal Closure`, while progress keeps moving | Not a problem: Diagnose 3 |

### Not this runbook

- **Wallet SDK 1.x, midnight-js 4.x or `setNetworkId`** don't support ledger 9: see the [version mismatch runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md).
- **`unshielded=false` too, or HTTP 403 or 410.** Wrong endpoint or project id: see the [Blockfrost runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md).
- **State saved through another indexer** stalls on restore: see the [cursor runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md).
- **Preview or a local chain** have little history: a fresh Preview wallet synced in about 100 s (**measured**, 7 November). Develop there and keep Preprod for the final check.

## Root cause

1. **A fresh wallet replays every DUST event, from every owner,** starting on the ledger 8 variant. Batches of 10 each wait on indexer round trips: 300 to 3,400 events a minute through Blockfrost (**measured**), 10 hours to days for two million.
2. **`skipLedgerV8DustHistory: true` doesn't help through Blockfrost.** Its binary search for the first ledger 9 DUST event (about 25 lookups, 10 s each, one connection) found nothing in 8 of 8 runs on wallet SDK 2.0.0 and 2.0.1 (**measured**), and the failure is swallowed (at most a `Could not read the dust event at N` line, N being a lookup), so the wallet starts from the beginning. The same search with a fresh socket per lookup takes about 20 s.
3. **The eventless DUST sync leaves a wallet that can't transact.** Built with `makeEventLessSyncService` on 2.0.0, the dust wallet reported protocol version 0, so the facade stayed `Crossing`: `isSynced` was true, testkit's `syncWallet` never returned, nothing could be built (**measured**). Whether 2.0.1's `dustWalletProbes` fixes it is **not tested**.
4. **Nothing is kept between runs** unless the app saves each sub-wallet with `serializeState()` and restores it with `restore()`.
5. **A sync can stop after a network failure.** On 2.0.0, after `ECONNRESET`, DUST stopped for over an hour; a restart from saved state recovered (**measured**). See [servicedesk#251](https://github.com/midnightntwrk/servicedesk/issues/251), [#297](https://github.com/midnightntwrk/servicedesk/issues/297), [midnight-wallet#742](https://github.com/midnightntwrk/midnight-wallet/issues/742) and [#743](https://github.com/midnightntwrk/midnight-wallet/issues/743).

## Before you start

- **You need** Node 22 or later, a Blockfrost project id for Midnight Preprod in `BLOCKFROST_PROJECT_ID` (the scripts read it and never print it), and the wallet SDK 2.x packages: `npm ls @midnightntwrk/wallet-sdk @midnightntwrk/wallet-sdk-dust-wallet`.
- **Safety.** Diagnose is read-only and needs no keys; the remediations change only the app's code and files. Saved state lists the wallet's coins: keep it private. testkit-js's `MidnightWalletProvider.build` logs the master seed at INFO ([servicedesk#320](https://github.com/midnightntwrk/servicedesk/issues/320)): remove it before sharing a log.

## Diagnose

1. **How much history would this wallet replay, and where does ledger 9 start?** From a clone of this repo, with `--state` pointing at the app's saved files:

   ```sh
   node runbooks/wallet-preprod-sync-runbook/scripts/check-wallet-sync.mjs --network preprod \
     --state wallet-state/shielded.json --state wallet-state/dust.json --state wallet-state/unshielded.json
   ```

   Without saved state, leave out `--state`. On 18 November 2026, in about 25 s:

   ```text
   Ledger 9 DUST start           cursor 1857961, version 2001100 (23 lookups, 20 s)   INFO  a fresh wallet can start here: dustTimelineStartProbe: async () => Option.some({ cursor: 1857961n, version: ProtocolVersion.ProtocolVersion(2001100n) }) (runbook, Remediation 1)
   Fresh wallet, default start   replays 1,988,924 DUST event ids, ledger 8 included  WARN  about 10 h to 5 days …
   ```

   A default-start `WARN` means slow by design: Remediation 1. For state files, `FAIL` means Remediation 4; `still on ledger 8` means Remediation 4 for `dust.json`, then Remediation 1; `eventless (projections) state` is Root cause 3. A `WARN` on `Ledger 9 DUST start` means the search didn't finish: run it again, then Stop and escalate. Exit 0 is no `FAIL`, 2 at least one, 1 couldn't run.

2. **Is it moving?** Copy [watch-sync.ts](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/scripts/watch-sync.ts) into the app and call it after `wallet.start(...)`:

   ```ts
   const stop = watchSync(wallet);
   await wallet.waitForSyncedState();
   stop();
   ```

   It prints progress every 30 s, and warns when a sub-wallet hasn't moved for 10 minutes, or when all three are complete but the facade is `Crossing`.

3. **Decide.**
   - **Slow:** `appliedIndex` keeps rising. Remediations 1 and 2.
   - **Stuck:** watch-sync warns `has not moved`. Remediation 4 if the log has `values inserted non-linearly…`, otherwise Remediation 3.
   - **Crossing:** watch-sync warns `still crossing`. With an eventless dust wallet this is Root cause 3: rebuild DUST with `DustWallet` (Remediation 1). With `DustWallet`, Stop and escalate.
   - **Not a signal:** `Normal Closure`, and a few `Wallet.Sync: [object …]` lines that progress continues after (sockets the wallet reopens).

## Remediation

1. **Start a new wallet's DUST at the ledger 9 boundary.** Pass the answer Diagnose 1 printed as `dustTimelineStartProbe`, and leave `skipLedgerV8DustHistory` unset: when `true`, the SDK's own search replaces your probe:

   ```ts
   import { Option } from 'effect';
   import { DustWallet, ProtocolVersion, type DefaultDustConfiguration, type DustTimelineStartProbe } from '@midnightntwrk/wallet-sdk';

   // The answer check-wallet-sync.mjs prints. On Preprod: cursor 1857961, version 2001100 (measured).
   const dustTimelineStartProbe: DustTimelineStartProbe = async () =>
     Option.some({ cursor: 1857961n, version: ProtocolVersion.ProtocolVersion(2001100n) });
   const Dust = DustWallet({
     ...configuration, // your facade configuration, including forks
     dustTimelineStartProbe, // on ForkingDustConfiguration, not DefaultDustConfiguration: hence the cast
     batchUpdates: { size: 500, timeout: 200, spacing: 0 },
   } as DefaultDustConfiguration);
   const dust = await Dust.startWithSeed(seeds.dust);
   ```

   On 2.0.1 this synced 130,000 events in 3.7 minutes (**measured**).

   With testkit-js, build the facade yourself (Remediation 2) and pass it to `MidnightWalletProvider.withWallet(logger, env, wallet, seeds, keystore)`.

   *Trade-off:* no DUST transaction history from ledger 8; a wallet that held DUST before 9 November is **not tested**. The cursor must be exact, so use the checker's. Only a fresh start asks the probe. Shielded has no such start and replays everything, over an hour on 13 November (**measured**), so save its state (Remediation 2).

2. **Save the wallet's state and restore it on the next start.** Save after the first sync, every few minutes during a long one, and at shutdown:

   ```ts
   import fs from 'node:fs';
   import { ShieldedWallet, UnshieldedWallet, WalletFacade } from '@midnightntwrk/wallet-sdk';

   const file = (name: string) => `wallet-state/${name}.json`;
   const load = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : undefined);
   const [s, u, d] = [load('shielded'), load('unshielded'), load('dust')];
   const shielded = s ? ShieldedWallet(configuration).restore(s) : await ShieldedWallet(configuration).startWithSeed(seeds.shielded);
   const unshielded = u ? UnshieldedWallet(configuration).restore(u) : freshUnshielded; // as you build it now
   const dust = d ? Dust.restore(d) : await Dust.startWithSeed(seeds.dust); // Dust from Remediation 1
   const wallet = await WalletFacade.init({ configuration, shielded: () => shielded, unshielded: () => unshielded, dust: () => dust });
   await wallet.start(seeds); // seeds = WalletSeeds.fromMasterSeed(masterSeed)

   const save = async () => {
     fs.mkdirSync('wallet-state', { recursive: true, mode: 0o700 });
     for (const [name, w] of Object.entries({ shielded, unshielded, dust })) fs.writeFileSync(file(name), await w.serializeState(), { mode: 0o600 });
   };
   setInterval(save, 5 * 60_000); // and await save() before the process exits
   ```

   A restored wallet synced in 4 to 6 s, or 126 s after three days away (**measured**). Keep state per network and indexer, one process per wallet.

   *Trade-off:* the files list the wallet's coins (see Safety).

3. **Restart a stalled sync from its saved state.** Restart the process with Remediation 2, rather than `stop()` and `start()` on the same facade (**not tested** on 2.x). Keep the machine awake: `caffeinate -i` (macOS), `systemd-inhibit` (Linux).

   *Trade-off:* without saved state, a restart starts over.

4. **Discard state that won't resume.** Delete the file the checker FAILs, or every file when the log repeats `values inserted non-linearly…`. For a DUST state still on ledger 8, or an eventless one, move `dust.json` aside and use Remediation 1. On a wallet with no saved state, Stop and escalate.

   *Trade-off:* that sub-wallet syncs again.

## Confirm fixed

- The checker shows no `FAIL`, and no DUST state `still on ledger 8` or `eventless`.
- watch-sync prints `sync: complete`; the facade's `protocol` is `Settled`.
- A restart is synced in seconds to minutes, not hours.
- The wallet builds a transaction, for example a DUST registration.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- The checker can't find the ledger 9 start twice in a row.
- A wallet started at the boundary shows a DUST balance its registrations don't explain.
- The facade stays `Crossing` with plain `DustWallet`.
- A sync restarted from saved state stops again, or doesn't move for 10 minutes.
- A source in Key identifiers disagrees with its row and no step covers that.

Include the checker's output, the watch-sync lines, the `npm ls` output and the facade's `protocol`. Remove the project id and any seed first.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). [check-runbook.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/authoring/check-runbook.mjs) tests every row daily against each source's newest version, or the npm version a row pins. For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| The skip option exists and is off unless set | `npm:@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWalletAPI.d.ts` | `skipLedgerV8DustHistory?: boolean;` |
| A wallet started past ledger 8 has no ledger 8 DUST history | `npm:@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWalletAPI.d.ts` | `dust transaction history from ledger-v8 will be missing` |
| The skip option's search answers nothing when it fails | `npm:@midnightntwrk/wallet-sdk-dust-wallet/dist/v2/Sync.js` | `Effect.scoped, Effect.orElseSucceed(() => Option.none()));` |
| Each lookup in that search waits 10 s | `npm:@midnightntwrk/wallet-sdk-dust-wallet/dist/v2/Sync.js` | `const EVENT_TIP_PROBE_TIMEOUT = Duration.seconds(10);` |
| A configuration can carry its own start probe | `npm:@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWallet.d.ts` | `dustTimelineStartProbe?: DustTimelineStartProbe;` |
| `DustWallet` keeps that probe unless the skip option replaces it | `npm:@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWallet.js` | `...dustWalletProbes(configuration),` |
| The skip option sets the SDK's own search | `npm:@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWallet.js` | `configuration.skipLedgerV8DustHistory === true` |
| DUST updates come in batches of 10 by default | `npm:@midnightntwrk/wallet-sdk-dust-wallet/dist/v2/Sync.js` | `const batchSize = config.batchUpdates?.size ?? 10;` |
| `isSynced` checks progress only, not the protocol phase | `npm:@midnightntwrk/wallet-sdk-facade/dist/index.js` | `get isSynced() {` |
| The facade reports a `Crossing` phase | `npm:@midnightntwrk/wallet-sdk-facade/dist/index.d.ts` | `_tag: 'Crossing';` |
| testkit-js logs the master seed | `npm:@midnight-ntwrk/testkit-js/dist/index.js` | `Your wallet seed is:` |
| Slow DUST sync on Preprod, still open | `issue:midnightntwrk/servicedesk#319` | `open` |
| testkit seed logging, still open | `issue:midnightntwrk/servicedesk#320` | `open` |
| A DUST stream that goes quiet on an open socket, still open | `issue:midnightntwrk/servicedesk#251` | `open` |
| The wallet's indexer client doesn't retry network failures, still open | `issue:midnightntwrk/servicedesk#297` | `open` |

## Reference material

- **Measurements:** [check-wallet-sync.NOTES.md](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/scripts/check-wallet-sync.NOTES.md) and [servicedesk#319](https://github.com/midnightntwrk/servicedesk/issues/319).
- **Scripts:**
  - [check-wallet-sync.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/scripts/check-wallet-sync.mjs) finds the ledger 9 DUST start and reads saved state; read-only, no keys. [test-check-wallet-sync.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/scripts/test-check-wallet-sync.mjs) runs it against a mock indexer.
  - [watch-sync.ts](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/scripts/watch-sync.ts) logs progress and warns on a stall or a facade that never settles; [test-watch-sync.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/scripts/test-watch-sync.mjs) tests it.
