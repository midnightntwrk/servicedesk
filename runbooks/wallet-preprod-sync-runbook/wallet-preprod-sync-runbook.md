# Runbook: Wallet sync on Preprod takes an hour, starts over on every restart, or looks stuck

A wallet on Preprod sits on `Waiting to receive tokens...` for an hour or more, although the
example promised a minute or two. Restarting the app costs the same hour again. Somewhere along the
way it logs `Normal Closure` and `Wallet.Sync: [object ErrorEvent]`, and the progress numbers look
nothing like a block height. Most of this is expected: a fresh wallet has to replay every DUST event
on the chain, and nothing is kept between runs unless the app saves it. Some of it isn't: after the
machine sleeps, a sync can stop and stay stopped while still reporting itself connected. Use this
runbook to tell slow from stuck, and to stop paying for the replay more than once.

_Compiled 2026-10-13 from measurements on Preprod through Blockfrost (method and results in
[`scripts/check-wallet-sync.NOTES.md`](scripts/check-wallet-sync.NOTES.md)). Sources, pinned:_

- _wallet SDK 1.2.0, the network set (`wallet-sdk-facade` 4.1.0, `wallet-sdk-dust-wallet` 4.2.0,
  `wallet-sdk-shielded` 3.0.2, `wallet-sdk-unshielded-wallet` 3.1.0, `wallet-sdk-abstractions` 2.1.0,
  `wallet-sdk-indexer-client` 1.2.3), read from the published packages_
- _Preprod through Blockfrost on 2026-10-13: block 2,963,724, newest DUST event 1,651,418_
- _moth-wallet's field guide, `shieldedtech/moth-wallet` at `189f0c9`:
  `docs/patterns/preseed-sync-acceleration.md`_
- _midnight-examples `FAST-SYNC.md` and its `preseed/` snapshots at `2f4912f`_
- _the log lines quoted from an older example CLI: example-bboard at `f9df09a`_

_Event counts, rates and snapshot ages change daily. Re-check them before quoting them._

---

## Symptom

| What you see | What it means |
|---|---|
| `Waiting to receive tokens...` for an hour or more on Preprod, where an older example's README said *"Wait 1-2 minutes"* | Normal for a fresh wallet: it is replaying about 1.6 million DUST events (→ 1) |
| The same hour again after every restart | The app doesn't save wallet state (→ 2) |
| `RPC-CORE: subscribeRuntimeVersion(): RuntimeVersion:: disconnected from wss://rpc.midnight-preprod.blockfrost.io/?project_id=…: 1000:: Normal Closure` | Harmless: the node RPC socket closed normally and the wallet reconnects (→ 3) |
| `Wallet.Sync: [object ErrorEvent]`, a few at a time | A sub-wallet's indexer connection dropped; it retries on its own (→ 3) |
| `Wallet synced state emission (synced=false): { shielded=false, unshielded=true, dust=false }`, for an hour | Normal while DUST replays. These booleans can't show progress (→ 3) |
| DUST `appliedIndex` far below the block height (for example 1,575,381 against 2,766,750) | Not a problem: `appliedIndex` counts DUST events, not blocks (→ 3) |
| `appliedIndex` doesn't move for 10 minutes or more while the app reports connected, often after the machine slept | A real stall (→ 4) |
| `Wallet.Sync: [object ErrorEvent]` again and again after the machine woke, minutes apart, with no progress | Retries failing further and further apart: a real stall (→ 4) |
| `values inserted non-linearly into dust generation tree; expected to insert index N, but received M`, repeating (another tree's name in place of `dust generation` is the same error; older ledgers say `expected index N`) | A real stall: the saved state doesn't match the indexer (→ 4) |
| A restored wallet takes a minute or more before any progress, longer each week | Rebuilding the saved DUST tree, which keeps growing (→ 5) |
| Out of memory during the first sync of a fresh Preprod wallet | Fixed in wallet SDK 1.2.0 ([servicedesk#104](https://github.com/midnightntwrk/servicedesk/issues/104)); upgrade |

## Root cause

1. **A fresh wallet replays every DUST event on the chain, from every owner.** The DUST wallet has to
   build the chain-wide DUST generation tree before it can report any balance, so it streams every
   `dustLedgerEvents` event from the start (`wallet-sdk-dust-wallet/dist/v1/Sync.js:105-119`). An
   empty wallet pays exactly the same as a busy one, and registering NIGHT for DUST changes nothing.
   - **The size of it.** On 2026-10-13 the newest Preprod DUST event id was 1,651,418. DUST and
     shielded events share one id counter, but DUST events fill 95 to 100% of it (shielded events are
     a few percent), so that is about 1.6 million DUST events. The chain added about 400 ids an hour
     that day.
   - **Where the time goes.** moth-wallet measured a fresh Preprod wallet at 78.6 minutes: 99.2% DUST,
     38.6 s shielded, 3.4 s unshielded. midnight-examples measured about 77 minutes. Both used wallet
     SDK 1.2.x on desktop machines; DUST applied 290 to 380 events a second. On a laptop busy with
     other work we measured 80 to 190 a second, which makes it two to six hours.
   - **It isn't the indexer.** Blockfrost streamed DUST events at 3,000 to 14,000 a second in our
     tests, many times what a wallet applies. The wallet's own work is the limit.
   - **Preview is much faster**, because its tree is smaller: moth-wallet measured 103 s on the
     Preview chain before its reset. Preview relaunched as a new chain on 7 November 2026, so its
     tree starts over and a fresh sync should be shorter still (inferred, not measured).
2. **Nothing is kept between runs unless the app saves it.** Each sub-wallet can write its position
   and state with `serializeState()` (or `state.serialize()`) and continue from there with
   `restore()`: the DUST wallet resumes from the saved `appliedIndex`. Apps that only keep the seed,
   older example CLIs among them, rebuild the wallet from it on every start and sync from zero each
   time.
3. **The progress signals are easy to misread.**
   - `appliedIndex` is the id of the last DUST (or shielded) event applied, an event counter. It is
     not a block height.
   - The target is `highestRelevantWalletIndex`, the newest event id the indexer reported. The DUST
     wallet never fills in `highestIndex`, which stays 0.
   - "Synced" means `appliedIndex` equals `highestRelevantWalletIndex` and an event has been
     received (`isStrictlyComplete()`); `isCompleteWithin(n)` allows a gap of `n`, 50 by default.
     `WalletFacade` `isSynced` needs all three sub-wallets strictly complete
     (`wallet-sdk-abstractions/dist/SyncProgress.js`, `wallet-sdk-facade/dist/index.js:89-93`).
   - `isConnected` is set when an event arrives and never cleared on a disconnect. It means "has
     received something", not "is connected now".
   - The two lines that look like failures are routine. Blockfrost closes the node RPC socket
     normally (code 1000) and the client reconnects. `Wallet.Sync: [object ErrorEvent]` is a dropped
     indexer socket: during a long sync Blockfrost drops them every minute or two (code 1006). Each
     sub-wallet retries, starting 1 s later and doubling each time
     (`wallet-sdk-dust-wallet/dist/v1/RunningV1Variant.js:81-86`), and in our runs it was back within
     a second or two. When it isn't, see cause 4.
   - Booleans alone, like `shielded=false … dust=false` in an older example's log, can't tell a slow sync from
     a stuck one. Only a moving `appliedIndex` can.
4. **A real stall: in wallet SDK 1.2.0 a sync can stop after the machine sleeps, and not start
   again.** Each sub-wallet retries a failed indexer subscription, and usually that works. When it
   doesn't, nothing in 1.2.0 notices: `isConnected` stays `true`, and nothing times out. We saw two
   ways it goes wrong, both after the process was suspended (a laptop asleep, or `kill -STOP`
   standing in for one):
   - **Retries that keep failing, further and further apart.** After a 10-minute pause, every retry
     failed within a second, and the gaps doubled: 1, 2, 4, 8, 16, 32, 64, 128, then 256 s, with no
     indexer connection open. The retry is meant to wait at most 2 minutes, but the cap is applied
     with `Schedule.map`, which in Effect changes the schedule's output and not its delay
     ([midnight-wallet#742](https://github.com/midnightntwrk/midnight-wallet/issues/742), open).
     After a real 2.5-hour sleep, every reconnect also failed within 2 seconds for the few minutes
     the laptop stayed awake.
   - **A stream that goes quiet on an open socket.** After an 8-minute pause, DUST's subscription
     delivered nothing for 2 minutes while its socket stayed open. Once it did the same for 1.5
     minutes with no pause at all. Each time it resumed only when Blockfrost dropped that socket
     (code 1006) and the wallet reconnected. Nothing in 1.2.0 times out a quiet stream: graphql-ws
     sends keep-alive pings but doesn't act on a missing answer, and nothing checks for silence on
     the stream itself.
   - **What it looks like.** A laptop went to sleep 15 minutes into a fresh sync. After it woke,
     DUST stayed at event 45,693 of 1,650,046 for the 80 minutes the run went on. Shielded looked
     finished, but its target never moved either: it had stopped too.
   - **Not every sleep breaks it.** In another run, a 15-minute pause recovered at once: all three
     sockets dropped and reconnected within 2 seconds, and DUST carried on.
   - **Restarting the process from saved state works.** Each of the three times we started a
     process from a saved state, the wallet was back at the saved position within a second and
     synced on.
   - **A subscription that ends cleanly stops the sync silently**, with no retry
     ([midnight-wallet#743](https://github.com/midnightntwrk/midnight-wallet/issues/743), open). That
     issue also covers `isConnected` never being cleared. We didn't see this one happen.
   - **Fixed in the 2.0 line, mostly.** Wallet SDK 2.0.0-rc.1 caps the backoff at 2 minutes, repeats
     the sync when a subscription ends, and starts a restored wallet disconnected. Whether it also
     copes with a stream that goes quiet on an open socket hasn't been tested. It isn't in the
     support matrix yet; until it is, restart a stalled sync (Remediation 5).
   - **Saved state that doesn't match the indexer** stalls with `values inserted non-linearly…`: state
     saved against another indexer, whose event ids differ (the
     [cursor runbook](../wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md)),
     or a stale or damaged snapshot (midnight-examples `FAST-SYNC.md`, "When a bundle goes bad").
   - On wallet SDK 1.1.x the same error also came from a re-sent boundary event, which moth-wallet
     documented in `docs/upstream/wallet-sdk-sync-applyUpdate-off-by-one.md`. 1.2.0 drops events at or
     below `appliedIndex` before applying them, so that cause is gone in 1.2.0. A plain npm install
     still gets 1.1.0, though: see the version check at the start of Diagnose.
5. **Restoring isn't free, and it gets slower.** A saved DUST state holds the whole generation tree:
   the DUST part of midnight-examples' Preprod snapshot (cut at event 1,576,656) is 12.7 MB, and
   they timed `dust.restore()` at about 72 s for a tree of about 10.9 MB. The tree keeps every other
   owner's entries, so it grows with the chain
   ([midnight-wallet#639](https://github.com/midnightntwrk/midnight-wallet/issues/639), open and
   blocked until Ledger 9, measured 254 to 260 s for a 5 MB state).
6. **The real fix is in the next wallet SDK.** DUST sync without replaying the chain was finished in
   [midnight-wallet#288](https://github.com/midnightntwrk/midnight-wallet/issues/288): wallet SDK
   2.0.0-rc.1 (`wallet-sdk-dust-wallet` 5.0.0-rc.1) reads the indexer's
   `dustCommitmentMerkleTreeUpdate` and `dustGenerations` instead. It depends on `ledger-v9`
   1.0.0-rc.5 and isn't in the support matrix yet. Until it is, the remediations below are what works.

## Key identifiers

- **Progress fields** (every sub-wallet state's `progress`, wallet SDK 1.2.0):
  - shielded and DUST: `appliedIndex`, `highestRelevantWalletIndex`, `highestIndex` (unused by
    DUST), `highestRelevantIndex`, `isConnected`, `isStrictlyComplete()`, `isCompleteWithin(gap)`;
  - unshielded: `appliedId`, `highestTransactionId`, `isConnected` and the same two methods.
- **Saved state** (`serializeState()` or `state.serialize()`): JSON with `networkId`,
  `protocolVersion` and `state` (hex for shielded and DUST, the UTXO lists for unshielded). Shielded
  and DUST record their position as `offset`, the unshielded wallet as `appliedId`; numbers are
  strings. It holds no secret keys, but the shielded and unshielded parts list the wallet's coins:
  keep it as private as the wallet.
- **Indexer streams:** `dustLedgerEvents(id)` and `zswapLedgerEvents(id)`, each event with `id` and
  `maxId` (the newest id of that kind). The two share one id counter; on Preprod DUST events take 95
  to 100% of it.
- **Endpoints:** Preprod `https://midnight-preprod.blockfrost.io/api/v0` and `/ws`, with
  `?project_id=` (tokens are per network); Preview `https://indexer.preview.midnight.network/api/v4/graphql`.
- **Snapshots for brand-new wallets:** midnight-examples `preseed/preprod/` (height 2,779,435, cut
  2026-09-30 against Blockfrost) and `preseed/preview/` (height 1,474,876, cut 2026-10-27 from the
  Preview chain before its reset). Before seeding, fast-sync reads the bundle's block from the
  indexer and compares its hash (`checkChainIdentity()` in
  `packages/fast-sync/src/reference-bundle.ts`). The reset chain has no block at that height, so
  every Preview wallet now syncs from genesis, which should be quick on the new chain (inferred).

## Diagnose (no wallet keys)

First, check which wallet SDK is installed. This runbook is for wallet SDK 1.2.0, but npm's `latest`
tag still points at 1.1.0, so a plain `npm install @midnight-ntwrk/wallet-sdk` or a `^1.1.0` range
installs 1.1.0 with `wallet-sdk-dust-wallet` 4.1.0. That version has neither the per-event boundary
filter (cause 4) nor the indexer backpressure, so it can still hit errors this runbook calls fixed.

```bash
npm ls @midnight-ntwrk/wallet-sdk @midnight-ntwrk/wallet-sdk-dust-wallet @midnight-ntwrk/wallet-sdk-indexer-client
```

Expect 1.2.0, 4.2.0 and 1.2.3. Anything else: install `@midnight-ntwrk/wallet-sdk@1.2.0` exactly.

1. **Run the checker.** It needs Node 22 or later and no install. For Preprod it reads the
   Blockfrost project id from `BLOCKFROST_PROJECT_ID` and never prints it:

   ```bash
   node runbooks/wallet-preprod-sync-runbook/scripts/check-wallet-sync.mjs --network preprod \
     --state wallet-state/shielded.json --state wallet-state/dust.json --state wallet-state/unshielded.json
   ```

   What it checks:
   - **Indexer:** reachable, with the right project id for the network. A Preprod id on mainnet
     gets `403 Network token mismatch`; the shut-down official Preprod indexer gets `410`.
   - **Event counts:** the newest DUST and shielded event ids, which is what a fresh wallet
     replays.
   - **Delivery:** how fast the indexer streams DUST events. On Preprod it compares that with the
     290 to 380 a second a wallet applies: if the indexer is faster, a slow sync is the wallet's
     work. On other networks it gives the time to stream every event instead, because the apply
     rate there wasn't measured. A WARN means the indexer or your connection is the slow part:
     check the connection and try again later or from another network before suspecting the
     wallet.
   - **Saved state** (`--state`, one file per sub-wallet): the position each file was saved at,
     how far behind the indexer it is, and its size. A position past the indexer's newest event
     means it was saved against another indexer and will stall when restored (FAIL); a file saved
     on another network fails too. A position within range is only plausible: state saved through
     the official Preprod indexer is 22 ids out from Blockfrost, passes, and still stalls when
     restored. Only where the state came from tells you that.

   It reads only; exit code 0 means no FAIL, 2 at least one, 1 that it couldn't run. On Preprod on
   2026-10-14, with a wallet saved partway through its first sync:

   ```text
   check                               found                                                           status  note
   Indexer                             https://midnight-preprod.blockfrost.io/api/v0: block 2,976,054  OK
   DUST events                         newest id 1,656,549                                             INFO    a fresh wallet replays all of these, from every owner
   Shielded events                     newest id 1,656,442                                             INFO
   DUST delivery                       12,614 events/s over 10 s                                       OK      faster than a wallet applies them: a slow sync here is the wallet, not the indexer
   Fresh-wallet sync                   about 73-95 min of DUST replay                                  INFO    at the 290-380 events/s measured on fast machines; slower or busy machines take longer. A brand-new wallet can start from a pre-built snapshot instead (runbook, Remediation 3)
   State shielded (shielded.json)      offset 1,650,108, 6,334 events behind, 4 KB                     OK      plausible: within this indexer's range, but a state saved against another indexer can be too (runbook, Remediation 2)
   State dust (dust.json)              offset 45,693, 1,610,856 events behind, 382 KB                  OK      plausible: within this indexer's range, but a state saved against another indexer can be too (runbook, Remediation 2), about 71-93 min to catch up; restoring it rebuilds a 382 KB tree before syncing resumes (about 72 s for 11 MB on a fast machine, more as it grows)
   State unshielded (unshielded.json)  appliedId 0, 1 KB                                               INFO    resumes from this transaction id

   RESULT: nothing here stops a sync. If it still looks stuck, log its progress with scripts/watch-sync.ts (runbook, Diagnose step 2).
   ```

   [`scripts/test-check-wallet-sync.mjs`](scripts/test-check-wallet-sync.mjs) runs it against a
   mock indexer (12 cases, no network): the FAIL and WARN rows for state files, the 403 and 410
   hints, and bad arguments.

2. **Log the sync's progress** while it runs. Copy [`scripts/watch-sync.ts`](scripts/watch-sync.ts)
   into the app and call it after `wallet.start(...)`:

   ```ts
   const stop = watchSync(wallet);
   const state = await wallet.waitForSyncedState();
   stop();
   ```

   Every 30 s it prints each sub-wallet's position against its target, the rate and the time left.
   If a sub-wallet that isn't synced yet doesn't move for 10 minutes, it prints a warning naming it
   instead. Each sub-wallet is watched on its own, because shielded keeps moving with every new
   block while DUST can be stuck far behind. Time the process spends suspended isn't counted: after
   a wake-up it says so, and only awake time adds up towards the 10 minutes, so a sync that stays
   stuck across repeated sleeps is still reported. From a wallet restored at DUST event 45,693
   and suspended for 15 minutes (timestamps added by our logger):

   ```text
   15:25:00 sync: dust 48361/1651808 | shielded 1651817/1651817 | unshielded 0/0
   15:25:30 sync: dust 53654/1651808 at 176/s, about 152 min left | shielded 1651825/1651825 at 0/s | unshielded 0/0 at 0/s
   15:40:34 sync: this process was paused for 15 min (asleep?); watching again from here
   15:41:04 sync: dust 59722/1651908 at 102/s, about 260 min left | shielded 1651906/1651906 at 3/s | unshielded 0/0 at 0/s
   15:41:34 sync: dust 65462/1651908 at 191/s, about 139 min left | shielded 1651906/1651906 at 0/s | unshielded 0/0 at 0/s
   ```

   A stuck sync, live: a fresh Preprod wallet whose DUST subscription was held open but silent (the
   quiet stream in cause 4, reproduced with a relay, [servicedesk#251](https://github.com/midnightntwrk/servicedesk/issues/251)).
   Shielded kept syncing, and ten minutes after DUST stopped, the watcher at its default settings
   printed:

   ```text
   10:47:25 sync: dust 5890/1656548 at 0/s | shielded 1652327/1656442 at 50/s, about 2 min left | unshielded 0/0 at 0/s
   10:47:55 sync: dust has not moved for 10 min (at 5890 of 1656548). This is a stall, not a slow sync: check the log for "values inserted non-linearly" and see the runbook.
   ```

   [`scripts/test-watch-sync.mjs`](scripts/test-watch-sync.mjs) checks these rules against a fake
   wallet (8 cases, no network).

3. **Decide slow or stuck** from those lines:
   - **Slow:** DUST's `appliedIndex` keeps rising. On Preprod expect the 70-to-95-minute replay on a
     fast machine, and two to six hours on a slow or busy one. Leave it.
   - **Stuck:** watch-sync warns that a sub-wallet hasn't moved for 10 minutes. If the log repeats
     `values inserted non-linearly…`, the saved state doesn't match the indexer (cause 4): discard it
     (Remediation 6). Otherwise restart the process from its saved state (Remediation 5).
   - **Not yet:** a pause of a minute or two that ends after a `Wallet.Sync: [object ErrorEvent]`
     line is a quiet stream recovering on its own. Wait for the 10 minutes.
   - **Not a signal:** `Normal Closure`, a few `Wallet.Sync: [object ErrorEvent]` lines, the
     booleans, `isConnected` and the block height.

## Remediation

1. **Iterate on a local chain, and save Preprod for the final check.** A local network has almost
   no DUST history, so a wallet syncs in seconds. Every example in midnight-examples runs locally:
   in the example's folder, `npm run env:up` starts a node, indexer and proof server from its
   `compose.yml`, and `npm run test:local` runs it with the local network's pre-funded wallets.
   For a browser wallet on that network, `npm run fund:wallet <mn_dust_undeployed1… address>` from
   the repo root gets it DUST. That replaces `midnight-local-dev`, which is archived. On Apple
   silicon, `npm run env:up` stops with `no matching manifest for linux/arm64/v8`: the examples pin
   `midnightntwrk/indexer-standalone:4.3.5`, which is published for amd64 only. Change the
   indexer's image in `compose.yml` to `midnightntwrk/indexer-standalone:4.3.5-arm64` until the
   examples move to a multi-arch tag.

   *Trade-off:* a local chain won't show Preprod-only problems such as the shut-down endpoints or
   faucet outages.
2. **Save the wallet's state and restore it on the next start.** This is safe for the wallet's own
   state, unlike seeding from someone else's snapshot (Remediation 3). Save each sub-wallet after
   the first full sync, every few minutes during a long one, and before shutting down. On start,
   restore from the files when they exist:

   ```ts
   import fs from 'node:fs';
   import { DustWallet, PublicKey, ShieldedWallet, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk';

   const file = (name: string) => `wallet-state/${name}.json`;
   const saved = fs.existsSync(file('dust'));
   const shielded = saved
     ? ShieldedWallet(config).restore(fs.readFileSync(file('shielded'), 'utf8'))
     : ShieldedWallet(config).startWithSecretKeys(zswapSecretKeys);
   const unshielded = saved
     ? UnshieldedWallet(config).restore(fs.readFileSync(file('unshielded'), 'utf8'))
     : UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(keystore));
   const dust = saved
     ? DustWallet(dustConfig).restore(fs.readFileSync(file('dust'), 'utf8'))
     : DustWallet(dustConfig).startWithSecretKey(dustSecretKey, ledgerParams.dust);
   // … WalletFacade.init({ configuration, shielded: () => shielded, unshielded: () => unshielded, dust: () => dust }) and start, as before

   const save = async () => {
     fs.mkdirSync('wallet-state', { recursive: true });
     fs.writeFileSync(file('shielded'), await shielded.serializeState());
     fs.writeFileSync(file('unshielded'), await unshielded.serializeState());
     fs.writeFileSync(file('dust'), await dust.serializeState());
   };
   ```

   A restored wallet resumed from its saved position at once: restoring and starting took under a
   second for a 382 KB DUST state, and the first state already showed DUST at event 45,693. Saving
   it took 0.1 to 1.6 s. A full-size DUST state takes longer to restore: midnight-examples timed
   about 72 s for an 11 MB tree (cause 5).

   Three rules:
   - **The same network and the same indexer.** State saved through the official indexer, or on
     another network, doesn't carry over; see the
     [cursor runbook](../wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md).
     The checker FAILs state saved on another network or past this indexer's newest event, but not
     state that is only a few ids out: state from the official Preprod indexer is 22 ids out from
     Blockfrost and passes. Restore only state saved against the indexer you use now.
   - **One process per wallet.** Two processes syncing the same saved wallet fight over the files
     and the subscriptions.
   - **Keep the files private.** They hold no keys, but they list the wallet's coins.
3. **Start a brand-new wallet from a snapshot.** A throwaway wallet synced to tip once can seed any
   new wallet, because the DUST tree is the same for everyone. midnight-examples ships Preprod and
   Preview snapshots and the code (`packages/fast-sync`, `FAST-SYNC.md`); moth-wallet's field guide
   explains the technique and its safety rules. midnight-examples measured a seeded Preprod wallet
   at about 2 minutes, against about 78 fresh, with a nearly fresh snapshot.
   - **What we measured.** On 2026-10-13 we ran their own path (`yarn preseed:cut`, which seeds a
     wallet born at the current tip) with their Preprod snapshot, cut on 2026-09-30 and by then 13
     days and about 77,400 DUST events old. Restoring it took 4.4 minutes and catching up 14 minutes
     on a busy laptop: 19 minutes in all, against two to six hours fresh on the same machine, with
     no errors. On a fast machine expect their 72 s restore plus a few minutes of catch-up for a
     snapshot that age.
   - **Only for wallets created after the snapshot.** Seeding a wallet that existed earlier starts it
     past its own history and hides its funds. midnight-examples' `.env` path only fast-syncs a
     wallet with a recorded birthday (`_BIRTHDAY`, its creation height), and their guard refuses one
     without. But their `assembleWallet` treats a missing birthday as "created now"
     (`packages/fast-sync/src/fast-wallet.ts:142`), so code that passes `fastSync` for an existing
     wallet without its real birthday seeds it anyway. Never write a birthday in by hand, and never
     pass `fastSync` for a wallet you didn't just create.
   - **Snapshots age.** Catch-up costs about half a second per hour of age (moth-wallet). A 13-day-old
     snapshot worked for us, but midnight-examples saw a month-old one fail to catch up at all,
     stalling with `values inserted non-linearly…`. Re-cut it when that happens.
4. **Wait for the real sync before reading balances.** Use `await wallet.waitForSyncedState()`, or
   check `state.isSynced`, which needs all three sub-wallets strictly complete. The first balance
   emission isn't "synced": moth-wallet once saved a snapshot that early and shipped an empty one
   for months. Log progress with `watch-sync.ts` meanwhile, and change example-style waits that
   promise a minute or two.
5. **Restart a stalled sync** (cause 4, wallet SDK 1.2.0). When `watch-sync.ts` warns that a
   sub-wallet hasn't moved for 10 minutes and the log has no `values inserted non-linearly…`, stop
   the app and start it again, restoring from the state it saved (Remediation 2), so it resumes
   where it was. Each of the three times a process was started from saved state in these tests,
   the wallet was back at its saved position within a second and synced on. Save on a timer as well as at shutdown, so a restart loses a few
   minutes at most. For a long first sync, keep the machine awake: `caffeinate -i <command>` on
   macOS, `systemd-inhibit <command>` on Linux.

   To restart without stopping the app, rebuild the wallet from its saved state. Calling
   `wallet.stop()` and then `wallet.start()` on the same facade is not enough: in a test with the
   [servicedesk#251](https://github.com/midnightntwrk/servicedesk/issues/251) relay it returned at
   once but never resubscribed, and DUST stayed where it had stopped. Rebuilding resubscribed within
   2 seconds and DUST synced on, in both runs (**measured**):

   ```ts
   // shielded, unshielded, dust and wallet are `let`s, built as in Remediation 2.
   const restart = async () => {
     const saved = {
       shielded: await shielded.serializeState(),
       unshielded: await unshielded.serializeState(),
       dust: await dust.serializeState(),
     };
     await wallet.stop();
     shielded = ShieldedWallet(config).restore(saved.shielded);
     unshielded = UnshieldedWallet(config).restore(saved.unshielded);
     dust = DustWallet(dustConfig).restore(saved.dust);
     wallet = await WalletFacade.init({ configuration: config, shielded: () => shielded, unshielded: () => unshielded, dust: () => dust });
     await wallet.start(zswapSecretKeys, dustSecretKey);
     // Move anything subscribed to the old facade's state() over to the new one.
   };
   ```

   Call it when DUST's `appliedIndex` is below `highestRelevantWalletIndex` and hasn't moved for a
   few minutes. On Blockfrost a quiet stream often clears within two minutes, when Blockfrost drops
   the socket, so waiting a little first avoids restarts that weren't needed.

   *Trade-off:* a restart without saved state starts the replay over.
6. **Discard state that doesn't match the indexer.** If the checker FAILs a state file, or the log
   repeats `values inserted non-linearly…`, delete the saved state and sync from the start once.
   For a brand-new wallet, a fresh snapshot is the faster alternative.
7. **Strip the project id before pasting logs.** The `RPC-CORE` lines print the node URL with its
   `project_id`, and some older example CLIs also log the wallet seed. Remove both, or rotate the project
   id, before sharing a log.

## Upstream follow-ups

- **[midnight-wallet#742](https://github.com/midnightntwrk/midnight-wallet/issues/742)** and
  **[midnight-wallet#743](https://github.com/midnightntwrk/midnight-wallet/issues/743)** (both open):
  the uncapped retry backoff, the silent end of a cleanly completed subscription, and the latched
  `isConnected`. Fixed in the wallet SDK 2.0 line, which the support matrix lists for Mainnet and
  Preview; Preprod still lists 1.2.0, so Remediation 5 stays until Preprod moves.
- **midnight-examples `preseed/preview/`**
  ([midnightntwrk/midnight-examples#91](https://github.com/midnightntwrk/midnight-examples/issues/91)): it was cut from the Preview chain before the
  reset, so fast-sync no longer uses it; a new cut from the reset chain would bring fast-sync back.
- **A stream that goes quiet on an open socket:**
  [servicedesk#251](https://github.com/midnightntwrk/servicedesk/issues/251) (open), with a relay
  that reproduces it. Seen only through Blockfrost, and it isn't known yet whether the wallet,
  graphql-ws or the indexer is behind it. Wallet SDK 2.x hasn't been checked against the relay.
- **[midnight-wallet#639](https://github.com/midnightntwrk/midnight-wallet/issues/639)** (open,
  blocked until Ledger 9): the saved DUST state keeps growing.
- **[midnight-wallet#288](https://github.com/midnightntwrk/midnight-wallet/issues/288)** (done in
  2.x): DUST sync without replaying the chain.
- **Example code:** use midnight-examples. Its `FAST-SYNC.md` and `packages/fast-sync` start new
  wallets from a snapshot, and its examples log sync progress as numbers and don't log the seed. It
  doesn't save a wallet's own state between runs either; Remediation 2 covers that.

## Reference material

- **Measurements and method:** [`scripts/check-wallet-sync.NOTES.md`](scripts/check-wallet-sync.NOTES.md),
  with the stall reproductions and the tests of both scripts
  ([`test-check-wallet-sync.mjs`](scripts/test-check-wallet-sync.mjs),
  [`test-watch-sync.mjs`](scripts/test-watch-sync.mjs)).
- **Prior work:**
  - moth-wallet (`shieldedtech/moth-wallet` at `189f0c9`): `docs/patterns/preseed-sync-acceleration.md`
    (the technique, its safety rules and measurements), `docs/patterns/midnight-wallet-characteristics.md`
    (why DUST sync is global), `docs/upstream/wallet-sdk-sync-applyUpdate-off-by-one.md` (the 1.1.x
    boundary-event bug).
  - midnight-examples (`2f4912f`): `FAST-SYNC.md`, `packages/fast-sync`, `preseed/`.
- **Worked cases:**
  - [servicedesk#104](https://github.com/midnightntwrk/servicedesk/issues/104): a fresh Preprod wallet
    never finished its first sync; fixed in wallet SDK 1.2.0.
  - Technical Moderator reports, weeks 35 and 36: a funding example's "1 to 2 minutes" took about 6.5
    hours; an example CLI repeated an hour-long sync on every restart; healthy reconnect lines read
    as failures.
- **Upstream:** [midnight-wallet#742](https://github.com/midnightntwrk/midnight-wallet/issues/742),
  [#743](https://github.com/midnightntwrk/midnight-wallet/issues/743),
  [#639](https://github.com/midnightntwrk/midnight-wallet/issues/639),
  [#288](https://github.com/midnightntwrk/midnight-wallet/issues/288); midnight-indexer 4.2.0's
  `dustGenerationMerkleTreeUpdate` (release notes in midnight-docs).
- **Source, wallet SDK 1.2.0** (published packages):
  - `wallet-sdk-dust-wallet` 4.2.0 `dist/v1/Sync.js:105-119` (a fresh wallet streams from the start, a
    restored one from `appliedIndex`), `:145-152` (`highestRelevantWalletIndex` is the newest id;
    `highestIndex` is never set), `dist/v1/RunningV1Variant.js:81-86` (the retry schedule);
  - `wallet-sdk-abstractions` 2.1.0 `dist/SyncProgress.js` (`isCompleteWithin`, default gap 50);
  - `wallet-sdk-facade` 4.1.0 `dist/index.js:89-93` (`isSynced`);
  - `wallet-sdk-indexer-client` 1.2.3 `dist/effect/WsSubscriptionClient.js:37` (`shouldRetry: () => false`,
    `keepAlive` 15 s) and `dist/effect/Backpressure.js` (pause at 10,000 in flight, resume at 100);
  - `graphql-ws` 6.3.0 `dist/client.d.ts:200-201`, on `keepAlive`: "NOTHING will happen
    automatically with the client if the server never responds to a `PingMessage` with a
    `PongMessage`".
- **Related runbooks:**
  - [Wallet sync cursor/indexer mismatch](../wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md):
    restoring state saved against another indexer.
  - [Indexer migration to Blockfrost](../indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md):
    endpoints and project ids.
