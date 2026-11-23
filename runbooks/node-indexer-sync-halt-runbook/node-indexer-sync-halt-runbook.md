---
title: "Self-hosted node or indexer stops on a block the chain accepted"
when_to_use: "A self-hosted indexer, or a node syncing from genesis, exits with `Intent TTL has expired` or `dust is outside of its validity window` and stops at the same block after every restart."
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-15"
last_reviewed: "2026-11-23"
error_strings:
  - "Intent TTL has expired"
  - "dust is outside of its validity window"
  - "index_blocks_task failed: apply transactions"
  - "cannot apply regular transaction"
  - "Aborting the rest of the block execution"
  - "chain-indexer exited with ERROR"
review_when:
  - "A network upgrade brings a runtime or ledger host-function version that checks a block's first transaction at a new time: Root cause and the checker's two patterns"
  - "A network is reset onto a new chain: its old blocks, and the halts at them, are gone"
  - "The support matrix lists a node or indexer release that `check-sync-halt.mjs --versions` doesn't list with the fix: Remediation 1 and 2"
  - "midnight-indexer#1630 adds Mainnet 2998112 to its known blocks: drop that item from Stop and escalate"
---

# Runbook: Self-hosted node or indexer stops on a block the chain accepted

A self-hosted indexer, or a node syncing from genesis, stops at a block the rest of the network accepted, and stops there again after every restart. The block's first transaction is valid at its block's own time, at its parent's time + 12 s, or at both, and the software checks it at a time it isn't valid at. Nothing is wrong with the chain or your setup: run the checker, then move to a release that checks both times.

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported**, **inferred** or **not tested** has none, so trust it less.

## Symptom

| If you see | Go to |
|---|---|
| `index_blocks_task failed: apply transactions … cannot apply regular transaction <hash>: malformed transaction: … Intent TTL has expired. TTL: Timestamp(…), Current block: Timestamp(…)`, then `chain-indexer exited with ERROR` (or `process exited with ERROR`), at the same block after every restart | Diagnose 1 |
| The same, ending `dust is outside of its validity window (declared time: Timestamp(…), window: [Timestamp(…), Timestamp(…)])` | Diagnose 1 |
| A node syncing from genesis stops importing on `Intent TTL has expired` then `Transaction(N) failed due to Invalid(Custom(182)). Aborting the rest of the block execution.` | Diagnose 1 |

What gives it away: the TTL is a few seconds before the "Current block" time, and the same version stops at the same block every time. A fresh sync stops at an old block; an indexer following the tip can stop at a new one.

### Not this runbook

- **A transaction your DApp submits now, rejected with `1010: Invalid Transaction: Custom error: 182`.** Its TTL really has passed. See [Node rejection codes](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-1010-custom-error-runbook/node-1010-custom-error-runbook.md).
- **A wallet that can't sync** (`values inserted non-linearly`, or progress that stops). See the [Preprod wallet sync runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/wallet-preprod-sync-runbook.md).
- **An indexer that exits at a runtime upgrade block**, for example with `CodeUpdated not found`. A different bug: [midnight-node#1960](https://github.com/midnightntwrk/midnight-node/issues/1960), [midnight-indexer#1397](https://github.com/midnightntwrk/midnight-indexer/issues/1397).

## Root cause

1. **Old blocks used one of two times.** Before runtime 1.0.300, a block's first regular transaction could reuse the pool's check at the parent's time + 12 s instead of being checked at the block's own time ([midnight-node#1924](https://github.com/midnightntwrk/midnight-node/issues/1924)). The block doesn't record which. From runtime 1.0.300, every transaction is checked at block time.
2. **So a first transaction can be valid at only one time.** Pattern A: valid at block time only (a short TTL; any runtime). Pattern B: valid at parent + 12 s only (a DUST time between the two; old blocks only).
3. **A version that checks the wrong time stops for good,** at the first block that doesn't fit, because the block is permanent:

| Software | Checks a block's first transaction at | Stops on |
|---|---|---|
| Indexer v4.3.3 and older, v4.4.0-rc.1 | block time | pattern B |
| Indexer v4.3.4 | block time + 12 s ([#1367](https://github.com/midnightntwrk/midnight-indexer/pull/1367)) | pattern A, and some valid at both |
| Indexer v4.3.5 to v4.3.800-rc.1, v4.4.0-rc.2 to rc.5 | parent + 12 s, every block ([#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371)) | pattern A, new blocks included |
| Node 1.0.300 | parent + 12 s for old blocks ([midnight-node#1932](https://github.com/midnightntwrk/midnight-node/pull/1932)) | pattern A |
| Indexer from v4.3.800-rc.2 and v4.4.0-rc.6; node from 1.0.400 and 2.1.0-rc.4 | both times for old blocks, block time for new ones ([midnight-indexer#1610](https://github.com/midnightntwrk/midnight-indexer/pull/1610), [#1537](https://github.com/midnightntwrk/midnight-indexer/pull/1537); [midnight-node#2216](https://github.com/midnightntwrk/midnight-node/pull/2216)) | neither |

The ranges come from those pull requests and the release notes; `check-sync-halt.mjs --versions` lists the fixed releases live.

## Before you start

- **You need** Node 20 or later, the halt log, the image tag you run, and a node RPC that has the block. Preview's public indexer and RPC need no key. Preprod's and Mainnet's public ones are Blockfrost's and need `BLOCKFROST_PROJECT_ID`, which the checker reads from the environment and never prints.
- **A stopped node can't help with its own halt:** it doesn't have the block. Pass another node with `--rpc`.
- **Safety.** Diagnose is read-only: the checker reads public chain data, GitHub and Docker Hub, and signs nothing. Remediation 1 wipes the indexer's databases and Remediation 2 changes the node's data directory: keep a copy of each first.

## Diagnose

1. **Save the halt and the version.**

   ```sh
   docker logs <container> 2>&1 | tail -500 > halt.log
   docker inspect --format '{{.Config.Image}}' <container>
   ```

   Expect one of the Symptom lines near the end of `halt.log`, and an image tag such as `midnightntwrk/indexer-standalone:<version>`. For a node, keep the `Imported #…` lines before the error: they tell the checker where it stopped. No Symptom line means this isn't the runbook.

2. **Run the checker.**

   ```sh
   mkdir -p /tmp/check-sync-halt
   curl -fsSL -o /tmp/check-sync-halt/check-sync-halt.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/node-indexer-sync-halt-runbook/scripts/check-sync-halt.mjs
   node /tmp/check-sync-halt/check-sync-halt.mjs --network mainnet --rpc http://<a node with the block>:9944 --log halt.log
   ```

   It finds the block and asks a node whether the transaction is valid at each time. A `ws` or `wss` URL works. Set `GITHUB_TOKEN` if it reports a GitHub rate limit.

   - **Exit 0, `Known pattern A.` or `Known pattern B.`**: this runbook's cause. The `Fix:` line and the release list name what to run. Go to Remediation.
   - **Exit 3**: the block couldn't be found or confirmed. Run it again with `--rpc` at a node that has the block.
   - **Exit 2, `Not a known pattern`**: the transaction is invalid at both times, so this isn't the cause. Go to Stop and escalate.
   - **Exit 1**: it could not run. Its message says why.

3. **By hand, if you can't run the script.** Look up the transaction's block on an indexer (`{ transactions(offset: { hash: "<hash>" }) { block { height timestamp protocolVersion } } }`), then its parent's `timestamp`. Block timestamps are milliseconds; the error's are seconds. A TTL must be at or after the check time. A DUST time must be within 3 hours before it (**measured**: `dust_grace_period` 10800 s on all three networks, 2026-10-15). If the transaction is valid at the block's time or at parent + 12 s, and invalid at the time in the error, this runbook applies. Invalid at both means it doesn't.

## Remediation

1. **Indexer: run the support matrix's indexer release.** Check that `check-sync-halt.mjs --versions` lists it with the fix. What the upgrade takes depends on what you run ([v4.4.101 release notes](https://github.com/midnightntwrk/midnight-indexer/releases/tag/v4.4.101)):
   - **4.4.0-rc.6:** swap the images.
   - **4.4.0-rc.5:** swap the images, unless it already indexed a ledger 8 to 9 upgrade; then as below.
   - **Any 4.3 release, 4.4.0-rc.3 or earlier, or a `main` build:** stop the indexer, wipe the indexer database and the ledger DB together (`indexer-standalone` keeps both in SQLite under `/data`; the separate images use Postgres), and start the new release to re-index from genesis. Run `chain-indexer`, `indexer-api`, `wallet-indexer` and `spo-indexer` at the same tag. If you mount your own `config.yaml`, compare it with the one in the release's tag first.

   *Trade-off:* a re-index takes the indexer's time to reach the tip, and the API serves incomplete data until then. Keep the old database until the new one is at the tip.

2. **Node: run the support matrix's node release.** Upgrade directly from 1.0.400 or 2.1.100. Snapshot the data directory first: once the 2.1 release opens it, 1.0.400 can't start on it again. Keep the default `separate` storage layout: a node set to `storage_separation=unified` on a 1.0.400 data directory stops importing blocks ([ledger 9 upgrade page](https://docs.midnight.network/relnotes/ledger-9)).

   *Trade-off:* the snapshot needs as much disk as the data directory, and there's no way back to 1.0.400 without it.

3. **If you can't upgrade yet.**
   - **A node:** keep a node that is already past the block, and sync new nodes from it. New blocks are checked at block time, as node 1.0.300 does, so it won't stop this way again.
   - **An indexer on v4.3.3 or older:** this halt only happens at old blocks, so a database restored from a backup past the block won't meet it again. Whether that version follows your network's current ledger is a separate question: check its release notes.
   - **An indexer on v4.3.4 to v4.3.800-rc.1, or v4.4.0-rc.2 to rc.5:** no safe workaround. It checks new blocks at the wrong time too, so a backup past the block only delays the next halt. Upgrade.

   *Trade-off:* each of these leaves you on a release the networks no longer support.

## Confirm fixed

- **Indexer:** the height passes the halt block and keeps rising to the tip:

  ```sh
  curl -s -X POST -H 'content-type: application/json' \
    -d '{"query":"{ block { height } }"}' http://<indexer host>:8088/api/v4/graphql
  ```

- **Node:** its best and finalized heights pass the halt block and keep rising.
- **Either:** no Symptom line in the logs after the halt block.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- The checker exits 2 with `Not a known pattern`.
- It still exits 3 with `--rpc` at a node that has the block.
- A release that `--versions` lists with the fix stops at the same block.
- The checker finds a known pattern at a block midnight-indexer#1630 doesn't list. Add it there too, so the indexer team's checkpoint test covers it. Mainnet 2998112 (transaction `d9fd8f7f…`, an indexer on 4.3.7, **reported** by an operator on 2026-10-15) isn't listed yet.
- A source in Key identifiers disagrees with its row and no step covers that.

Never edit the database, skip the block or patch the binary to get past it: the next block's state depends on this one. Include the checker's `--json` output, the image tag and the Symptom line.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). [check-runbook.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/authoring/check-runbook.mjs) tests every row daily against each source's newest version, or the npm version a row pins. For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| The indexer's second time is the parent's time + 12 s, for the first regular transaction | `github:midnightntwrk/midnight-indexer/chain-indexer/src/domain/ledger_state.rs` | `const MEMPOOL_TBLOCK_BUMP_MILLIS: u64 = 2 * 6_000;` `.then_some(parent_block_timestamp + MEMPOOL_TBLOCK_BUMP_MILLIS)` |
| Only blocks from runtimes before 1.0.300 get the second time | `github:midnightntwrk/midnight-indexer/chain-indexer/src/domain/ledger_state.rs` | `const FIRST_UNSKEWED_NODE_1_0_SPEC_VERSION: u32 = 1_000_300;` |
| The indexer fix and the runtime gate are released | `github:midnightntwrk/midnight-indexer/CHANGELOG.md` | `Accept the first regular transaction at either tblock (#1610)` `Gate first-tx tblock bump on the block's runtime (#1537)` |
| The node checks an old first transaction at parent + 12 s, then retries at its block's own time | `github:midnightntwrk/midnight-node/ledger/src/ledger_8/mod.rs` | `const TBLOCK_CORRECTION_OFFSET_SECS: i128 = 12;` `Err(_) if strict_key.well_formed_tblock != block_context.tblock =>` |
| The matrix's node release (2.1.101 at the last check) | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"tag": "node-2.1.101"` |
| The node upgrade path | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `Upgrade directly from 1.0.400 or 2.1.100` |
| The matrix's indexer release (4.4.101 at the last check), and a Mainnet indexer re-indexes from genesis | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"tag": "v4.4.101"` `Operators must re-index from genesis` |
| A `unified` node on a 1.0.400 data directory stops importing | `github:midnightntwrk/midnight-docs/docs/relnotes/ledger-9.mdx` | `storage_separation=unified` |
| The checker's outcomes and the `--versions` flag | `github:midnightntwrk/servicedesk/runbooks/node-indexer-sync-halt-runbook/scripts/check-sync-halt.mjs` | `Known pattern A.` `Known pattern B.` `Not a known pattern` `'--versions'` |
| The Mainnet 1788980 node halt is still open | `issue:midnightntwrk/midnight-node#2229` | `open` |
| The indexer's checkpoint test for known blocks isn't done | `issue:midnightntwrk/midnight-indexer#1630` | `open` |

## Reference material

- **Script:** [scripts/check-sync-halt.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-indexer-sync-halt-runbook/scripts/check-sync-halt.mjs) finds the block, names the pattern and lists the releases with the fix; [test-check-sync-halt.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-indexer-sync-halt-runbook/scripts/test-check-sync-halt.mjs) is its offline test.
- **Measurements:** the five known blocks (Preview 112450 and 128537, Preprod 164460, Mainnet 1788980 and 2998112), each re-measured on 2026-10-15, with the reviews and live runs, are in [check-sync-halt.NOTES.md](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-indexer-sync-halt-runbook/scripts/check-sync-halt.NOTES.md).
- **Worked cases:** [midnight-indexer#1365](https://github.com/midnightntwrk/midnight-indexer/issues/1365) (Preview 112450, DUST window), [#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371) (Preview 128537, v4.3.4), [#1461](https://github.com/midnightntwrk/midnight-indexer/issues/1461) (Preprod 164460), [midnight-node#2229](https://github.com/midnightntwrk/midnight-node/issues/2229) (Mainnet 1788980, node 1.0.300), [servicedesk#235](https://github.com/midnightntwrk/servicedesk/issues/235) (the first write-up).
- **QA:** [midnight-indexer#1630](https://github.com/midnightntwrk/midnight-indexer/issues/1630) (checkpoint test for known blocks) and [#1631](https://github.com/midnightntwrk/midnight-indexer/issues/1631) (from-genesis canary).
