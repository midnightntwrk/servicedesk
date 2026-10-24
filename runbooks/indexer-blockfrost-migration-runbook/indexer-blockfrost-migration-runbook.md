---
title: "Moving to Blockfrost, beyond the docs migration guide"
when_to_use: "A preprod or mainnet app has moved from the Midnight-hosted indexer and RPC to Blockfrost and the fix in the docs migration guide was not enough: a wallet restored from saved state or a preseed bundle will not sync, or a funding step times out."
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-09-29"
last_reviewed: "2026-10-12"
error_strings:
  - "ENDPOINT_DECOMMISSIONED"
  - "Missing project token. Please include project_id in your request."
  - "Invalid project token."
  - "TypeError: Invalid URL"
  - "values inserted non-linearly into dust generation tree"
  - "Wallet sync timeout after 90000ms"
review_when:
  - "The docs page guides/networks-and-environments gains a fix this runbook also gives: cut it here, so the runbook still adds only what the docs leave out"
  - "Blockfrost changes how often its indexer sends progress messages: the Blockfrost half of Root cause 2 is measured, not sourced"
---

# Runbook: Moving to Blockfrost, beyond the docs migration guide

The docs own this migration. Start with [Migrating from the Midnight-hosted endpoints](https://docs.midnight.network/guides/networks-and-environments#migrating-from-the-midnight-hosted-mainnet-endpoints). This runbook covers only what that page leaves out: saved wallet state and bundles from the old indexer, a funding wait you cannot configure, how to confirm the move worked, and when to stop.

Each fact is in Key identifiers with its source. A claim marked **measured**, **inferred** or **not tested** has none, so trust it less.

## Symptom

| If you see | Go to |
|---|---|
| An error that names a preprod or mainnet host ending in `midnight.network`, including `ENDPOINT_DECOMMISSIONED` | The docs guide: the config still points at an old endpoint. Then Diagnose 1. |
| HTTP 403 from Blockfrost, such as `Missing project token. Please include project_id in your request.`, `Invalid project token.` or `Network token mismatch. Are you using token for the correct network?` | The docs guide. Then Confirm fixed. |
| `TypeError: Invalid URL` while a wallet is built | The docs guide. Then Confirm fixed. |
| After the switch, wallet sync never finishes and the log repeats `values inserted non-linearly into dust generation tree`, or the same text for another tree | Diagnose 2 |
| `Wallet sync timeout after 90000ms` right after funding, although the funds are on chain and the sync log shows `unshielded=false` | Remediation 3 |
| One `Wallet.Sync: [object Object]` or `[object CloseEvent]` per sub-wallet, after which sync carries on (measured) | No action. Inferred: a subscription dropped and resumed. If it repeats and sync makes no progress, Stop and escalate. |

### Not this runbook

- **The same `values inserted non-linearly` error when the wallet first synced on the indexer you are on now.** See the [cursor-mismatch runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md), which owns the mechanism.
- **`1010: Invalid Transaction: Custom error: N`.** See the [1010 runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-1010-custom-error-runbook/node-1010-custom-error-runbook.md).
- **A sync timeout where an explorer does not show the funds on chain.** Not covered: open an issue at the front door under Stop and escalate.
- **A network the docs list as Midnight-hosted.** Nothing here applies. For `values inserted non-linearly` there, use the cursor-mismatch runbook above.

## Root cause

1. **A wallet resumes sync from an id the indexer assigned, not from a chain position.** State saved against one indexer therefore points at the wrong events on another. This is sourced for the dust wallet. For the shielded and unshielded streams it was measured.
2. **For the unshielded wallet, "synced" means it has caught up with the indexer's latest progress message, and that message is sent less often on an idle subscription.** A short fixed wait right after a transaction expires first. Measured: the Midnight-hosted indexer did not slow down, and Blockfrost does. Not tested: which indexer release each ran.

## Before you start

- **Do the docs migration first.** The new endpoints must answer with your token, as the docs' check command shows.
- **The token and the seed are secrets.** An agent working for a user never asks to see either. The user sets the token in their own environment. Strip the token from everything you paste or share.
- **The Diagnose commands are read-only.** Creating or funding a wallet is always the user's step.
- **Confirm the seed is held before any saved state is set aside.** Ask the user to confirm it, not to show it. If it is not held, leave the state where it is and Stop and escalate.

## Diagnose

Go where the Symptom table sent you. With no clear symptom, run both steps.

1. **Is anything still pointing at the old hosts?**

   ```sh
   grep -rnoE "(indexer|rpc)\.(preprod|mainnet)\.midnight\.network" --exclude-dir=node_modules --exclude-dir=.git .
   ```

   It prints only the file, line and host, never a secret. A hit in code or config is a consumer that has not moved: fix it with the docs guide. Hits in comments and prose do not count. Move RPC URLs too, even if the old ones still answer. It cannot see CI secrets, a deployed environment, or defaults inside a dependency: check those by hand, and set a CI secret again instead of printing it.

2. **Does the wallet resume from state saved on another indexer?** Search for `serializeState` and `restore` to find where state is saved and read. Also look for a fast-sync or preseed bundle, or stored event or transaction ids.
   - Nothing is saved, because the wallet syncs from genesis on every start: this cause is ruled out. If sync still fails, Stop and escalate.
   - A bundle whose manifest has an `indexer` field: `grep -oE '"indexer": *"([a-z]+://)?[A-Za-z0-9.-]+' <manifest.json>` prints its host and nothing after it. A host other than the one in your indexer URL means not portable. The same host: see the last bullet.
   - State or ids from a wallet that first synced on another indexer, even if the file was rewritten since (inferred), a manifest with no `indexer` field, or no way to tell: treat it as not portable.
   - State from a wallet that synced from genesis on the indexer you use now: portable. With no error, there is nothing to do. With the error, see the first case under Not this runbook.

   Not portable: do Remediation 1 for every wallet that resumes from that state, including one that appears to sync (inferred: it can have skipped events). If you use bundles, also do Remediation 2 so new wallets get a good one.

## Remediation

1. **Set aside state and stored ids saved against the old indexer, and sync from genesis.** What the docs leave out:
   - With the seed confirmed held, stop the app, then move the old state aside, and delete it only once the genesis sync has finished and the wallet shows the balance you expect.
   - Raise two timeouts above the full-sync time the docs give: the app's own whole-sync timeout, and the test runner's hook timeout if tests do the sync.

   *Trade-off:* the app is down for a long first sync.

2. **Cut fast-sync and preseed bundles again, from genesis, against the indexer you use now.** By Root cause 1, a bundle's cursors are valid only on the indexer that produced them. Bootstrapping the cutter from an old bundle fails the same way (measured). Record the indexer host, not the URL, in the manifest, so Diagnose 2 works next time. The `midnight-examples` cutter does, and its `FAST-SYNC.md` is the reference.

   *Trade-off:* that cutter seeds only wallets whose birthday is at or after the bundle's height. An older wallet needs Remediation 1 instead. Do not abandon a funded wallet for a new one.

3. **Replace a funding wait you cannot configure.** The docs say what to wait for, but not that `waitForFunds` in testkit-js takes no timeout. Check your version:

   ```sh
   grep -rnE "syncWallet = |waitForFunds = |syncWallet\(wallet" node_modules/@midnight-ntwrk/testkit-js/dist --include=index.mjs --include=index.js
   ```

   It prints the `syncWallet =` line with its default, the `waitForFunds =` line, and each `syncWallet(wallet` call.
   - The calls after `waitForFunds =` pass no timeout: the wait is fixed at that default. Use your own helper that waits for what the docs name, with a limit above the progress interval they give. `packages/fast-sync/src/funding.ts` in `midnight-examples` is one.
   - Anything else, such as calling `syncWallet` yourself or not using testkit-js: raise your own wait above that interval.

   *Trade-off:* you own a small funding helper.

4. **Do not shift cursors by a fixed offset or by one derived from the numbers in the error.** If you cannot afford a genesis sync, the re-anchoring approach and its risks are in the [cursor-mismatch runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md#remediation).

## Confirm fixed

Check each line that applies, and report any you could not check.

- Diagnose 1 shows no hit in code or config.
- The token check from the docs prints a block height and the right network name, for each network you use.
- The wallet reaches a synced state and `values inserted non-linearly` does not appear again.
- The funding step completes without `Wallet sync timeout`, and `state.dust.availableCoins` is not empty.
- `grep -cE "night(preprod|mainnet)[A-Za-z0-9]" <logfile>` prints 0. Those are the docs' token prefixes, and counting keeps a token off your screen. If it is not 0, treat the token as leaked: replace it, and stop logging the value.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- An error the docs guide covers survives the fix it gives, with Diagnose 1 clean.
- The token check from the docs fails with something the docs do not list, such as a 429 or a 5xx.
- Sync fails with `values inserted non-linearly` although no saved state is involved, including during a genesis sync on the new indexer.
- `Wallet sync timeout` survives Remediation 3, or the `Wallet.Sync` drops repeat and sync makes no progress.
- The seed is not held, or the balance is wrong after a genesis sync. Leave the saved state where it is, and do not put old state back.
- A source in Key identifiers disagrees with its row and no step covers that. Say which row.

Include the error text, the token check's output, and `npm ls @midnight-ntwrk/wallet-sdk-dust-wallet @midnight-ntwrk/wallet-sdk-unshielded-wallet @midnight-ntwrk/testkit-js`. Remove any token from all of it first.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). [check-runbook.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/authoring/check-runbook.mjs) tests every row daily against each source's newest version. For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| The docs give the endpoints, the token setup and its check, token hygiene for logs, each error's first fix, the funding wait, the progress interval and the full-sync time | `github:midnightntwrk/midnight-docs/docs/guides/networks-and-environments.mdx`, published as [Networks and environments](https://docs.midnight.network/guides/networks-and-environments) | `{/* #migrating-from-the-midnight-hosted-mainnet-endpoints */}` `indexer.preprod.midnight.network` `rpc.preprod.midnight.network` `indexer.mainnet.midnight.network` `rpc.mainnet.midnight.network` `nightpreprod` `nightmainnet` `value from URLs and errors before you log them` `Missing project token` `Invalid project token` `TypeError: Invalid URL` `values inserted non-linearly` `transaction ids differ between indexers` `takes over an hour` `Wallet sync timeout` `backing off to about 4 minutes` `or for spendable DUST` |
| Event ids are database row ids that each indexer assigns | `github:midnightntwrk/midnight-indexer/indexer-common/migrations/postgres/001_initial.sql` | `CREATE TABLE ledger_events (` `id BIGSERIAL PRIMARY KEY` |
| The dust wallet saves its last applied event id | `npm:@midnight-ntwrk/wallet-sdk-dust-wallet/dist/v1/Serialization.js` | `offset: w.progress?.appliedIndex` |
| The dust wallet resumes sync from that saved id | `npm:@midnight-ntwrk/wallet-sdk-dust-wallet/dist/v1/Sync.js` | `const { appliedIndex } = state.progress;` |
| Unshielded "synced" compares the applied id with the indexer's latest progress | `npm:@midnight-ntwrk/wallet-sdk-unshielded-wallet/dist/v1/SyncProgress.js` | `isStrictlyComplete()` `return SyncProgress.isCompleteWithin(this, 0n)` |
| Progress messages back off on an idle subscription | `github:midnightntwrk/midnight-indexer/indexer-api/src/infra/api/v4/subscription/polling.rs` | `IDLE_BACKOFF_MAX_MULTIPLE` |
| The indexer's config sets the progress interval | `github:midnightntwrk/midnight-indexer/indexer-api/config.yaml` | `progress_update_interval` |
| `waitForFunds` takes no timeout and uses the `syncWallet` default of 90 s | `npm:@midnight-ntwrk/testkit-js/dist/index.mjs` | `const waitForFunds = async (wallet, env, fundFromFaucet = false, unshieldedKeystore) =>` `await syncWallet(wallet);` `timeout = 90_000)` |
| The `midnight-examples` cutter writes the indexer host into the manifest | `github:midnightntwrk/midnight-examples/packages/fast-sync/scripts/cut-preseed.ts` | `const indexer = new URL(config.indexer).host;` |
| That cutter seeds only wallets whose birthday is at or after the bundle height | `github:midnightntwrk/midnight-examples/FAST-SYNC.md` | `seeds a wallet whose birthday is at or after the reference height` |
| `midnight-examples` has a funding helper that waits for spendable DUST | `github:midnightntwrk/midnight-examples/packages/fast-sync/src/funding.ts` | `registerNightUtxosForDustGeneration` `availableCoins.length >= minCoins` |
| Spendable DUST is `availableCoins` on the dust wallet, whose state is saved with `serializeState` and read with `restore` | `npm:@midnight-ntwrk/wallet-sdk-dust-wallet/dist/DustWallet.d.ts` | `get availableCoins()` `serializeState(): Promise<TSerialized>` `restore(serializedState: TSerialized)` |
| A wallet cursor that survives renumbering has not shipped | `issue:midnightntwrk/midnight-wallet#781` | `open` |
| Ids that are stable across indexer deployments have not shipped | `issue:midnightntwrk/midnight-indexer#1460` | `open` |

## Reference material

- **Measurements:** claims marked measured were observed once, in the preprod move of `midnightntwrk/midnight-examples`. The numbers are in [this runbook as first written](https://github.com/midnightntwrk/servicedesk/blob/9c63c992a37a6f96ccc2a7f7c40f36cd3c04e03b/runbooks/indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) and `midnightntwrk/servicedesk#216`.
- **Script:** [scripts/check-indexer-cursor.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/indexer-blockfrost-migration-runbook/scripts/check-indexer-cursor.mjs) compares one cursor on two live indexers. No step uses it.
