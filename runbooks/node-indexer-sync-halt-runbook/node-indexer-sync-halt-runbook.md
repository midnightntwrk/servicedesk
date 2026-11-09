# Runbook: self-hosted node or indexer stops on a block the chain accepted

A self-hosted Midnight indexer, or a node syncing from genesis, stops at a block the rest of the
network accepted, with `Intent TTL has expired` or `dust is outside of its validity window`. It stops
at the same block after every restart. Nothing is wrong with the
chain or the setup: the block's first transaction is valid at its block's own time, at its parent's
time + 12 s, or at both, and the software checks it at a time the transaction isn't valid at. Run
the checker below. It finds the block, works out which time the transaction is valid at, and names
the releases that check the right time.

_Compiled 2026-10-15 from the five halts reported so far, each re-measured against the chain that day:
the block's and its parent's timestamps, the block's runtime, and the ledger's well-formed check on the
real transaction at each time. Reviewed by an independent fact-check and by an operator run of the
runbook on three halts. Method and results are in
[`scripts/check-sync-halt.NOTES.md`](scripts/check-sync-halt.NOTES.md). Sources, pinned:_

- _midnight-indexer tags: `v4.3.3` (`indexer-common/src/domain/ledger/ledger_state.rs`), and
  `v4.3.4`, `v4.3.5`, `v4.3.7`, `v4.4.0-rc.1`, `v4.4.0-rc.2` and `v4.3.800-rc.2`
  (`chain-indexer/src/domain/ledger_state.rs`); the `v4.3.800-rc.2` `CHANGELOG.md` and
  `indexer-standalone/config.yaml`_
- _midnight-node tags `node-1.0.300` (`ledger/src/versions/common/mod.rs`) and `node-1.0.400`
  (commit `5defaf5de4dbc4b45f69ae83301d6b20a61add45`), and the node-1.0.400 release notes_
- _`@midnight-ntwrk/ledger-v8` 8.1.2, for the well-formed check and to decode the chains' ledger
  parameters_
- _The public Preview indexer and RPC, Blockfrost's Preprod indexer and RPC, and
  `rpc.mainnet.midnight.network` (retired, still answering on 2026-10-15) for the block data_

_Updated 2026-11-09 for ledger 9: every network now runs node 2.1.101 and needs indexer 4.4.101, which
both have the fix (`check-sync-halt.mjs --versions`, and the
[v4.4.101 release notes](https://github.com/midnightntwrk/midnight-indexer/releases/tag/v4.4.101))._

_Releases move: run `check-sync-halt.mjs --versions` before quoting a version from this page._

---

## Symptom

The indexer exits, and exits again after every restart, on one of these (the numbers vary):

```text
index_blocks_task failed: apply transactions to ledger state: cannot apply regular transaction d9fd8f7fd5e1462f02bb862c437ad9b75e3f63ed55a3e84ec8d90fa2a44f3284: malformed transaction: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1791908899), Current block: Timestamp(1791908904)
```

```text
index_blocks_task failed: apply transactions to ledger state: cannot apply regular transaction d3f88e6b08607a2d3e0179a07b92eded2518194de529fe2d3cf3e07fc52c96f2: malformed transaction: dust is outside of its validity window (declared time: Timestamp(1784890545), window: [Timestamp(1784879742), Timestamp(1784890542)])
```

`indexer-standalone` logs it as `chain-indexer exited with ERROR`; the separate `chain-indexer` image
as `process exited with ERROR`. From indexer `4.3.800-rc.2` the line also names the block:
`apply transactions of block <hash> at height <height> to ledger state`.

A node syncing from genesis stops importing on:

```text
Transaction malformed: transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1784643562), Current block: Timestamp(1784643564)
Transaction(3) failed due to Invalid(Custom(182)). Aborting the rest of the block execution.
```

On Mainnet, node 1.0.300 does this after importing #1788979: #1788980 is the block it rejects.

What gives it away: the TTL is a few seconds before the "Current block" time, and the software stops at
the same block on every restart, whatever image of the same version you pull. A fresh sync stops at an
old block. An indexer that follows the tip can also stop at a block only minutes old.

**Not this runbook:**

- A transaction your DApp submits now, rejected with `1010: Invalid Transaction: Custom error: 182`:
  its TTL really has passed. See [Node rejection codes](../node-1010-custom-error-runbook/node-1010-custom-error-runbook.md).
- A wallet that can't sync (`values inserted non-linearly`, or progress that stops): see the
  [Preprod wallet sync](../wallet-preprod-sync-runbook/wallet-preprod-sync-runbook.md) runbook.
- An indexer that exits at a runtime upgrade block (for example with `CodeUpdated not found`): a
  different bug ([midnight-node#1960](https://github.com/midnightntwrk/midnight-node/issues/1960),
  [midnight-indexer#1397](https://github.com/midnightntwrk/midnight-indexer/issues/1397)).

## Root cause

Which time a block's first transaction was checked at depends on the runtime that built the block.

- **Runtimes before 1.0.300 (0.22 and 1.0.0).** When a transaction entered a node's pool, the node
  checked it against the parent's time + 12 s and cached the result under the current ledger state.
  When the author built the next block, the block's first regular transaction could reuse that cached
  result instead of being checked at the block's own time
  ([midnight-node#1924](https://github.com/midnightntwrk/midnight-node/issues/1924)). If the
  transaction had waited past another block, the cache entry belonged to an older ledger state and
  missed, so it was checked at block time
  ([midnight-indexer#1610](https://github.com/midnightntwrk/midnight-indexer/pull/1610)). Later
  transactions in a block were always checked at block time. The block doesn't record which time was
  used.
- **Runtime 1.0.300 and later.** Every transaction is checked at the block's own time. In node
  1.0.300's ledger host functions, version 1 skews the first transaction's time and version 2, which
  runtime 1.0.300 imports, doesn't. The networks moved to runtime 1.0.300 at Preprod #2648468
  (2026-09-21), Mainnet #2738210 (2026-09-25) and Preview #1074620 (2026-09-29).

So a block's first regular transaction can be valid at only one of the two times:

- **Pattern A: valid at the block's own time, not at parent + 12 s.** Its TTL is in
  [block time, parent + 12 s), or, after a gap of more than 12 s between blocks, its DUST time is in
  (parent + 12 s, block time]. This can happen in any block, and in blocks from runtime 1.0.300 any
  first transaction with a short TTL can do it.
- **Pattern B: valid at parent + 12 s only.** Its DUST time is in (block time, parent + 12 s]. Only
  blocks from runtimes before 1.0.300 have these.

Software that replays the chain has to accept either time for old blocks, and block time for new
ones. A version that checks a different time stops at the first block that doesn't fit, and stops there
on every restart, because the block is permanent:

| Software | Checks a block's first transaction at | Stops on |
|---|---|---|
| Indexer v4.3.3 and earlier, v4.4.0-rc.1 | the block's own time | pattern B (old blocks only) |
| Indexer v4.3.4 | the block's own time + 12 s ([#1367](https://github.com/midnightntwrk/midnight-indexer/pull/1367)) | pattern A, and transactions valid at both times whose TTL ends before block time + 12 s (Preview 128537) |
| Indexer v4.3.5 to v4.3.800-rc.1, v4.4.0-rc.2 to v4.4.0-rc.5 | parent + 12 s, for every block ([#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371)) | pattern A, including new blocks: an ongoing risk on every network since its runtime 1.0.300 upgrade ([#1537](https://github.com/midnightntwrk/midnight-indexer/pull/1537)) |
| Indexer v4.3.800-rc.2 | old blocks: the block's own time, then parent + 12 s; blocks from runtime 1.0.300: the block's own time ([#1610](https://github.com/midnightntwrk/midnight-indexer/pull/1610) and [#1537](https://github.com/midnightntwrk/midnight-indexer/pull/1537), as [#1612](https://github.com/midnightntwrk/midnight-indexer/pull/1612) and [#1548](https://github.com/midnightntwrk/midnight-indexer/pull/1548)) | neither |
| Node 1.0.300 (and 2.1.0-rc.3) | old blocks: parent + 12 s ([midnight-node#1932](https://github.com/midnightntwrk/midnight-node/pull/1932), [#1964](https://github.com/midnightntwrk/midnight-node/pull/1964)) | pattern A |
| Node 1.0.400 | old blocks: parent + 12 s, then the block's own time ([midnight-node#2216](https://github.com/midnightntwrk/midnight-node/pull/2216), as [#2238](https://github.com/midnightntwrk/midnight-node/pull/2238)) | neither |

The known blocks, re-measured on 2026-10-15. For each one, the ledger's well-formed check on the real
transaction passes at the time the chain used and fails at the time the halted software used:

| Network | Block | Runtime | First transaction | Block time | Parent + 12 s | TTL or DUST time | Pattern | Stopped |
|---|---|---|---|---|---|---|---|---|
| Preview | 112450 | 1.0.0 | `d3f88e6b…` | 1784890542 | 1784890548 | DUST time 1784890545 | B | indexer, a `main` build after v4.3.3 ([midnight-indexer#1365](https://github.com/midnightntwrk/midnight-indexer/issues/1365)) |
| Preview | 128537 | 1.0.0 | `3864da18…` | 1784987076 | 1784987082 | TTL 1784987084 | valid at both | indexer v4.3.4, checking at 1784987088 ([midnight-indexer#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371)) |
| Preprod | 164460 | 0.22 | `6a1005ee…` | 1775081616 | 1775081622 | TTL 1775081620 | A | indexer `main` build ([midnight-indexer#1461](https://github.com/midnightntwrk/midnight-indexer/issues/1461)) |
| Mainnet | 1788980 | 1.0.0 | `e769b827…` | 1784643558 | 1784643564 | TTL 1784643562 | A | node 1.0.300 ([midnight-node#2229](https://github.com/midnightntwrk/midnight-node/issues/2229)) |
| Mainnet | 2998112 | 1.0.300 | `d9fd8f7f…` | 1791908898 | 1791908904 | TTL 1791908899 | A | indexer on `latest`, 4.3.7 (operator report, 2026-10-15) |

A fresh sync meets the old blocks in height order. Mainnet 2998112 is the other kind: a new block, 18
days after Mainnet's runtime 1.0.300 upgrade, that stopped an indexer following the tip. More blocks
like it can appear on any network at any time.

## Key identifiers

- **The two times:** the block's own timestamp, and its parent's timestamp + 12 s (two 6 s slots).
  Both are in whole seconds in the errors (`Timestamp(…)`); block timestamps on chain are
  milliseconds.
- **Ledger 8 limits:** an intent's TTL must be at or after the check time, and at most `global_ttl`
  after it. `global_ttl` is 1,209,600 s (14 days) on Preview, Preprod and Mainnet; the 3600 s in the
  ledger library is only its initial default. A DUST time must lie in the `dust_grace_period` window
  (10800 s) that ends at the check time.
- **A block's runtime:** `state_getRuntimeVersion` at the block's hash (`specVersion` 1000300 is
  runtime 1.0.300), or `protocolVersion` on the indexer's `block`.
- **Block timestamps from a node:** `state_getStorage` of `Timestamp::Now`,
  `0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb`, at the block's hash: a
  little-endian u64 of milliseconds.
- **Fixes:**
  - indexer: [midnight-indexer#1610](https://github.com/midnightntwrk/midnight-indexer/pull/1610)
    (`main`, `3e9f6374`), on `release/4.3` as
    [#1612](https://github.com/midnightntwrk/midnight-indexer/pull/1612) (`8cb252e3`, in
    `v4.3.800-rc.2`) and on `release/4.4` as
    [#1613](https://github.com/midnightntwrk/midnight-indexer/pull/1613) (`7fd4ecba`, in no tag); the
    runtime gate is [#1537](https://github.com/midnightntwrk/midnight-indexer/pull/1537);
  - node: [midnight-node#2216](https://github.com/midnightntwrk/midnight-node/pull/2216) (`main`,
    `1ec1c61e`, in no tag), on the 1.0 line as
    [#2238](https://github.com/midnightntwrk/midnight-node/pull/2238) (`5defaf5d`, in `node-1.0.400`)
    and on `release/node-2.1.0` as
    [#2218](https://github.com/midnightntwrk/midnight-node/pull/2218) (`7955f18e`, in
    `node-2.1.0-rc.4`).
- **Releases on 2026-11-09** (re-check with `--versions`):
  - **Indexer:** `v4.4.101`, GitHub's "Latest" release, has the fix, and so do `v4.4.0-rc.6`,
    `v4.3.800` and `v4.3.800-rc.2`. Docker `latest` for `indexer-standalone` and `chain-indexer` is
    4.4.101, for amd64 and arm64. It's the release for ledger 9: it reads ledger 8 blocks and the
    ledger 9 ones after each network's upgrade.
  - **Node:** `node-2.1.101`, image `midnightntwrk/midnight-node:2.1.101`, has the fix, as do
    `node-2.1.0-rc.4` and `node-1.0.400`. The image has no `latest` tag. Mainnet, Preview and Preprod
    all run 2.1.101; a 1.0.400 node stops at the ledger 9 upgrade block.
- **Compatibility:** indexer 4.4.101 supports node 2.1.101 and 1.0.400 (its release notes). A database
  from any 4.3 release, or from 4.4.0-rc.3 or earlier, can't be upgraded in place: re-index from
  genesis.

## Diagnose (no API key on Preview)

1. **Save the halt and note the version.** For Docker:
   `docker logs <container> 2>&1 | tail -500 > halt.log`, and
   `docker inspect --format '{{.Config.Image}}' <container>` for the image tag. For a node, keep the
   `Imported #…` lines before the error: they tell the checker where it stopped.
2. **Run the checker against a node that has the block.** It needs Node >= 20 and no install. It
   reads public data only.

   ```sh
   mkdir -p /tmp/check-sync-halt
   curl -fsSL -o /tmp/check-sync-halt/check-sync-halt.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/node-indexer-sync-halt-runbook/scripts/check-sync-halt.mjs
   node /tmp/check-sync-halt/check-sync-halt.mjs --network mainnet --rpc http://<your node>:9944 --log halt.log
   node /tmp/check-sync-halt/check-sync-halt.mjs --versions    # only the releases that have the fix
   ```

   - **Block data:** the checker asks, in order: a node at `http://127.0.0.1:9944` if it answers for
     the same network; each `--rpc` and `--indexer` you pass; then the network's public indexer and
     RPC. Preview's are free; Preprod's and Mainnet's are Blockfrost's and need
     `BLOCKFROST_PROJECT_ID`, which is never printed. A WebSocket node URL (`ws` or `wss` scheme), as in an
     indexer's config, is read as HTTP or HTTPS.
   - **A stopped node can't help with its own halt:** it doesn't have the block it stopped on. Pass
     another node with `--rpc`. While they still answer, the retired Midnight endpoints
     (`https://rpc.mainnet.midnight.network`, `https://rpc.preprod.midnight.network`) work for this
     read-only check; they can stop at any time.
   - **Finding the block:** by the height in the halt line if there is one; then by the transaction
     hash, on an indexer; then by the time in the error. A block found by time is confirmed by
     asking a node whether its transactions hold the error's TTL or DUST time.
   - **Releases:** it lists the GitHub tags that contain the fix, the Docker images with them, and
     where `latest` points. GitHub allows 60 requests an hour without a token: `--versions` uses about
     25, a diagnosis about half that. Set `GITHUB_TOKEN` if it reports a rate limit.

   Exit code: 0 = a known pattern (the output names the fix); 2 = not a known pattern, or no halt
   error in the input; 3 = the block couldn't be found or confirmed (add a source with `--rpc`);
   1 = it could not run. A run on the Mainnet 2998112 halt, with the retired Midnight RPC as the only
   source:

   ```text
   Halt: indexer on mainnet, "Intent TTL has expired" (TTL 1791908899, checked at 1791908904), transaction d9fd8f7fd5e1462f02bb862c437ad9b75e3f63ed55a3e84ec8d90fa2a44f3284
   Block: 2998112 (0xafddbee1acc227e576f9baa168b9fa2441a8513ef0976b9b93f2a35d53c64462), time 1791908898 (2026-10-13 16:28:18 UTC); parent time 1791908892; parent + 12 s = 1791908904; runtime spec 1000300
     found by time: its parent is the block at 1791908892; it holds the transaction's TTL
     your indexer checked it at parent + 12 s (1791908904)
     valid at the block's own time: yes; valid at parent + 12 s: no
   Known pattern A. The chain accepted this transaction at its block's own time, and your indexer checks a block's first transaction at parent + 12 s. Indexer v4.3.5 to v4.3.800-rc.1, and v4.4.0-rc.2 to rc.5, do that. This block was built by runtime 1.0.300 or later, which checks every transaction at block time, so the same version will stop again on later blocks like it: keeping a database past this one doesn't help.
   Fix: an indexer release that checks both times (midnight-indexer#1610 and #1537). Restarting the same version stops on the same block every time, because the block is permanent.
   Releases with the fix (GitHub tags and Docker Hub, checked 2026-10-15):
     midnight-indexer tags with the fix: v4.3.800-rc.2
       midnightntwrk/indexer-standalone: images with the fix: 4.3.800-rc.2; `latest` is 4.3.7, without the fix
       midnightntwrk/chain-indexer: images with the fix: 4.3.800-rc.2; `latest` is 4.3.7, without the fix
   Runbook: node-indexer-sync-halt-runbook.md
   ```

3. **By hand, without the script:** look up the transaction's block on an indexer
   (`{ transactions(offset: { hash: "<hash>" }) { block { height timestamp protocolVersion } } }` at
   `https://indexer.preview.midnight.network/api/v4/graphql`, or
   `https://midnight-<preprod|mainnet>.blockfrost.io/api/v0?project_id=<token>`), then the parent's
   time (`block(offset: { height: <height − 1> }) { timestamp }`). Compare the TTL (or DUST time)
   with the block's time and with the parent's time + 12 s, using the ledger 8 limits above. If it's
   valid at one time and invalid at the time in the error, this runbook applies. If it's invalid at
   both, it doesn't (Remediation 5).

## Remediation

1. **Indexer: run 4.4.101.** It checks the right times, and since the ledger 9 upgrade it's the
   indexer every network needs. What it takes depends on the version you run (its release notes):
   - **4.4.0-rc.6:** swap the images, nothing else.
   - **4.4.0-rc.5:** swap the images, unless it already indexed a ledger 8 to 9 upgrade; then as below.
   - **Any 4.3 release, or 4.4.0-rc.3 or earlier:** stop the indexer, wipe the indexer database and the
     ledger DB together (`indexer-standalone` keeps both in SQLite under `/data`; the separate images
     use Postgres), and start 4.4.101 (`midnightntwrk/indexer-standalone:4.4.101`, or
     `chain-indexer`, `indexer-api`, `wallet-indexer` and `spo-indexer` at the same tag) to re-index
     from genesis. If you mount your own `config.yaml`, compare it with the one in the `v4.4.101` tag
     first.
   - **Check** that the height keeps rising to the tip:

     ```sh
     curl -s -X POST -H 'content-type: application/json' \
       -d '{"query":"{ block { height } }"}' http://<indexer host>:8088/api/v4/graphql
     ```

   *Trade-off:* a re-index takes the indexer's time to reach the tip, and the API serves incomplete data
   until then. Keep the old database until the new one is at the tip.
2. **A `main` build:** move to 4.4.101 as above.
3. **Node: run node 2.1.101.** Mainnet, Preview and Preprod all need it since the ledger 9 upgrade.
   Upgrade directly from 1.0.400 or 2.1.100; the 2.1.0 release candidates aren't a supported step.
   Snapshot the data directory first: once 2.1.101 opens it, 1.0.400 can't start on it again. Keep the
   default `separate` storage layout: a node set to `storage_separation=unified` on a 1.0.400 data
   directory stops importing blocks (the docs' [ledger 9 upgrade page](https://docs.midnight.network/relnotes/ledger-9)
   and [full node guide](https://docs.midnight.network/nodes/full-node)).
   - **Check:** its best and finalized heights keep rising. If it stops again, run the checker on the
     new error.
4. **If you can't upgrade yet:**
   - **A node:** keep a node that is already past the block, and sync any new node from it. Blocks
     from runtime 1.0.300 on are checked at block time, which node 1.0.300 does too, so a node past
     the old blocks won't stop this way again.
   - **An indexer on v4.3.3 or older:** this halt only happens at old blocks, so a database restored
     from a backup past the block won't meet it again. Whether that version still supports your
     network's current runtime is a separate question: check its release notes.
   - **An indexer on v4.3.4 to v4.3.800-rc.1, or v4.4.0-rc.2 to rc.5:** there's no safe workaround, and
     since the ledger 9 upgrade no 4.3 release can follow these networks anyway. It
     checks new blocks at the wrong time too, so it can stop again on any new block whose first
     transaction has a short TTL. A backup past the block only delays that. Upgrade.
5. **Not a known pattern, or a new block.** Exit 3 means the checker couldn't find or confirm the
   block: run it again with `--rpc` pointing at a node that has it. Exit 2 with "Not a known pattern"
   means the transaction is invalid at both times, and this runbook doesn't apply: open an issue at the
   servicedesk front door with the checker's `--json` output and the version you run. If it finds a
   known pattern at a block that isn't in the table above, add it to the indexer team's list of known
   blocks ([midnight-indexer#1630](https://github.com/midnightntwrk/midnight-indexer/issues/1630)) so
   their checkpoint test covers it.

## Upstream follow-ups

- midnight-indexer: published `v4.4.101` with the fix, and Docker `latest` is 4.4.101 (2026-11-08), so
  the earlier request to move `latest` off 4.3.7 is done.
- [midnight-indexer#1630](https://github.com/midnightntwrk/midnight-indexer/issues/1630) (to add):
  Mainnet 2998112, transaction `d9fd8f7f…`, to the known blocks.
- [midnight-node#2229](https://github.com/midnightntwrk/midnight-node/issues/2229): still open,
  although the node-1.0.400 release notes say it is fixed (commit `5defaf5de`).

## Reference material

- **Checker and test:** [`scripts/check-sync-halt.mjs`](scripts/check-sync-halt.mjs) and
  [`scripts/test-check-sync-halt.mjs`](scripts/test-check-sync-halt.mjs). How the cases were measured,
  the reviews, the live runs and the test runs are in
  [`scripts/check-sync-halt.NOTES.md`](scripts/check-sync-halt.NOTES.md).
- **Worked cases:**
  - [midnight-indexer#1365](https://github.com/midnightntwrk/midnight-indexer/issues/1365) (Preview
    112450, DUST window)
  - [midnight-indexer#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371) (Preview
    128537, indexer v4.3.4)
  - [midnight-indexer#1461](https://github.com/midnightntwrk/midnight-indexer/issues/1461) (Preprod
    164460)
  - [midnight-node#2229](https://github.com/midnightntwrk/midnight-node/issues/2229) (Mainnet
    1788980, node 1.0.300)
  - an operator's Mainnet indexer on 4.3.7 at 2998112 (Discord, 2026-10-15)
- **Root cause and fixes:**
  - node: [midnight-node#1924](https://github.com/midnightntwrk/midnight-node/issues/1924),
    [#1932](https://github.com/midnightntwrk/midnight-node/pull/1932),
    [#1964](https://github.com/midnightntwrk/midnight-node/pull/1964),
    [#2216](https://github.com/midnightntwrk/midnight-node/pull/2216);
  - indexer: [midnight-indexer#1367](https://github.com/midnightntwrk/midnight-indexer/pull/1367),
    [#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371),
    [#1537](https://github.com/midnightntwrk/midnight-indexer/pull/1537),
    [#1610](https://github.com/midnightntwrk/midnight-indexer/pull/1610).
- **Release notes:** the midnight-indexer `v4.3.800-rc.2` `CHANGELOG.md`, and
  [node-1.0.400](https://github.com/midnightntwrk/midnight-node/releases/tag/node-1.0.400).
- **Earlier write-up:** [servicedesk#235](https://github.com/midnightntwrk/servicedesk/issues/235)
  (the node 1.0.300 halt, and the indexer's exposure to the same bug).
- **QA:** [midnight-indexer#1630](https://github.com/midnightntwrk/midnight-indexer/issues/1630)
  (checkpoint test for the known blocks) and
  [#1631](https://github.com/midnightntwrk/midnight-indexer/issues/1631) (from-genesis canary).
