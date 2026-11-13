---
title: "Test funds don't arrive from the faucet"
when_to_use: "A Preview or Preprod faucet request hangs, errors or never arrives, or tNIGHT arrived but there is no DUST to pay fees."
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-16"
last_reviewed: "2026-11-07"
error_strings:
  - "Provided address is invalid"
  - "Your transaction is being submitted."
  - "You can't resubmit right now, next attempt is allowed at"
  - "Failed to prove transaction"
  - "Insufficient funds to move"
  - "Services are currently unavailable. Please try again later."
  - "Transaction submission error"
  - "Could not find Task with id"
  - "Token request failed due to timeout"
review_when:
  - "The faucet page's waiting text or its error messages change: the page's code is not public, so they are measured, not sourced"
  - "The docs Funding troubleshooting table gains a row this runbook also covers: cut it here"
---

# Runbook: Test funds don't arrive

The faucet hung or failed, the tNIGHT never showed up, or it did but there's no DUST. The script tells you which, and each result points to the fix. For the normal steps, see [Funding a wallet](https://docs.midnight.network/guides/acquire-tokens).

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported**, **inferred** or **not tested** has none, so trust it less.

## Symptom

| If you see | Go to |
|---|---|
| `Provided address is invalid` | Diagnose 1 |
| `Your transaction is being submitted.` and nothing changes | Diagnose 2 |
| `Transaction submitted. You will shortly receive …`, then nothing shows in the wallet | Diagnose 2 |
| `Failed to prove transaction`, `Insufficient funds to move …`, `Services are currently unavailable. Please try again later.` or `Transaction submission error` on the faucet page | Remediation 2 |
| `You can't resubmit right now, next attempt is allowed at …` or `Token request failed due to timeout` | Remediation 2 |
| tNIGHT is in the wallet but there is no DUST, so transactions cannot pay fees | Diagnose 3 |
| Preview tNIGHT from before the relaunch is gone | Root cause 4, then Remediation 1 and 3 |

### Not this runbook

- **The wallet takes an hour or more to show a balance on Preprod, or only after a resync.** That's wallet sync. If Diagnose 2 shows the tNIGHT on chain, see the [Preprod wallet sync runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/wallet-preprod-sync-runbook.md).
- **Mainnet DUST that stopped generating from cNIGHT.** No faucet there. See the [cNIGHT→DUST duplicate registrations runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md).
- **A local `undeployed` network.** It has no faucet: use the funding menu in the docs' [Running a local network](https://docs.midnight.network/guides/networks-and-environments#running-a-local-network).

## Root cause

1. **The faucet page only waits.** It submits a request (a drip), then polls it about every 10 s while it's `PENDING`, showing `Your transaction is being submitted.` (measured). A faucet whose wallet is stuck, empty or can't prove leaves it waiting while its health endpoint still answers `SERVING` (measured). The faucet's code fails a stranded drip with `Token request failed due to timeout` and frees the address's daily slot; which version each host runs isn't known.
2. **Each faucet serves one network and keeps a daily limit per address, set by each deployment.** Another network's address, a shielded or DUST address, or a typo gets `Provided address is invalid`, with no drip. The two faucets for a network keep separate limits, and the Nethermind ones served the same address again after a few minutes (reported).
3. **tNIGHT generates no DUST until it is registered.** The registration is a transaction the wallet submits, and the indexer marks each registered NIGHT output.
4. **Preview relaunched, not upgraded.** On 7 November 2026 it became a new chain ([Preview reset](https://docs.midnight.network/relnotes/ledger-9#preview-reset)): tNIGHT from before is gone and needs a new registration, while DUST registrations backed by cNIGHT carried over. Its genesis hash didn't change (measured: `0x3c096de2…`), so a wallet won't notice: resync it from genesis.

## Before you start

- **You need** Node 22 or newer, the wallet's **unshielded** address (the one starting `mn_addr_`), and the script, [scripts/check-test-funds.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-test-funds-runbook/scripts/check-test-funds.mjs), run from its folder with no `npm install`.
- **On Preprod, a Blockfrost project id.** The script reads Preprod through Blockfrost, so the user creates a Preprod project ([Getting a Blockfrost project token](https://docs.midnight.network/guides/networks-and-environments#getting-a-blockfrost-project-token)), then runs `export BLOCKFROST_PROJECT_ID=...` and the script in their own shell. Preview needs no id, so an agent can run it.
- **Safety.** Every Diagnose step is read-only and needs only the public address. Never ask for or paste a seed or the project id; the script never prints it. Registering NIGHT (Remediation 3) submits a transaction, so the user runs it.

## Diagnose

Run the script for every step. Each `FINDING` line it prints ends with the step to go to. Exit 0: the tNIGHT is there and registered; 2: a finding; 1: it could not run.

1. **Is the address one this faucet accepts?**

   ```sh
   node check-test-funds.mjs <mn_addr_...> --offline
   ```

   It sends no request. The first line is `ADDRESS ok: an unshielded preview address` (or `preprod`), or an `ADDRESS FINDING` naming the problem (another network's prefix, mainnet, a shielded or DUST address, a bad checksum): Remediation 1. If it's `ok` but the faucet still says `Provided address is invalid`, check the page is that network's faucet and the address was pasted exactly; if so, Stop and escalate.

2. **Did the faucet send it, and did it land?** Give the script what the faucet returned:
   - The page said `Transaction submitted. … This is the transaction ID: <hex>`: add `--tx <hex>`. A transaction hash from an explorer works too.
   - The page is still waiting: the `drips` response in the browser's developer tools (Network) holds a `dripId`. Add `--drip <dripId> --faucet <the faucet page URL>`.
   - Neither: run it with the address alone. A `TNIGHT` line dated after the request means it arrived.

   ```sh
   node check-test-funds.mjs <mn_addr_...> --drip <dripId> --faucet <faucet URL>
   ```

   - `REQUEST … PENDING`: not sent yet; run it again in a few minutes. Still `PENDING` after 10 (reported): Remediation 2.
   - `REQUEST … FAILED: <reason>`: the faucet gave up. `Could not find Task with id` means a mistyped `dripId`, or a `--faucet` other than the page that made the request: fix it and run again. `Token request failed due to timeout`, or any other reason: Remediation 2.
   - `ON CHAIN ok: it paid … to this address`: the funds arrived. A wallet that doesn't show them hasn't synced (Not this runbook). With no DUST, Diagnose 3.
   - `ON CHAIN FINDING: this transaction paid no tNIGHT to this address`: the page got another address. Remediation 1.
   - `ON CHAIN FINDING: … has no transaction`: if it was sent on Preview before 7 November 2026, Root cause 4. Otherwise run it again in a few minutes; still missing 10 minutes after the page or drip said it was sent: Stop and escalate.
   - `TNIGHT FINDING: no tNIGHT has ever reached this address`, with no drip or ID to check: the request never got through. Remediation 2.

3. **The tNIGHT is there: why is there no DUST?** Run it with the address alone.
   - `DUST FINDING: … not registered`: Remediation 3.
   - `DUST ok: all unspent tNIGHT is registered`: DUST is accruing. If the wallet shows none, it hasn't synced (Preprod: [wallet sync runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/wallet-preprod-sync-runbook.md)), or the registration sends DUST to another wallet's DUST address; then see the DUST row in [Funding troubleshooting](https://docs.midnight.network/guides/acquire-tokens#funding-troubleshooting).
   - `DUST FINDING: every tNIGHT UTXO here has been spent`: request more with Remediation 2.

## Remediation

1. **Request with the right address.** Copy the unshielded address for the faucet's network from the wallet, as step 1 of [Getting tNIGHT from the faucet](https://docs.midnight.network/guides/acquire-tokens#getting-tnight-from-the-faucet) says, and run Diagnose 1 on it before requesting.

   *Trade-off:* none.

2. **Use the other faucet for the same network, or wait.** Each network has the faucet the docs' [Environment reference](https://docs.midnight.network/guides/networks-and-environments#environment-reference) lists and a second one, both in Key identifiers. Request from the one you haven't used, or retry a Nethermind faucet after a few minutes: on current faucet code a failed drip frees the daily slot. If both refuse, wait until the `next attempt is allowed at` time, or ask in the Midnight Discord's developer channel for a transfer to the unshielded address. Share only the `mn_addr_` address: anyone asking for a seed, or offering help by direct message, is not support.

   *Trade-off:* waiting, or depending on someone else.

3. **Register the tNIGHT for DUST generation.** See the docs: [in Lace](https://docs.midnight.network/guides/acquire-tokens#registering-night-for-dust-generation-in-lace), **Generate tDUST**, or [with the wallet SDK](https://docs.midnight.network/guides/acquire-tokens#registering-night-for-dust-generation-with-the-wallet-sdk), `registerNightUtxosForDustGeneration`. It submits a transaction, so the user runs it. Then run Diagnose 3 again.

   *Trade-off:* DUST accrues from zero toward a cap set by the registered NIGHT, so the first fee may need a wait (how long, not tested).

## Confirm fixed

- The script exits 0 and its last line is `DUST ok: all unspent tNIGHT is registered`.
- The wallet shows the tNIGHT balance the `TNIGHT unspent` line printed, and a DUST balance above zero that grows.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- Both faucets for a network fail or stay `PENDING` for over an hour, for an address that passes Diagnose 1.
- The page or the drip said the tNIGHT was sent and the indexer still has no transaction with its ID after 10 minutes.
- `Provided address is invalid` for an address that passes Diagnose 1, on that network's faucet.
- The faucet's transaction is on chain with a status other than `SUCCESS`.
- All tNIGHT is registered, the wallet is synced, and DUST stays at zero.
- The script exits 1 while its endpoints answer for others.
- A source in Key identifiers disagrees with its row and no step covers that.

Include the faucet URL, its exact message, the `dripId` or transaction ID, and the script's output. The address is fine to share; check anything else you paste for the project id.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| Each test network's faucet, rate-limited, its indexer endpoints and address prefixes; no mainnet faucet | `github:midnightntwrk/midnight-docs/docs/guides/networks-and-environments.mdx`, published as [Networks and environments](https://docs.midnight.network/guides/networks-and-environments) | `https://midnight-tmnight-preview.nethermind.dev/` `https://midnight-tmnight-preprod.nethermind.dev/` `both faucets are rate limited` `https://indexer.preview.midnight.network/api/v4/graphql` `wss://indexer.preview.midnight.network/api/v4/graphql/ws` `https://midnight-preprod.blockfrost.io/api/v0?project_id=<token>` `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=<token>` `mn_addr_preview` `mn_addr_preprod` `there is no faucet` |
| Preview relaunched as a new chain; cNIGHT-backed DUST registrations carried over | `github:midnightntwrk/midnight-docs/docs/relnotes/ledger-9.mdx`, published as [Ledger 9 network upgrade](https://docs.midnight.network/relnotes/ledger-9) | `Preview relaunched as a new chain` `DUST registrations backed by cNIGHT on Cardano carried over` |
| The faucet steps, Lace and SDK registration, and troubleshooting rows | `github:midnightntwrk/midnight-docs/docs/guides/acquire-tokens.mdx`, published as [Funding a wallet](https://docs.midnight.network/guides/acquire-tokens) | `the faucet rejects shielded and DUST addresses` `Generate tDUST` `to submit the registration` `up to a cap set by how much NIGHT you registered` `registerNightUtxosForDustGeneration` `Provided address is invalid` `Balance stays zero after the faucet confirms` `DUST stays zero after registration` |
| The second faucet for each network | `github:midnightntwrk/midnight-faucet-ui/src/constants/networks.ts` | `preview: "https://faucet.preview.midnight.network/"` `preprod: "https://faucet.preprod.midnight.network/"` |
| The indexer streams an address's transactions, finds one by identifier, and marks registered NIGHT | `github:midnightntwrk/midnight-indexer/indexer-api/graphql/schema-v4.graphql` | `unshieldedTransactions(address: UnshieldedAddress!, transactionId: Int): UnshieldedTransactionsEvent!` `highestTransactionId: Int!` `registeredForDustGeneration: Boolean!` `identifier: HexEncoded` |
| NIGHT's unshielded token type is 64 zeros | `github:midnightntwrk/midnight-docs/docs/nodes/node-toolkit.mdx` | `holds five NIGHT UTXOs` `"token_type": "0000000000000000000000000000000000000000000000000000000000000000"` |
| The faucet API's drip-status path, and the identifier it returns as `transactionHash` | `github:midnightntwrk/midnight-faucet-api/apps/server/src/api/drip-routes.ts` | `router.get("/drips/:dripId"` `transactionIdentifier` |
| A drip is `PENDING`, `CONFIRMED` or `FAILED` | `github:midnightntwrk/midnight-faucet-api/packages/faucet-internal-api/src/api.ts` | `t.literal("PENDING")` `t.literal("CONFIRMED")` `t.literal("FAILED")` |
| The faucet client polls about every 10 s and keeps polling while a drip is `PENDING` | `github:midnightntwrk/midnight-faucet-api/packages/faucet-client/src/FaucetClient.ts` | `pollInterval = 10_000` `return pollForResponse(dripId, errorRetriesLeft);` |
| The errors for a bad address, a used daily limit and an unknown drip | `github:midnightntwrk/midnight-faucet-api/apps/server/src/helpers/verify-address.ts` | `Provided address is invalid` |
| | `github:midnightntwrk/midnight-faucet-api/apps/server/src/rate-limiting/rate-limit-error.ts` | `the address has no daily slot left` `You can't resubmit right now, next attempt is allowed at` |
| | `github:midnightntwrk/midnight-faucet-api/apps/server/src/TaskManager.ts` | `Could not find Task with id` |
| The faucet fails a stranded drip and returns its daily slot | `github:midnightntwrk/midnight-faucet-api/apps/server/src/tasks/task-timeouts.ts` | `fails it, and refunds its rate-limit slot` `IN_PROGRESS_TIMEOUT_MINUTES = 5` `SCHEDULED_TIMEOUT_MINUTES = 60` |
| | `github:midnightntwrk/midnight-faucet-api/apps/server/src/tasks/task-repository.ts` | `Token request failed due to timeout` |
| Each deployment sets its own daily limit | `github:midnightntwrk/midnight-faucet-api/apps/server/src/config.ts` | `RATE_LIMITING_MAX_DAILY` |
| The faucet crashes on its bare API root, so the script calls only the drip path | `github:midnightntwrk/midnight-faucet-api/apps/server/src/router.ts` | `BaseApiUrlRegExp.exec(reqCtx.originalUrl)!.groups!.url` |

## Reference material

- **Measurements:** the page's waiting text and the health answer, in this runbook's pull request. Reported faucet failures: servicedesk [#31](https://github.com/midnightntwrk/servicedesk/issues/31), [#111](https://github.com/midnightntwrk/servicedesk/issues/111), [#119](https://github.com/midnightntwrk/servicedesk/issues/119), [#154](https://github.com/midnightntwrk/servicedesk/issues/154), [#155](https://github.com/midnightntwrk/servicedesk/issues/155).
- **Script:** [scripts/check-test-funds.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-test-funds-runbook/scripts/check-test-funds.mjs), read-only. [scripts/test-check-test-funds.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-test-funds-runbook/scripts/test-check-test-funds.mjs) tests its address check and DUST verdict offline.
