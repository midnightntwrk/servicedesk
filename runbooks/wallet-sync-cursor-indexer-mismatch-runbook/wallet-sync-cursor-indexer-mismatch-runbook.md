# Runbook: Wallet sync stuck after the indexer changed (saved cursor no longer matches)

A wallet restored from saved state (`serializeState()` output, a fast-sync/preseed bundle,
or any stored ledger-event or transaction id) fails on its **first** sync update and never
recovers. The saved state is fine. The cursor it resumes from is an id that only one indexer
deployment assigned, and the indexer it now talks to numbers the same events differently.

This happens whenever the indexer behind a wallet changes:

- **Switching provider.** For example, the official indexer to Blockfrost. The Blockfrost
  specifics are in the
  [Blockfrost migration runbook](../indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md).
- **The operator re-syncs or replaces the database behind the same URL.** Nothing changes on
  your side; the wallet just breaks one day (`midnight-wallet#781`).
- **Load balancing or blue/green between two indexer databases.** This is a hypothesis for
  `midnight-wallet#643`, not confirmed.

_Compiled 2026-10-02 from `midnight-wallet#781`, `servicedesk#216` and the Blockfrost
migration runbook. Source read at `@midnight-ntwrk/wallet-sdk-dust-wallet` 4.2.0 and
5.0.0-rc.0, and `midnight-ledger` tags `ledger-8.1.0` and `ledger-8.1.3`. Ids, offsets and
versions are point-in-time. Re-verify before asserting them._

---

## Symptom

- Shielded and unshielded sync may complete, but **dust stays at the same `appliedIndex`**,
  and the SDK logs the same error on every retry:

  ```
  Wallet.Other: Error while applying sync update
  [cause]: Error: values inserted non-linearly into dust commitment tree; expected to insert index 118195, but received 118183.
      at DustLocalState.replayEventsWithChanges (…/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.js)
  ```

  Seen with `dust generation tree`, `dust commitment tree` and `zswap commitment tree`. The
  indices vary with the cursor.
- Or the timestamp variant, from the same call site:

  ```
  received an event with a timestamp prior to the time already synced to (synced to: Timestamp(1790009862), event time: Timestamp(1790009850))
  ```

- `Stream.retry` re-subscribes from the same cursor, so it fails the same way after every
  retry and every process restart. CPU and memory can tick up, which looks like progress,
  until a sync timeout fires.
- It **starts on a particular date with no deploy or config change on your side**, or right
  after you pointed the app at a different indexer.
- A fresh wallet, or the same seed synced from genesis, works.

**Reading the numbers.** `expected` is the next tree index in your saved state. `received`
is the index of the event the indexer sent.

- `received < expected`: the cursor points **behind** your state, so the indexer is
  re-sending events you already applied (#781 mainnet).
- The timestamp variant: also behind. A re-sent event is older than the time already synced
  (#781 preprod).
- `received > expected`: the cursor points **ahead**, so events were skipped (#643 saw ~20
  ahead).

## Root cause

**The resume cursor is the indexer's database row id, not a chain position.**

- **What the dust wallet saves.** It stores `offset: w.progress?.appliedIndex` when it
  serializes (`dist/v1/Serialization.js`). That value is the id of the last
  `dustLedgerEvents` event it applied.
- **Where it resumes.** On restore, it resubscribes with `dustLedgerEvents(id: appliedIndex - 1)`
  (`dist/v1/Sync.js`, `resumeFrom = appliedIndex - 1n`), and the inclusive cursor re-delivers
  the boundary event. Verified in 4.2.0 and unchanged in 5.0.0-rc.0.
- **Where the id comes from.** In `midnight-indexer`, the id is `ledger_events.id BIGSERIAL`.
  One sequence is shared by dust, zswap and contract events (wallet PR #750 describes this).
  So gaps inside one stream are normal. The numbers come from whichever database stored the
  event, not from the chain.
- **What changes it.** Re-indexing the same chain into a new database, or a second indexer
  instance, can number the same event differently. For example, sequence values consumed by
  rolled-back writes leave holes. The ledger then gets events that don't follow its state and
  rejects them. That check is correct.

Evidence that ids move on the **same** endpoint (#781, measured by the reporter against their
own saved checkpoints with the same ledger build):

| Network | Checkpoints | Offset to today's official indexer |
|---|---|---|
| Mainnet | 07-24, 08-08, 08-20 | 0 |
| Mainnet | 09-01 | 37 |
| Mainnet | six between 09-16 and 09-19 (212 events of sync, gap constant) | 13 |
| Preprod | from before ~09-22 | 22 |

The preprod 22 matches the 22-id hole the official preprod indexer has at ids
989781–989802 (`servicedesk#216`). Blockfrost has no hole there. So the reporter's older
preprod checkpoints were numbered the way Blockfrost numbers today, and the official indexer
gained the hole later. The leading explanation is that the official indexer was re-synced
around then. The indexer team has not confirmed this.

**Unshielded state has the same problem.** The unshielded wallet resumes
`unshieldedTransactions(address, transactionId)` from its last applied transaction id, which
is also indexer numbering. One funding transaction is id 632821 on the official preprod
indexer and 632791 on Blockfrost.

**Not a ledger bug, and a ledger upgrade does not fix it.**

- Both error strings still exist in `ledger-v8` 8.1.3 (`ledger/src/error.rs`), the current
  `latest`.
- Between `ledger-8.1.0` and `ledger-8.1.3`, `ledger/src/dust.rs` changed only in two places:
  `seq` increments now saturate, and `time_to_cap` guards a zero decay rate.
- 8.1.2 and 8.1.3 are security patches (stricter deserialization, canonical field values).
  Upgrade for those reasons, but don't expect the upgrade to fix a stuck sync.
- Wallet PR #750 (dust `OutOfOrderSyncUpdateError`, in 5.0.0-rc.0) rejects **out-of-order**
  batches. A renumbered stream is still in ascending order, so it isn't caught there either.

## Key identifiers

- **Error sites.**
  - `midnight-ledger` `ledger/src/error.rs` (the `values inserted non-linearly into {tree_name}
    tree` and `received an event with a timestamp prior to the time already synced to`
    messages)
  - thrown from `DustLocalState.replayEventsWithChanges`
  - reached via `CoreWallet.applyEventsWithChanges` → `Sync.applyUpdate` in
    `@midnight-ntwrk/wallet-sdk-dust-wallet`
- **Cursor code.**
  - `@midnight-ntwrk/wallet-sdk-dust-wallet` `dist/v1/Serialization.js` (`offset`) and
    `dist/v1/Sync.js` (`resumeFrom`)
  - `@midnight-ntwrk/wallet-sdk-indexer-client` subscriptions `dustLedgerEvents(id: $id)`,
    `zswapLedgerEvents(id: $id)`, `unshieldedTransactions(address, transactionId)`
- **Known offsets** (point-in-time; don't apply them blindly):
  - mainnet official renumbering: 13, and 37 for an older checkpoint (#781)
  - preprod official renumbering: 22 (#781, `servicedesk#216`)
  - official preprod → Blockfrost preprod: −22 events after id 989780, −30 at tx id 632821
    (Blockfrost runbook)

## Diagnose

1. **Confirm the pattern.**
   - Restored or saved state, not a fresh wallet.
   - The first update fails with one of the errors above, at the same `appliedIndex` on
     every retry.
   - It started when the indexer changed, or on a date with no change on your side.
   - A fresh wallet on the same indexer syncs.
2. **Two indexers are live (e.g. official and Blockfrost).** Compare a cursor on both with
   [`check-indexer-cursor.mjs`](../indexer-blockfrost-migration-runbook/scripts/check-indexer-cursor.mjs)
   (Node ≥ 22, read-only, no `npm install`; needs a Blockfrost token for the Blockfrost side).
   It reports `PORTABLE` (exit 0) or `NOT PORTABLE` with the offset (exit 2). Its defaults are
   preprod. For mainnet, override all five URLs:

   ```sh
   export BLOCKFROST_PROJECT_ID=<your mainnet project token>
   node check-indexer-cursor.mjs --id <stuck appliedIndex> \
     --a-http https://indexer.mainnet.midnight.network/api/v4/graphql \
     --a-ws   wss://indexer.mainnet.midnight.network/api/v4/graphql/ws \
     --b-http https://midnight-mainnet.blockfrost.io/api/v0 \
     --b-ws   wss://midnight-mainnet.blockfrost.io/api/v0/ws \
     --b-rpc  https://rpc.midnight-mainnet.blockfrost.io
   ```

   This only works while both indexers answer.
3. **Same endpoint, renumbered underneath you.** No tool can compare against the indexer's
   past numbering. Rely on the pattern in step 1. If you kept older snapshots, restore a few
   from different dates. If older ones still sync and newer ones don't (or the reverse), the
   numbering moved between them.

## Remediation

No funds are at risk: a stuck sync never submits anything.

1. **Re-sync from genesis on the indexer you will stay on.** Discard the saved state and
   restore the seed with a full sync. This is correct by construction. Dust dominates the
   time: about 67 min on Blockfrost preprod and about 78 min on the official preprod indexer.
   Mainnet hasn't been measured. Set sync timeouts well above that.
2. **Tie every snapshot to its indexer.** Store the indexer URL (and a deployment marker if the
   operator exposes one) next to every snapshot and preseed bundle. On restore, if it doesn't
   match the indexer you're connected to, discard the snapshot and re-sync. A renumbering
   behind the same URL defeats this, so keep (1) as the fallback.
3. **Interim: re-anchor the cursor by validating against the state.** The #781 reporter
   probes forward from the saved `offset` until `replayEventsWithChanges` accepts an event,
   then rewrites `offset` before `restore()`. This healed both of their networks. It is
   safer than a fixed shift because the ledger checks each candidate. The risk is that events
   which insert nothing into a tree can be skipped without an error, and that can leave the
   state wrong. Before trusting a re-anchored wallet, compare its balances and coins with a
   genesis sync of the same seed (1).
4. **Not recommended: shift cursors by a known offset.** The offsets come from database
   numbering, and the next re-sync or skip changes them without warning.
5. **Real fix (upstream).** `midnight-wallet#781` asks for any of:
   - a chain-derived cursor (tree indices, or block height plus position)
   - `restore()` checking the cursor against the state and re-anchoring it
   - at minimum, a distinct "snapshot cursor does not match this indexer" error instead of
     endless retries

   `servicedesk#216` asks the indexer team whether ids are meant to be stable across
   deployments. Watch both issues.

## Reference material

- Worked cases:
  - `midnightntwrk/midnight-wallet#781`: mainnet and preprod, official-indexer re-sync, with
    measured gaps and a probe-forward workaround
  - `midnightntwrk/midnight-wallet#643`: preprod faucet on `indexer-preprod-blue`, received
    ~20 ahead, possibly blue/green
- Tracking:
  - `midnightntwrk/servicedesk#216`: the 22-id hole on the official preprod indexer, and
    whether ids are stable across deployments
  - `midnightntwrk/midnight-wallet#781`: the fix
- Related:
  - [Blockfrost migration runbook](../indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md):
    endpoints, `project_id`, offsets measured against Blockfrost, preseed bundles,
    unshielded progress lag
  - wallet PR #750 (dust rejects out-of-order batches; shared `BIGSERIAL` explanation)
- Source:
  - `@midnight-ntwrk/wallet-sdk-dust-wallet` 4.2.0 and 5.0.0-rc.0: `dist/v1/Serialization.js`,
    `dist/v1/Sync.js`
  - `midnight-indexer` `indexer-common/migrations/postgres/001_initial.sql` (`ledger_events`)
  - `midnight-ledger` `ledger/src/error.rs`, `ledger/src/dust.rs` at `ledger-8.1.3`
