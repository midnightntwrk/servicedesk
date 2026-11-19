# Notes: `check-wallet-sync.mjs` and `watch-sync.ts`

What the scripts do, the measurements behind the
[Preprod wallet sync runbook](../wallet-preprod-sync-runbook.md), and how the scripts were tested.
Both read only: no keys, nothing signed or submitted. The wallet SDK 1.2.0 (ledger 8) version of
these notes, with its snapshot and stall measurements, is in the git history before the wallet
SDK 2.x rewrite.

## What `check-wallet-sync.mjs` reads

| Check | How | Output |
|---|---|---|
| Indexer | `{ block { height } }` over HTTP | the tip, or the 403 / 410 hint |
| Newest DUST and shielded event | one `dustLedgerEvents` / `zswapLedgerEvents` event, its `maxId` | what a fresh default start replays |
| Ledger 9 DUST start | binary search over `dustLedgerEvents(id)` for the first `protocolVersion` at or above 2000000 (`forks.v9`), the same search as `findDustTimelineStart` in `wallet-sdk-dust-wallet` | the `dustTimelineStartProbe` answer: the last ledger 8 event's id as `cursor`, and the first ledger 9 event's version |
| Saved state | each `--state` file, the string a sub-wallet's `serializeState()` returns | its position, how far behind, `still on ledger 8` (DUST `protocolVersion` below 2000000 and `offset` below the cursor), `eventless (projections)` (DUST `syncKind`) |

Each lookup opens its own socket and waits up to 15 s, three tries. The SDK's search waits 10 s per
lookup on one shared connection and, through Blockfrost, never finished (below).

## Measurements (Preprod, through Blockfrost)

All on a laptop on a home connection; the connection varied a lot between days.

| Date | Wallet SDK | What | Result |
|---|---|---|---|
| 2026-11-13 | 2.0.0 | fresh wallet, default `DustWallet` (testkit 5.0.0) | DUST 3,518 events at 11 min, 6,477 at 20 min: about 300 to 400 a minute |
| 2026-11-13 | 2.0.0 | shielded, default batches | about 1.49 million event ids in 57 min |
| 2026-11-13 to 14 | 2.0.0 | overnight sync after `ECONNRESET` and an RPC timeout | DUST stopped at one position from 23:56 until the 3-hour limit; restarts from saved state resumed |
| 2026-11-14 | 2.0.0 | `skipLedgerV8DustHistory: true` | search found nothing, 4 of 4 runs, 12 to 29 s; logged `Could not read the dust event at 1672499` (`TimeoutException: Operation timed out after '10s'`); the wallet started on the ledger 8 variant |
| 2026-11-14 | 2.0.0 | eventless DUST (`CustomDustWallet` with `makeEventLessSyncService`) | DUST synced in seconds; facade `protocol={"_tag":"Crossing","from":"0","to":"2001100","behind":["dust"]}` for good; testkit `syncWallet` never returned |
| 2026-11-14 | 2.0.0 | `DustWallet` with our own probe, batches of 500 | started at cursor 1,857,961; about 53,000 events from 08:54 to 10:36 through several connection drops; facade `Settled` on 2001100 |
| 2026-11-17 | 2.0.0 | restore from saved state | synced in 4.1 to 5.9 s; after three days away, 125.8 s |
| 2026-11-18 | 2.0.1 | `skipLedgerV8DustHistory`'s search, called directly (`SyncService.findDustTimelineStart`) | `Option.none()`, 4 of 4 runs, 19 to 24 s |
| 2026-11-18 | 2.0.1 | `check-wallet-sync.mjs` search | cursor 1857961, version 2001100, 23 lookups, 20 to 21 s (three runs) |
| 2026-11-18 | 2.0.1 | fresh throwaway DUST wallet with the probe answer, batches of 500 | protocol 2001100 throughout; 130,000 events (1,857,961 to 1,988,859) in 222 s; snapshot 7.5 KB |
| 2026-11-18 | 2.0.1 | fresh throwaway DUST wallet, default start, 3 minutes | default batches: 10,371 events, protocol 22000 (ledger 8), snapshot 130 KB; batches of 500: 55,545 events |

The Preprod tests behind the 13 to 17 November rows are summarised in
[servicedesk#319](https://github.com/midnightntwrk/servicedesk/issues/319) and its comments.

## Tests

- `node test-check-wallet-sync.mjs` (about 55 s, 15 cases): a mock indexer on 127.0.0.1 whose DUST
  events cross into ledger 9 at a fixed id, with gaps in the ids as on a real chain. Covers the
  search on a crossed chain, a chain born on ledger 9, `--no-search` (a ledger 8 DUST state is still
  flagged), `--fork-v9`, lookups that never answer, state files of every kind (ledger 8, eventless,
  past the tip, a JSON-encoded string, `null` or a number), the 403 and 410 hints, and bad
  arguments.
- `node test-watch-sync.mjs` (9 cases, Node 22.18 or later): a fake facade; stall detection per
  sub-wallet, sleep handling, and the `Crossing` warning.
- `watch-sync.ts` and the runbook's code type-check with `tsc --strict` against wallet SDK 2.0.1.
