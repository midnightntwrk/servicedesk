# Runbook: Migrating a Midnight app from the official indexer/RPC to Blockfrost

> **Mainnet (added 2026-09-30, updated 2026-10-02).** The official mainnet indexer and RPC
> (`indexer.mainnet.midnight.network`, `rpc.mainnet.midnight.network`) are **scheduled to shut
> down**. The announced time was 18:00 ET / 22:00 UTC on 2026-09-30, but both official indexers
> (mainnet and preprod) were still answering on 2026-10-02 at ~19:00 UTC. Treat the shutdown as
> imminent and migrate now. While the official indexer is still up, you can **measure your cursor
> offset**: see the `check-indexer-cursor.mjs` bullet below.
>
> Everything below applies to mainnet too: the same URL swap and `project_id` token, the same
> cursor break, the same progress lag. The worked case and every measured number come from
> preprod. On mainnet:
>
> | Service | Official (shutting down) | Blockfrost |
> |---|---|---|
> | Indexer HTTP (GraphQL) | `https://indexer.mainnet.midnight.network/api/v4/graphql` | `https://midnight-mainnet.blockfrost.io/api/v0` |
> | Indexer WS | `wss://indexer.mainnet.midnight.network/api/v4/graphql/ws` | `wss://midnight-mainnet.blockfrost.io/api/v0/ws` |
> | Node RPC HTTP | `https://rpc.mainnet.midnight.network` | `https://rpc.midnight-mainnet.blockfrost.io` |
> | Node RPC WS | `wss://rpc.mainnet.midnight.network` | `wss://rpc.midnight-mainnet.blockfrost.io` (same pattern as preprod; not yet verified on mainnet) |
>
> - **Create a separate Blockfrost project for Midnight Mainnet.** Tokens are per network,
>   so a preprod token gets `403` on mainnet. Append `?project_id=<token>` to every URL, as
>   in [Remediation](#remediation) step 1.
> - **Only saved wallet state from the official indexer is at risk.** The cursor break needs
>   both of these: a wallet that **persisted** its sync state while connected to the official
>   mainnet indexer (`serializeState()` output, a fast-sync/preseed bundle, or stored
>   ledger-event or transaction ids), **and** that state then resumed against Blockfrost.
>   Not affected:
>   - wallet apps that already sync through Blockfrost, or run their own indexer: the
>     shutdown doesn't change their indexer
>   - wallets that sync from genesis on every start
>   - apps that only read contract state (by address, block height or block hash) or submit
>     transactions over RPC: these carry no indexer-issued ids
>
>   The preprod id offsets (−22 ledger events, −30 transactions) have **not** been measured
>   on mainnet, and mainnet numbering may match. Until it's measured, treat affected saved
>   state as not portable. Don't shift cursors. If sync stalls with `values inserted
>   non-linearly…`, discard that wallet's saved state and re-sync it from genesis
>   ([Remediation](#remediation) step 2). A wallet that syncs cleanly needs no action.
> - **Measure the offset before the shutdown if you can.** `check-indexer-cursor.mjs`
>   compares two live indexers, so run it against mainnet (`--a-http`/`--a-ws` official,
>   `--b-*` Blockfrost) while the official indexer still answers. The full mainnet command is in
>   the [cursor-mismatch runbook](../wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md#diagnose).
>   Once the official indexer is gone the script can't help: use the stall symptom above instead.
> - **Official-indexer cursors can break without a migration.** Saved state also broke on the
>   official endpoints after they were re-synced (mainnet ~2026-09-19, preprod ~2026-09-22;
>   `midnight-wallet#781`). See the
>   [cursor-mismatch runbook](../wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md).
> - **Mainnet full-sync time is not measured.** Size sync timeouts generously, well above
>   the 67 min measured on preprod.
> - **Check endpoints and auth** with [Diagnose](#diagnose) step 1, using the mainnet URLs.
>   `system_chain` should return `"Midnight Mainnet"`.

Moving a preprod app off `indexer.preprod.midnight.network` / `rpc.preprod.midnight.network`
and onto Blockfrost is mostly a URL swap plus a `project_id` token. There are two breaks:

- **Blockfrost numbers ledger events and transactions differently from the official
  indexer.** Any wallet sync cursor or fast-sync (preseed) bundle made against one indexer
  fails on the other.
- **Blockfrost's indexer slows its unshielded progress updates on idle subscriptions.**
  Code that waits a short, fixed time for an "unshielded synced" state right after a
  transaction then times out, even though the funds have arrived.

Use this runbook to do the migration, recognise both failures, and pick a remediation.

_Compiled 2026-09-29 from a preprod migration of the `midnight-examples` hello-world suite
(`@midnight-ntwrk/wallet-sdk` 1.2.0, `@midnight-ntwrk/ledger-v8` 8.1.2, midnight-js and testkit-js 4.1.1).
Event ids, offsets and schema fields are point-in-time. Re-run the diagnostic before
asserting any of them. The Midnight ecosystem changes fast._

---

## Symptom

Four failures show up in migration order. The last two are the subtle ones.

- **Every Blockfrost call returns 403.** Indexer HTTP, indexer WS and node RPC all answer
  `{"error":"Forbidden","message":"Missing project token. Please include project_id in your request.","status_code":403}`.
  With a wrong token: `"Invalid project token."`
- **Crash before anything runs** when a config leaves the node WebSocket URL as a
  placeholder (e.g. `nodeWS: 'none'`): the wallet builder calls `new URL(nodeWS)` for its
  relay and submission service and throws `TypeError: Invalid URL`. (Found by reading the
  code; the placeholder was fixed before it ran.)
- **Wallet sync never finishes after switching indexers.** The wallet restores, shielded
  and unshielded sync to complete, but dust sticks at the same `appliedIndex` and the SDK
  logs this on every retry:

  ```
  Wallet.Other: Error while applying sync update
  [cause]: Error: values inserted non-linearly into dust generation tree; expected to insert index 399177, but received 399179.
      at DustLocalState.replayEventsWithChanges (…/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.js)
  ```

  Nothing moves forward. CPU and memory keep ticking up, which looks like progress, until the
  app's sync timeout fires. Seen when restoring a fast-sync/preseed bundle cut against the
  official indexer and then syncing it from Blockfrost. The same applies to any saved wallet
  state (`serializeState()` output) carried across indexers. The exact indices in the
  message vary with the cursor.
- **"Wallet sync timeout" right after funding.** The wallet synced, the faucet NIGHT arrived
  and the balance shows it, but a follow-up sync check then times out. In `midnight-examples`
  it came from `@midnight-ntwrk/testkit-js` `waitForFunds`, which calls `syncWallet` with a
  fixed 90 s timeout:

  ```
  Wallet synced state emission (synced=false): { shielded=true, unshielded=false, dust=false }
  Error: Wallet sync timeout after 90000ms
   ❯ …/@midnight-ntwrk/testkit-js/src/wallet/wallet-utils.ts:87:40
  ```

  `unshielded=false` stays put for minutes after the transaction lands. The same code
  passes against the official preprod indexer.

Also seen on Blockfrost, and harmless: WebSocket subscriptions drop every few minutes.
Each sub-wallet logs one `Wallet.Sync: [object Object]` (`_tag: 'Wallet.Sync'`) to stderr,
then resubscribes from its cursor with exponential backoff (1 s doubling, capped at 2 min)
and carries on. In a 67-minute sync this happened three times: once each for the
unshielded, shielded and dust subscriptions, including the dust one mid-stream. Every
resume was clean. No action is needed unless the error repeats without progress.

## Root cause

**Ledger event ids are the indexer's own numbering, not chain data, and the two preprod
indexers disagree.** Both serve byte-identical `dustLedgerEvents` / `zswapLedgerEvents`
payloads for the same chain (the block hash at height 2684544 matches:
`67b8fa44691e435ee2baf2b7d151e788b6bd6288ccaf937dadee7f640eaf1419`). But:

| Id range (official numbering) | Official indexer | Blockfrost |
|---|---|---|
| ≤ 989780 | contiguous | same ids, same payloads |
| 989781–989802 | no dust or zswap event uses these ids | numbers straight through |
| ≥ 989803 → tip | id N | **id N − 22**, same payload |

At compile time the offset was a constant −22 from 989781 to the tip (`maxId` 1575271
official vs 1575249 Blockfrost). The gap sits between blocks 1130986 (last id 989780) and
1130996 (first id 989803 official, 989781 Blockfrost); the blocks between carry no dust or
zswap events on either indexer, and every block hash matches. Why the official indexer skips
those 22 ids is unconfirmed; tracked in `midnightntwrk/servicedesk#216`. The leading
explanation comes from `midnight-wallet#781`. Preprod checkpoints saved before ~2026-09-22
are off by exactly 22 against today's official indexer. So the hole most likely appeared
when the official indexer was re-synced, and before that its numbering matched Blockfrost's.
The indexer team has not confirmed this.

Wallet sync resumes each ledger-event subscription from a stored event id
(`dustLedgerEvents(id: $id)`, `zswapLedgerEvents(id: $id)` in
`@midnight-ntwrk/wallet-sdk-indexer-client`). A cursor taken on the official indexer points
22 events further along on Blockfrost. The dust wallet then replays the wrong events into
its generation tree, `DustLocalState.replayEventsWithChanges` rejects the out-of-order
insert, and the sync layer retries the same batch forever. Shielded sync can reach
`isStrictlyComplete()` from the same shifted cursor for an empty wallet. That shows only
that no tree insert collided, not that the state is correct, so do not rely on it.

The mechanism isn't specific to Blockfrost. Any change of the database behind a wallet
(another provider, a re-sync of the same endpoint, blue/green) can break a saved cursor. The
general mechanism, the timestamp-error variant and the remediations are in the
[cursor-mismatch runbook](../wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md).
This section keeps the offsets measured between the official indexer and Blockfrost.

**Transaction ids are indexer numbering too.** The same funding transaction
(`c9a01ee7…fd849706`, block 2770188) is id 632821 on the official indexer and 632791 on
Blockfrost, an offset of −30. This was measured on that one transaction; where the offset
starts has not been bisected. The unshielded wallet resumes its
`unshieldedTransactions(address, transactionId)` subscription from its last applied
transaction id. So saved unshielded state is also bound to its indexer, just like the ledger
event cursors above.

**Unshielded "synced" waits on the indexer's next progress poll.** The unshielded wallet
counts as synced (`isStrictlyComplete()`) only when its applied transaction id equals the
indexer's latest `UnshieldedTransactionsProgress.highestTransactionId`, and it must be
connected (`@midnight-ntwrk/wallet-sdk-unshielded-wallet` `SyncProgress.js`). A new
transaction moves the applied id at once. The highest id moves only when the indexer
next sends a progress message, which it does on a timer, not on each new transaction.

The current indexer (`midnight-indexer` `indexer-api/src/infra/api/v4/subscription/unshielded.rs`,
`polling.rs`) polls at `progress_update_interval` (30 s by default). While nothing changes it
backs off up to 8× (about 4 min), with ±20% jitter. Holding one subscription open for 3 min
on each preprod indexer:

| | Progress messages after the first |
|---|---|
| Official indexer | every 30 s, flat |
| Blockfrost | after 35 s, then 55 s, then none in the last 60 s |

The inference is that Blockfrost runs a newer indexer with the idle backoff and the official
preprod endpoint runs an older one without it (not confirmed with either operator). A wallet
that has been idle for a while gets a transaction, and the next progress message can be up
to ~4.8 min away. Any check that waits less than that for `isStrictlyComplete()` fails. By
the same code, shielded progress (`shielded.rs`) should behave alike; that is untested.

The first two symptoms are plain configuration: Blockfrost needs its project token on every
request, and the SDK needs a real `wss://` node URL.

## Key identifiers

- **Endpoints (preprod).** Verified with a real token on 2026-09-29.

  | Service | Official (old) | Blockfrost (new) |
  |---|---|---|
  | Indexer HTTP (GraphQL) | `https://indexer.preprod.midnight.network/api/v4/graphql` | `https://midnight-preprod.blockfrost.io/api/v0` (`/api/v4/graphql` on the same host also answers; `/api/v0/graphql` is 404) |
  | Indexer WS | `wss://indexer.preprod.midnight.network/api/v4/graphql/ws` | `wss://midnight-preprod.blockfrost.io/api/v0/ws` (`graphql-transport-ws`) |
  | Node RPC HTTP | `https://rpc.preprod.midnight.network` | `https://rpc.midnight-preprod.blockfrost.io` |
  | Node RPC WS | `wss://rpc.preprod.midnight.network` | `wss://rpc.midnight-preprod.blockfrost.io` (`/ws` also answers) |
  | Proof server | local `:6300` | unchanged, not a Blockfrost service |

- **Auth.** Blockfrost accepts the token as a `project_id` header **or** a
  `?project_id=<token>` query parameter; a path segment is not recognised. Use the query
  parameter. The SDK clients (`indexerPublicDataProvider`, the wallet SDK indexer client,
  polkadot `WsProvider`) take plain URLs with no header hook, and browser WebSockets cannot
  set headers.
- **CORS.** Blockfrost answers preflight with `access-control-allow-origin: *`,
  `access-control-allow-methods: GET,HEAD,POST`, and any header.
- **GraphQL schema.** Blockfrost has every official field plus extras. The one difference in
  a shared field: `Subscription.dustGenerations` is
  `(dustAddress: DustAddress!, startIndex: Int!, endIndex: Int!)` on the official indexer
  and `(dustAddress: DustAddress!, blockHash: HexEncoded!, dtimeCutoffHeight: Int!)` on
  Blockfrost. No `@midnight-ntwrk` package in the stack above references
  `dustGenerations`. Blockfrost-only additions include contract-event queries
  (`Query.contract`, `Query.contractEvents`, `Subscription.contractEvents`,
  `Block.contractZswapState`, typed shielded/unshielded mint/burn/spend/receive events),
  contract-maintenance types, and a bridge API (`bridgeEvents`, `bridgeBalance`,
  `bridgeDeposits`, `bridgePoolSummary`, …). Code built only on the official schema needs
  no change.
- **Divergence point.** Ledger events: official ids 989781–989802, offset −22 thereafter
  (at compile date). Transactions: −30 at official tx id 632821 (single sample).
- **Error text.** `values inserted non-linearly into dust generation tree` (also seen as
  `… into zswap commitment tree` / `… into dust commitment tree` for other cursor/tree
  mismatches). For the progress lag: `Wallet sync timeout after 90000ms` from testkit
  `syncWallet`, with `unshielded=false` in the emissions just before.
- **Progress polling (current indexer).** `progress_update_interval` 30 s; idle backoff up to
  8× (`IDLE_BACKOFF_MAX_MULTIPLE`); jitter 0.2 (`JITTER_FRACTION`); progress cache TTL 5 s
  (from `midnight-indexer` `qa/tests/tests/e2e/subscription-polling.test.ts`).
- **Full genesis sync on Blockfrost preprod:** 67 min 21 s (2026-09-29, wallet SDK 1.2.0,
  ~1.575M dust events at ~390 events/s; shielded and unshielded finish in the first minutes).
  About the same as the official indexer's ~78 min.

## Diagnose

A Blockfrost token is required: every Blockfrost endpoint rejects anonymous calls. Keep the
token in your environment, never on the command line or in a committed file.

1. **Endpoints and auth** (should print a height, then `"Midnight Preprod"`):

   ```sh
   export BLOCKFROST_PROJECT_ID=<your preprod project token>
   curl -s -X POST -H 'content-type: application/json' \
     -d '{"query":"query { block { height hash } }"}' \
     "https://midnight-preprod.blockfrost.io/api/v0?project_id=$BLOCKFROST_PROJECT_ID"
   curl -s -X POST -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"system_chain","params":[]}' \
     "https://rpc.midnight-preprod.blockfrost.io?project_id=$BLOCKFROST_PROJECT_ID"
   ```

2. **Is the stored cursor portable?** Run
   [`scripts/check-indexer-cursor.mjs`](scripts/check-indexer-cursor.mjs) (Node ≥ 22, no
   `npm install`, read-only). It probes the target endpoints, checks both indexers are on the
   same chain, then fetches the event at your cursor from both and compares payloads. When
   they differ, it finds the same payload on the target and reports the id offset.

   ```sh
   # A cursor you already have (e.g. the stuck appliedIndex from the sync log):
   node check-indexer-cursor.mjs --id 1557519
   # A fast-sync / preseed bundle's cursors, read from its manifest:
   node check-indexer-cursor.mjs --manifest preseed/preprod/manifest.json
   ```

   Output for a bundle cut against the official indexer, checked against Blockfrost:

   ```
   == 3. Cursor portability
     dust @ 1557519: NOT PORTABLE (A's first event is id 1557519, B's is id 1557519, payloads differ)
       same payload found on B at id 1557497: offset -22 (B id = A id - 22)
   ```

   Exit code `2` means not portable: the symptom above is this root cause. Exit `0`
   (`PORTABLE`) means the cursor is fine and the stall is something else. Exit `1` means the
   check itself failed; read its output. Defaults compare the official preprod indexer (A)
   to Blockfrost preprod (B); `--a-http --a-ws --b-http --b-ws --b-rpc` override them.

## Remediation

Most practical first. No funds are at risk in any of these: a stuck sync never submits
anything.

1. **Do the config migration properly.**
   - Swap all four URLs.
   - Append `?project_id=<token>` to each, read from an env var (e.g.
     `BLOCKFROST_PROJECT_ID` in a gitignored `.env.<network>`).
   - Leave no placeholder `nodeWS`.
   - Build the config when it's used, not at import time, and fail fast with a clear
     message when the token is missing.

   The shape used in `midnight-examples`:

   ```ts
   function withBlockfrostKey(url: string, projectId: string): string {
     return `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(projectId)}`;
   }
   export function preprodConfig(): NetworkConfig {
     const projectId = process.env['BLOCKFROST_PROJECT_ID']?.trim();
     if (!projectId) throw new Error('BLOCKFROST_PROJECT_ID is not set.');
     return {
       networkId: 'preprod',
       indexer:   withBlockfrostKey('https://midnight-preprod.blockfrost.io/api/v0', projectId),
       indexerWS: withBlockfrostKey('wss://midnight-preprod.blockfrost.io/api/v0/ws', projectId),
       node:      withBlockfrostKey('https://rpc.midnight-preprod.blockfrost.io', projectId),
       nodeWS:    withBlockfrostKey('wss://rpc.midnight-preprod.blockfrost.io', projectId),
       proofServer: process.env['MIDNIGHT_PROOF_SERVER'] ?? 'http://127.0.0.1:6300',
     };
   }
   ```

   Move **every** consumer at once: app config, test harnesses, scaffold templates, and
   scripts that cut preseed bundles or mint wallets. A half-migrated repo mints cursors on
   one indexer and replays them on the other.

2. **Re-sync wallets from genesis on the new indexer.** Discard saved wallet state from the
   old indexer. Do **not** migrate `serializeState()` output. A fresh wallet created against
   the new indexer, or an existing seed restored with a full sync, is correct by
   construction. The cost is the full sync time, dominated by dust: 67 min on Blockfrost
   preprod, ~78 min on the official indexer. Check the app's sync timeout covers that. In
   `midnight-examples`, `syncWallet`'s `Rx.timeout({ each })` sits after the "is complete"
   filter, so it caps the **whole** sync, not the gap between progress updates. Its 60 min
   default failed at 89% dust (raise it with `MIDNIGHT_SYNC_TIMEOUT_MS`). Test runners need
   the same headroom in their hook timeouts (vitest `--hookTimeout`).

3. **Cut a fast-sync / preseed bundle against the target indexer.** A bundle's cursors are
   only valid on the indexer that produced them. Cut with the cutter pointed at Blockfrost
   and **from genesis** (in `midnight-examples`: `yarn preseed:cut --from-genesis`).
   Bootstrapping the cutter from an official-indexer bundle fails with the same error.
   Keep one bundle per indexer and record the indexer URL in the manifest. Wallet birthday
   rules still apply: re-cutting means re-minting and re-funding wallets whose birthday
   predates the new bundle.

4. **Pin cursor-bearing consumers to one indexer (interim).** If only part of the stack can
   move, keep wallet sync on the indexer its cursors came from. Reads keyed by contract
   address, block height or block hash, and tx submission over RPC, carry no ledger-event
   cursor and can use Blockfrost.

5. **Don't gate on a short strict-sync check after a transaction.** On Blockfrost (and on
   any indexer with idle progress backoff), `isStrictlyComplete()` for unshielded can stay
   false for up to ~4.8 min after a transaction. Wait for what you actually need instead:
   - after a faucet transfer, the NIGHT balance;
   - before a transaction that pays fees, spendable DUST (`state.dust.availableCoins`);
   - otherwise `isCompleteWithin(n)`, or a timeout well over 5 min.

   testkit's `waitForFunds` can't be configured (its `syncWallet` is fixed at 90 s).
   `midnight-examples` replaced it in `packages/fast-sync/src/funding.ts`. It registers
   unregistered NIGHT UTXOs with `wallet.registerNightUtxosForDustGeneration` →
   `finalizeRecipe` → `submitTransaction` (the same calls testkit makes), then waits for a
   spendable DUST coin. Verified 2026-09-30: on Blockfrost preprod the registration was
   submitted 2 s after sync completed and DUST was spendable 14 s later. The hello-world
   suite then passed (deploy and `storeMessage`), where the testkit path had timed out.

6. **Not recommended: shift cursors by the offset.** Subtracting 22 from every stored event
   id (or 30 from transaction ids) lines them up today. But the offsets come from the
   indexers numbering differently, and any future skip on either side silently changes
   them. Treat cursors as bound to their indexer. A re-anchoring approach that checks each
   candidate event against the saved state, with its caveats, is in the
   [cursor-mismatch runbook](../wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md#remediation).

**Browser DApps.** With the connector API, endpoints come from the user's wallet
(`getConfiguration()` → `indexerUri`, `indexerWsUri`, `substrateNodeUri`), not from DApp
code. Whether Lace accepts a custom Blockfrost URL with a `project_id` query was not tested.
A token placed in browser-side URLs is visible to anyone who loads the page; use a
server-side proxy or a token scoped for public use.

## Reference material

- Worked case: preprod migration of `midnightntwrk/midnight-examples` hello-world
  (2026-09-29). Upstream tracking for the id gap: `midnightntwrk/servicedesk#216`; for the
  SDK cursor design: `midnightntwrk/midnight-wallet#781`. Relevant
  files in that repo:
  `examples/hello-world/src/config.ts` (the migrated config);
  `packages/fast-sync/src/funding.ts` (funding gate without testkit `waitForFunds`);
  `packages/fast-sync/src/fast-wallet.ts` (`new URL(env.nodeWS)` for relay and submission;
  seeds sub-wallets from a reference bundle); `packages/fast-sync/scripts/cut-preseed.ts`
  (`--from-genesis`); `FAST-SYNC.md` ("When a bundle goes bad").
- SDK: `@midnight-ntwrk/wallet-sdk-indexer-client` `DustLedgerEvents` / `ZswapLedgerEvents`
  subscriptions (`dustLedgerEvents(id: $id) { id raw maxId }`);
  `@midnight-ntwrk/wallet-sdk-dust-wallet` `dist/v1/Sync.js` (resume by `id`);
  `@midnight-ntwrk/ledger-v8` `DustLocalState.replayEventsWithChanges` (the throw site).
  Unshielded: `@midnight-ntwrk/wallet-sdk-indexer-client` `UnshieldedTransactions`
  (`unshieldedTransactions(address, transactionId)`, yields `UnshieldedTransaction` or
  `UnshieldedTransactionsProgress { highestTransactionId }`);
  `@midnight-ntwrk/wallet-sdk-unshielded-wallet` `dist/v1/SyncProgress.js`
  (`isStrictlyComplete` = connected and applied id == highest id) and `dist/v1/Sync.js`;
  `@midnight-ntwrk/testkit-js` 4.1.1 `syncWallet` / `waitForFunds` (fixed 90 s).
- Indexer: `midnightntwrk/midnight-indexer`
  `indexer-api/src/infra/api/v4/subscription/unshielded.rs` (`progress_updates`),
  `…/subscription/polling.rs` (`next_poll_interval`), `indexer-api/config.yaml`
  (`progress_update_interval: "30s"`).
- Official endpoints: <https://docs.midnight.network/guides/networks-and-environments>.
- Open questions to settle before relying on this long-term:
  - Why the official preprod indexer skips ids 989781–989802, and whether more skips should
    be expected (indexer team; `servicedesk#216`). `midnight-wallet#781` points to a re-sync
    around 2026-09-22 on preprod, and to renumbering on mainnet (offset 13 since ~09-19, 37
    for a 09-01 checkpoint).
  - Blockfrost request quotas for a full genesis sync (preprod event ids run to ~1.58M).
  - Lace support for custom Blockfrost endpoints.
  - Which indexer versions Blockfrost and the official preprod endpoint run. The progress
    backoff is inferred from observed message timing, and once the official endpoint
    upgrades, apps hit the same funding-time failure there.
  - Where the −30 transaction-id offset starts, and whether it is constant.
  - Whether Blockfrost drops WebSocket subscriptions deliberately (idle timeout or
    connection lifetime) or intermittently.
