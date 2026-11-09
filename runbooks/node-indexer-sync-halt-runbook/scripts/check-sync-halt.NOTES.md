# Notes: `check-sync-halt.mjs`

How the [sync halt runbook](../node-indexer-sync-halt-runbook.md) was measured and reviewed, what the
checker does, and how it was tested. Everything here was run on 2026-10-15 unless it says otherwise.
**The user runs the checker**; it reads public data and writes nothing.

## The five halts, measured

The cases are every halt of this kind reported so far: four from GitHub issues and pull requests, and
one from an operator on Discord. For each block, three things were measured.

- **The times:** the block's and its parent's `Timestamp::Now`, read with `state_getStorage` at each
  block hash. The sources were the public Preview RPC, Blockfrost's Preprod RPC, and
  `rpc.mainnet.midnight.network`, which is retired but still answered. The times around each case are
  in `test-check-sync-halt.mjs`.
- **The runtime:** `state_getRuntimeVersion` at the block's hash.
- **The verdict:** the real transaction, decoded from the block with `@midnight-ntwrk/ledger-v8`
  8.1.2, run through `Transaction.wellFormed` at each time. It ran against a blank `LedgerState` with
  every strictness flag off (balancing, proofs, signatures, limits), so only the time checks mean
  anything. A blank state also carries the ledger's initial `global_ttl` of 3600 s, not the chains'
  14 days (below). So the probe's message at Preview 112450's block time was "TTL is too far in the
  future", where the real indexer reported the DUST error.

| Network, block | Runtime | Block time | Parent | Parent + 12 s | At block time | At parent + 12 s |
|---|---|---|---|---|---|---|
| Preview 112450 | 1000000 | 1784890542 | 1784890536 | 1784890548 | invalid: DUST time 1784890545 is ahead of it | well-formed |
| Preview 128537 | 1000000 | 1784987076 | 1784987070.001 | 1784987082 | well-formed | well-formed |
| Preprod 164460 | 22000 | 1775081616 | 1775081610 | 1775081622 | well-formed | `Intent TTL has expired. TTL: Timestamp(1775081620), Current block: Timestamp(1775081622)` |
| Mainnet 1788980 | 1000000 | 1784643558 | 1784643552 | 1784643564 | well-formed | `Intent TTL has expired. TTL: Timestamp(1784643562), Current block: Timestamp(1784643564)` |
| Mainnet 2998112 | 1000300 | 1791908898 | 1791908892 | 1791908904 | well-formed | `Intent TTL has expired. TTL: Timestamp(1791908899), Current block: Timestamp(1791908904)` |

The errors at parent + 12 s match the ones the halted software printed, character for character
([midnight-indexer#1461](https://github.com/midnightntwrk/midnight-indexer/issues/1461),
[midnight-node#2229](https://github.com/midnightntwrk/midnight-node/issues/2229), and the operator's
log). In each block the halted transaction is the first one.

**What the measurements show:**

- **Preview 128537 is valid at both times** (TTL 1784987084), but it stopped indexer v4.3.4. That
  version checked at the block's own time + 12 s, which is 1784987088
  ([midnight-indexer#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371): "took down
  both preview-blue and preview-green … on the same block, 128537"). [midnight-indexer#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371) doesn't quote the log
  line, so the checker's test and live run use one reconstructed from the TTL and that time.
- **The operator's height was the chain tip.** The operator reported "at block 3019457", but the
  transaction is in 2998112. 3019457 was Mainnet's tip when they posted (2026-10-15 04:03 UTC), and
  4.3.7's halt line doesn't name the block.
- **Each block holds its transaction's TTL and DUST time** as a 4-byte little-endian number, and the
  neighbouring blocks don't (checked at ±1 block for all five). The checker uses this to confirm a
  block it found by time.

**The ledger parameters on the chains:**

- **`global_ttl` is 1,209,600 s and `dust_grace_period` 10800 s** on all three networks. Decoded with
  `LedgerParameters.deserialize` from the indexer's `block { ledgerParameters }` at Preview 112450 and
  1,300,000 and at Preprod 164460, and from `MidnightRuntimeApi_get_ledger_parameters` at Mainnet
  1788980 and 2998112.
- **3600 s is only the initial default:** `LedgerParameters.initialParameters()` has
  `global_ttl: Duration(3600)`.

**When each network moved to runtime 1.0.300** (found by binary search on `state_getRuntimeVersion`):

| Network | First block on spec 1000300 | Time (UTC) | Spec before |
|---|---|---|---|
| Preprod | 2648468 | 2026-09-21 15:12:36 | 1000000 |
| Mainnet | 2738210 | 2026-09-25 15:08:42 | 1000000 |
| Preview | 1074620 | 2026-09-29 07:16:42 | 1000000 |

The node-1.0.300 source says why that matters (`ledger/src/versions/common/mod.rs`, around line 1160):
version 1 of the ledger host functions passes `skew_tblock = true`, and version 2, which the upgraded
runtime imports, passes `false`. The indexer's `v4.3.800-rc.2` changelog ([midnight-indexer#1537](https://github.com/midnightntwrk/midnight-indexer/pull/1537)) says the same thing
from its side.

## Which versions check which time

- **Indexer, by tag** (a treeless clone; `git tag --contains` on each fix commit, and the code read at
  each tag):
  - **Block time only:** `v4.3.3` and earlier
    (`indexer-common/src/domain/ledger/ledger_state.rs`: `well_formed(…, cx.block_context.tblock)`),
    and `v4.4.0-rc.1`.
  - **Block time + 12 s:** `v4.3.4` (`chain-indexer/src/domain/ledger_state.rs`:
    `block_timestamp + MEMPOOL_TBLOCK_BUMP_MILLIS`, [midnight-indexer#1367](https://github.com/midnightntwrk/midnight-indexer/pull/1367)).
  - **Parent + 12 s, on every block:** `v4.3.5`, `v4.3.7`, `v4.3.800-rc.1` and `v4.4.0-rc.2` to
    `rc.5` (`parent_block_timestamp + …`, [midnight-indexer#1371](https://github.com/midnightntwrk/midnight-indexer/pull/1371)).
  - **Both:** `v4.3.800-rc.2` is the only tag with [midnight-indexer#1610](https://github.com/midnightntwrk/midnight-indexer/pull/1610) (as [midnight-indexer#1612](https://github.com/midnightntwrk/midnight-indexer/pull/1612), `8cb252e3`) and the [midnight-indexer#1537](https://github.com/midnightntwrk/midnight-indexer/pull/1537) runtime
    gate (as [midnight-indexer#1548](https://github.com/midnightntwrk/midnight-indexer/pull/1548)). The `release/4.4` port, [midnight-indexer#1613](https://github.com/midnightntwrk/midnight-indexer/pull/1613) (`7fd4ecba`), is in no tag.
- **Node, by tag:**
  - `node-1.0.300` has the first-transaction correction (`c025264`), gated on host-function version 1,
    without the retry;
  - `node-1.0.400` is the only 1.0 tag with `5defaf5d` ("retry tblock-corrected first tx at the
    block's own tblock", [midnight-node#2238](https://github.com/midnightntwrk/midnight-node/pull/2238));
  - `node-2.1.0-rc.4` has it as [midnight-node#2218](https://github.com/midnightntwrk/midnight-node/pull/2218) (`7955f18e`);
  - [midnight-node#2216](https://github.com/midnightntwrk/midnight-node/pull/2216) itself (`1ec1c61e`) is on `main`, in no tag.
- **Migrations by tag** (`git ls-tree` of `indexer-common/migrations`):

  | Tag | Postgres | SQLite |
  |---|---|---|
  | `v4.3.3` | 000–003 | 001–004 |
  | `v4.3.4`, `v4.3.5` | 000–007 | 001–009 |
  | `v4.3.7` | 000–003 | 001–004 |
  | `v4.3.800-rc.2` | 000–003, 007 | 001–005, 009 |
  | `v4.4.0-rc.5` | 000–009 | 001–011 |

  The v4.3.7 changelog says 4.3.4 and 4.3.5 "inadvertently carried 4.4.0-preview content (… +4
  migrations)". rc.2 runs its migrations with sqlx's defaults, which refuse a database that has
  applied migrations the build doesn't have. Hence "no in-place path" for 4.3.4, 4.3.5 and 4.4.0-rc.x.
  This is inferred from the lists and the defaults; it wasn't run.
- **Docker Hub:**
  - `indexer-standalone` and `chain-indexer` `latest` share 4.3.7's digest.
  - `indexer-standalone`, `chain-indexer`, `indexer-api` and `wallet-indexer` all have
    `4.3.800-rc.2` images.
  - Of the 4.4 line, only `4.4.0-rc.1` and `rc.2` have images.
  - `midnight-node` has `1.0.400` and `2.1.0-rc.4`, and no `latest` tag.
- **The rc.2 changelog and config:**
  - **Upgrades:** in place from 4.3.7 and 4.3.800-rc.1, with no re-index.
  - **Migrations:** three index-only ones, Postgres `007` and SQLite `005` and `009`.
  - **Config changes:** `infra.ledger_db.cache_size` becomes `cache_max_nodes` (default 100000), or
    `APP__INFRA__LEDGER_DB__CACHE_SIZE` becomes `…CACHE_MAX_NODES`; and
    `infra.api.subscription.progress_cache` (`max_capacity: 10000`, `time_to_live: "5s"`) is new.
  - **Rollback:** delete the `_sqlx_migrations` rows.
  - **Nodes:** 1.0.400 is supported, 1.0.2 isn't.
  - **Standalone:** API on port 8088, data in `/data`.
- **Exit messages:** `chain-indexer/src/main.rs` logs `process exited with ERROR`, and
  indexer-standalone logs `{task_name} exited with ERROR`.

## What the checker does

- **Reading the halt:** it reads the halt from `--log`, `--error` or stdin, and takes the last of
  three ledger errors: TTL expired, TTL too far ahead, or DUST outside its window. It also uses the
  `dust actions out of TTL range` warning when that is all there is. From the same text it reads the
  transaction hash, the height (from 4.3.800-rc.2's halt line), and the node's `Imported #N` lines.
- **Its sources:** a node at `127.0.0.1:9944`, if `system_chain` names the same network; then `--rpc`
  (WebSocket URLs, with a `ws` or `wss` scheme, are read as `http` or `https`) and `--indexer`; then the public indexer
  and RPC. Preprod and Mainnet ones need `BLOCKFROST_PROJECT_ID`. Each lookup goes to the first
  source that has the answer, so a node stopped at the parent still helps. Without `--network`, the
  network comes from the first node that answers.
- **Finding the block:**
  - by the height, if the line has one; then by the transaction hash on a GraphQL indexer;
  - then by time: the block after the one at the error's time − 12 s, that block itself (v4.3.4's
    case), and the block at the error's time;
  - candidates that fit a known pattern are confirmed by asking a node whether their extrinsics hold
    the TTL or DUST time;
  - the binary search runs up to the highest tip of any source.
- **The verdict:** it compares the time the software checked at (block time, parent + 12 s, or block
  time + 12 s) with the times the transaction is valid at:
  - pattern A: checked at parent + 12 s or block + 12 s, and valid at block time;
  - pattern B: checked at block time, and valid at parent + 12 s;
  - "a mismatch of the same kind": checked at some other time, and valid at one of the two;
  - "not a known pattern": invalid at both.

  It also reports the block's runtime, and for an indexer warns that a pattern A block from runtime
  1.0.300 means it will stop again.
- **Releases:**
  - For each tag from `v4.3.4` (indexer) or `node-1.0.300` that matches `X.Y.Z` or `X.Y.Z-rc.N`, it
    lists the tag's commits since 2026-09-29. A tag has the fix if one of them carries the fix's
    title, which also works across cherry-picks.
  - For Docker, it fetches `latest` and each fixed tag by name, and names what `latest` is from the
    recent tags.
- **Safety:** every printed line goes through `redact()`, which replaces `BLOCKFROST_PROJECT_ID` and
  `GITHUB_TOKEN` with `<token>`. Every regular expression is a literal. A network error is retried
  once.

## Reviews

Two reviews, run as separate agents with no part in writing the runbook.

### The fact-check

It re-checked every claim against the repos, the chains and the changelogs. It confirmed:

- the four blocks it was given;
- both reproductions and the sample output;
- the checker's behaviour and the 18 tests of that version;
- the release, changelog and link claims.

It found these problems, each checked again before it was fixed:

- **The TTL window was wrong.** The runbook said 3600 s, from the probe's blank state. The chains use
  1,209,600 s, and the "TTL is too far in the future" variant can't realistically happen on them.
  The checker now uses 14 days, and the runbook drops that variant from the patterns.
- **The root cause didn't explain Mainnet 2998112.** That block is from runtime 1.0.300, which has no
  skew. It stopped an indexer that adds 12 s to every block, so the exposure is ongoing on all three
  networks. The Root cause section now covers the two runtime eras with each network's upgrade
  height, and Remediation 4 no longer offers "keep a database past the block" for those indexer
  versions.
- **v4.3.4 was in the wrong group.** It adds the 12 s to the block's own time, which is how Preview
  128537 stopped it. That case is now in the table, and the checker recognises it.
- **4.3.4, 4.3.5 and 4.4.0-rc.x had no upgrade path.** Their migrations rule out an in-place upgrade
  to rc.2. Remediation 2 now covers them.
- **Smaller fixes:**
  - the node fix's `main` commit;
  - the QA build (a pre-release build, not the tag);
  - the chain-indexer image's exit message;
  - [midnight-node#1964](https://github.com/midnightntwrk/midnight-node/pull/1964) is now cited;
  - node 2.1.0-rc.4 is marked as a Ledger 9 pre-release;
  - the DUST variant of pattern A;
  - the v4.3.3 source path;
  - an operator's first name, which was in these notes and in a test constant, is gone;
  - the checker reads Docker tags by name instead of from one page.

### The operator run

An agent played a self-hosting operator with only the runbook and three halt logs: the Mainnet
indexer on `latest`, a new Mainnet node 1.0.300, and a Preprod indexer. Once it had a data source,
the checker got all three right. The runbook alone didn't get it to a safe fix:

- **The Diagnose command failed on Mainnet without a token.** The runbook never showed passing your
  own node. The command now has `--rpc http://<your node>:9944`, and the runbook says a stopped node
  can't supply its own next block.
- **A WebSocket node URL** (scheme `ws`), as in an indexer's config, came out as "not a known
  pattern". The checker now reads it as HTTP.
- **Exit 2 covered four outcomes.** Exit 3 now means the block couldn't be found or confirmed.
- **The indexer upgrade couldn't be done from the runbook.** Remediation 1 now has:
  - the config snippet and the environment-variable rename;
  - which image uses which database, and a backup step;
  - the node-first order;
  - the rollback SQL and the health-check URL.
- **No way to tell your version,** and no guidance on which node line suits the public networks.
  Both are in now.
- **The root cause for 2998112**, the same finding as the fact-check's.

## Live runs (2026-10-15, after the reviews)

| Case | Sources | Found by | Result |
|---|---|---|---|
| Mainnet 2998112, the operator log | `--rpc https://rpc.mainnet.midnight.network` | time, confirmed by the TTL in the block | pattern A, runtime 1000300, "will stop again", exit 0 |
| Mainnet 1788980, a node log with `Imported #` lines | `--rpc wss://rpc.mainnet.midnight.network` (read as `https://`) | time, confirmed | pattern A, node, runtime 1000000, exit 0 |
| Preprod 164460, the [midnight-indexer#1461](https://github.com/midnightntwrk/midnight-indexer/issues/1461) log | Blockfrost Preprod (token from the environment) | the transaction hash | pattern A, runtime 22000, exit 0 |
| Preview 112450, the [midnight-indexer#1365](https://github.com/midnightntwrk/midnight-indexer/issues/1365) text | the public Preview indexer | the transaction hash | pattern B, exit 0 |
| Preview 128537, reconstructed v4.3.4 line | the public Preview indexer | the transaction hash | pattern A, "only indexer v4.3.4", exit 0 |

The Mainnet 2998112 run with the release check, using a GitHub token, matches the runbook's sample
output line for line. The Blockfrost token never appeared in any output.

**Bugs these runs found, all fixed:**

- **The first release check was too slow and too costly.** It used GitHub's `compare` API, which timed
  out on the indexer's diverged branches, and one run spent about 37 of the 60 unauthenticated
  requests an hour. It now lists commits since the fix date and matches the title: about 25 requests
  for `--versions`.
- **Dropped connections:** GitHub and the public RPC dropped connections several times that afternoon.
  Once, that ended a run in "not found" with no reason given. Every request is now retried once on a
  network error. The block search reports what failed, and `fetch failed` now shows its cause.

## Test runs

[`test-check-sync-halt.mjs`](test-check-sync-halt.mjs) runs the checker as a separate process against
a local mock. The mock serves a node RPC (with runtime versions, and block bodies that hold the known
TTLs), a GraphQL indexer, the GitHub API and Docker Hub, with the real block times above and
interpolated ones in between. Node 20.19.1, macOS: 24 of 24 cases pass in about 10 s.

| What | Cases |
|---|---|
| The halts as reported | Mainnet 2998112 (indexer, by time, confirmed by the TTL, runtime 1.0.300 warning) and 1788980 (node, no warning): A; Preprod 164460 (by hash, through the token-gated indexer): A; Preview 112450 from stdin: B; Preview 128537 (v4.3.4): A |
| Other inputs | "TTL too far" with the chains' 14-day window: B; 4.3.800-rc.2's halt line with a height (used directly, no search); a transaction invalid at both times (exit 2); no halt error (exit 2) |
| Sources | no token and no node for Preprod (exit 1, says why); a node stopped at the parent with no other source ("probably 1788980", exit 3); the same with a second source (A); nothing has the block (exit 3); a local node on another network (not used, says so); the network inferred from `--rpc`; a WebSocket (`ws`) URL; an RPC that drops every other request (retried, A); one that drops every block lookup (exit 3, says why) |
| Output and releases | `--json`; `--offline` makes no GitHub or Docker Hub call; `--versions` lists only fixed tags (an alpha tag is skipped) and fetches `latest` by name; a rate-limited GitHub (exit 1 for `--versions` alone, exit 0 for a diagnosis) |
| Tokens | a token in the environment and in `--indexer` and `--rpc` URLs never appears in any output, including "found by" and error lines; the GitHub token is sent as a header and never printed |

**Mutations:** twelve deliberate bugs, each in a copy of the checker. All twelve fail the test:

| Mutation | Failing cases |
|---|---|
| bump of 6 s instead of 12 | 6 |
| pattern A requires validity at parent + 12 s | 11 |
| any commit since the fix date counts as the fix | 3 |
| no transaction lookup on the indexer | 3 |
| DUST check time taken from the window's start | 1 |
| `redact()` does nothing | 1 |
| no block time + 12 s (v4.3.4) case | 1 |
| every block "holds" the transaction | 1 |
| the ledger's default 3600 s TTL window | 1 |
| no WebSocket-URL rewrite | 1 |
| no runtime 1.0.300 warning | 1 |
| no retry on a network error | 1 |

**Bugs the test found, all fixed:**

- **The first version of the test missed token leaks.** `redact()` could be removed without any case
  failing, because no case put a token anywhere the checker prints. The token-in-URL case was added
  for it.
- **The test reached a real host.** One case blanked the mock settings and called Blockfrost with the
  fake token. It now points at dead mock endpoints.
- **A node stopped at the parent,** plus a second source that had the block, gave "probably 1788980".
  The checker now asks every source for the next block.
- **Blocks that fit the time but no pattern** reported "not found" instead of "not a known pattern".

## Not tested

- **No halted indexer database was run.** It would need an indexer synced to the block before a halt.
  The upgrade path comes from the rc.2 changelog and from [midnight-indexer#1630](https://github.com/midnightntwrk/midnight-indexer/issues/1630)'s QA run on Preprod 164460.
- **No migration refusal was run:** the 4.3.4, 4.3.5 and 4.4.0-rc.x one is inferred from the lists
  and sqlx's defaults.
- **Indexer 4.3.800-rc.2 hasn't been run on Mainnet 2998112.** The block is newer than the replay in
  its changelog. The time logic (block time first, and only block time for runtime 1.0.300 blocks)
  and the ledger check above say it passes.
- **Node 1.0.400 hasn't been synced from genesis.** Its release notes say it fixes #1788979.
- **Mainnet through Blockfrost:** there was no Mainnet token, so Mainnet ran through the retired
  Midnight RPC. The Preprod runs used Blockfrost's indexer and RPC, which take the same queries.
- **Other blocks of either pattern:** no chain was scanned for them.
- **Other setups:** log formats other than the ones in the issues, Windows, and Node 18.

## Re-verify when versions move

- **New releases:** run `node check-sync-halt.mjs --versions`, and update the runbook's Key
  identifiers and Remediation 1 and 2 when an indexer release with the fix is published, when a 4.4
  release comes out, or when `latest` moves.
- **A new fix commit:** if one lands under a different title, or a new release line starts, update
  `FIXES` in the checker: the title, the start date, and the first tag to check.
- **Ledger parameters:** if the networks change `global_ttl` or `dust_grace_period`, decode them as
  above and update `GLOBAL_TTL_S` and `DUST_GRACE_S`.
- **Ledger 9:** check the constants and the error texts when the networks move.

## Ledger 9 (2026-11-09)

`check-sync-halt.mjs --versions`, unchanged script, 2026-11-09: indexer tags with the fix `v4.4.101`,
`v4.4.0-rc.6`, `v4.3.800`, `v4.3.800-rc.2`; `indexer-standalone` and `chain-indexer` `latest` is 4.4.101,
with the fix. Node tags with the fix `node-2.1.101`, `node-2.1.0-rc.4`, `node-1.0.400`; the image has
no `latest`. Docker Hub has `indexer-standalone`, `indexer-api` and `spo-indexer` at `4.4.101` (amd64
and arm64). `24 of 24` test cases passed.

The page's Remediation now points at indexer 4.4.101 and node 2.1.101, which every network needs since
the ledger 9 upgrade (Preprod on 2026-11-09). The v4.4.101 release notes: no reset from 4.4.0-rc.6;
from any 4.3 release or 4.4.0-rc.3 and earlier, wipe the indexer database and the ledger DB together
and re-index from genesis; "This release changes no configuration" (relative to rc.6). The 4.3.800-rc.2
in-place steps were removed, since no 4.3 release can follow a ledger 9 network.
