---
title: "DUST doesn't arrive after registering cNIGHT"
when_to_use: 'cNIGHT was registered for DUST in the cNgD DApp and no DUST has arrived, the DApp stays on "Registration Syncing" or says "NO REGISTRATION FOUND", or the DApp, the wallet and the indexer show different DUST figures.'
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-22"
last_reviewed: "2026-11-09"
error_strings:
  - "Registration Syncing"
  - "NO REGISTRATION FOUND"
  - "No cNIGHT tokens found in wallet"
  - '"registered": false'
review_when:
  - "NIGHT can be held on Midnight Mainnet itself: NIGHT held there registers with a Midnight transaction, which this runbook does not cover"
  - "The indexer's dustGenerationStatus starts counting every UTXO that generates for a DUST address: drop Root cause 6, Diagnose 4's DApp step and the script's DAPP note"
  - "CHANGE ADDRESS is measured on a ledger 9 network: drop the not-measured notes in Root cause 5 and Remediation 2"
---

# Runbook: DUST doesn't arrive after registering cNIGHT

cNIGHT is NIGHT held on Cardano. Registering it in the cNIGHT-generates-DUST (cNgD) DApp links the wallet's stake key to a Midnight DUST address, and Midnight generates DUST from the cNIGHT that key holds. A read-only script reads both chains and says why DUST is missing.

**Until Diagnose 1 says to register, tell the user not to register again.** A second registration makes two, and then neither counts.

Each fact is in Key identifiers with its source. A claim marked **measured** or **inferred** has none, so trust it less.

## Symptom

| If you see | Go to |
|---|---|
| The cNgD DApp shows `Registration Syncing` | Diagnose 1 |
| The DApp shows `NO REGISTRATION FOUND` for a wallet that registered | Diagnose 1 |
| The DApp stops with `No cNIGHT tokens found in wallet` | Remediation 3 |
| A DUST balance of 0 hours or days after registering, or after **CHANGE ADDRESS** | Diagnose 1 |
| DUST showed 0 on Mainnet after the ledger 9 upgrade (6 November 2026) | Root cause 7, Remediation 4 |
| The indexer answers `"registered": false` for the wallet's reward address | Diagnose 1 |
| The DApp, the wallet and the indexer show different DUST figures | Diagnose 1, then Diagnose 4 |

### Not this runbook

- **Two registrations or more for one stake key:** the [cNIGHT→DUST duplicate registrations runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md).
- **tNIGHT from a Preview or Preprod faucet.** It goes to a Midnight address (`mn_addr_…`) and registers with a Midnight transaction: see the [test funds runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-test-funds-runbook/wallet-test-funds-runbook.md).
- **The wallet has DUST but transactions hang while balancing.** See the [WalletFacade balancing hang runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md).

## Root cause

1. **Midnight sees a registration only after it settles on Cardano**: about 12 hours on Mainnet and Preprod, 2.5 on Preview (the docs and the DApp). Until then the indexer answers `registered: false` and the DApp shows `Registration Syncing`. New cNIGHT waits too (**measured**).
2. **The DApp can show a registration that is gone.** It shows `Registration Syncing` whenever it holds a registration and the indexer says `registered: false`.
3. **The DApp finds a registration through the connected Midnight wallet**, so one made with another Midnight wallet shows `NO REGISTRATION FOUND`. With none connected, it shows the Cardano wallet's registration.
4. **Midnight counts one registration per stake key**, and none when there are two. DUST goes to the DUST address in the registration, which may be another wallet's. Midnight counts NIGHT per DUST address, so keys registered to one address share one figure.
5. **Midnight counts a cNIGHT UTXO only if its key has exactly one registration when the UTXO is created.** The DApp's register transaction moves the wallet's cNIGHT so it counts (**measured**). cNIGHT it didn't move, cNIGHT received while the key had two registrations, and cNIGHT moved by **CHANGE ADDRESS** never count until moved again. The last is [midnight-node#2121](https://github.com/midnightntwrk/midnight-node/issues/2121), fixed from runtime specVersion 2000000. Every network runs 2001100 since the ledger 9 upgrade (Preprod last, on 2026-11-09), so CHANGE ADDRESS now counts the cNIGHT it moves (from the fix; not measured on ledger 9). cNIGHT that a CHANGE ADDRESS moved before the upgrade may still not count.
6. **The DApp's figures can count only part of the NIGHT.** Its Generation Rate, and its DUST Balance with no Midnight wallet connected, read only the newest UTXO generating for the DUST address (`dustGenerationStatus`) (**measured**).
7. **DUST was reset once at the ledger 9 upgrade.** On Mainnet the network replays every live registration, all backed by cNIGHT, straight to its full cap at the same DUST address, and a wallet shows the refilled balance only on wallet SDK 2.0.0 against an indexer on 4.4.101. Preprod's upgrade kept cNIGHT-backed registrations and cleared the rest; Preview relaunched and kept cNIGHT-backed ones (the docs' ledger 9 page).

## Before you start

- **You need** Node 18 or newer and [scripts/check-dust-registration.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-after-registration-runbook/scripts/check-dust-registration.mjs), run from its folder with no `npm install`.
- **From the user:** the stake address (`stake1…`, or an address starting `addr1q`) of the Cardano wallet that registered, and the DUST address (`mn_dust1…`) they expect DUST in. Both are public. A testnet address (`stake_test1…`) needs `--network preprod` or `--network preview`.
- **On Mainnet and Preprod, a Blockfrost project id for that network's Midnight indexer** ([Getting a Blockfrost project token](https://docs.midnight.network/guides/networks-and-environments#getting-a-blockfrost-project-token)), support's or the user's own: `export BLOCKFROST_PROJECT_ID=...`. Preview needs none; `--cardano-only` skips Midnight.
- **Safety.** The script and every Diagnose step are read-only. Each Remediation submits a Cardano transaction, so the user runs it. Never ask for a seed or for the user's project id. The script never prints the project id.

## Diagnose

1. **Which state is the registration in?**

   ```sh
   node check-dust-registration.mjs <stake1... or addr1q...> --dust <mn_dust1...>
   ```

   It prints the registrations on Cardano (`CARDANO`), recent registrations and removals (`HISTORY`), the cNIGHT held (`NIGHT`), other keys on the same DUST address (`SHARED`) and Midnight's view (`MIDNIGHT`), in UTC. The last line is the verdict. Exit 0: generating; 1: could not run; 2: a finding.
   - `WAIT FINDING`: run it again when the line says, and don't register again.
   - `ESCALATE FINDING`: Midnight hasn't seen a registration older than 24 hours, or the two chains disagree on the DUST address. Stop and escalate.
   - `REGISTRATION FINDING: nothing is registered now. The last registration … was removed`: Diagnose 2.
   - `REGISTRATION FINDING: … only on <network>`: Remediation 1, on the network the user wants.
   - `REGISTRATION FINDING: this stake key has no registration`: run it for each wallet the user may have registered with. If none shows one, Remediation 1.
   - `REGISTRATION FINDING: N live registrations`: the duplicates runbook.
   - `DUST ADDRESS FINDING`: Diagnose 3.
   - `NIGHT FINDING`: no cNIGHT under the key, or cNIGHT held over 24 hours that Midnight doesn't count. Remediation 3.
   - `REGISTRATION ok` (with `--cardano-only`): run it again with a project id to check Midnight.
   - `DUST ok`: both chains agree DUST is generating. If the user sees less, or `Registration Syncing`, Diagnose 4.
   - `ADDRESS FINDING`: fix the address the line names and run again.
   - Exit 1, `refused the project id`: the id is for another network. Use one for this network's Midnight indexer.
   - Exit 1 with another HTTP error or a timeout: run it again later.

2. **The registration was removed.** The `HISTORY` lines give the time and transaction. A removal needs the stake key's signature (the DApp's **STOP GENERATION**, or another tool). If the user didn't remove it, Stop and escalate. Otherwise clear the DApp's stored data as in the duplicates runbook's [Re-registering from zero](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md#re-registering-from-zero-stale-dapp-view-after-de-registration), then Remediation 1.

3. **DUST goes to another DUST address.** The `DUST ADDRESS FINDING` line names it. DUST already generated stays in that address's wallet (**inferred**). To send future DUST to the user's wallet, Remediation 2.

4. **The chains say DUST is generating, but the wallet or the DApp disagrees.**
   - A `DAPP note` line: the DApp's Generation Rate and DUST Balance count only part of the NIGHT (Root cause 6). The `MIDNIGHT` lines have the full figures.
   - The DApp still shows `Registration Syncing`: its view is out of date. Reload it, or clear its stored data as in Diagnose 2.
   - The `MIDNIGHT … now X DUST` figure is DUST generated, before fees (**inferred**). A wallet that has paid fees shows less.
   - Otherwise the wallet hasn't synced: resync it (for a wallet SDK app on Preprod, the [Preprod wallet sync runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/wallet-preprod-sync-runbook/wallet-preprod-sync-runbook.md)). Still short: Stop and escalate.

## Remediation

Every DApp action needs cNIGHT in the connected Cardano wallet. Without it, the DApp stops with `No cNIGHT tokens found in wallet`.

1. **Register once.** In the cNgD DApp for the network (Mainnet's is in the docs' [Mainnet environment](https://docs.midnight.network/guides/networks-and-environments)), connect the Cardano wallet that holds the cNIGHT and the Midnight wallet that should receive DUST, and register once. Diagnose 1 should then show one registration and `WAIT`.

   *Trade-off:* no DUST until the wait passes, and a Cardano transaction fee.

2. **Send future DUST to another address.** On ledger 9, which every network runs now, **CHANGE ADDRESS** counts the cNIGHT it moves (Root cause 5; not measured). Or, without it: With only the Cardano wallet connected, so the DApp shows the registration (Root cause 3), use **STOP GENERATION**. When Diagnose 1 shows no registration, Remediation 1 with the new wallet (**inferred**). If the DApp shows `NO REGISTRATION FOUND` while Diagnose 1 shows one ([midnight-cnight-to-dust-dapp#249](https://github.com/midnightntwrk/midnight-cnight-to-dust-dapp/issues/249)), the duplicates runbook's scripts remove it, run by the user. After a CHANGE ADDRESS made before the ledger 9 upgrade, if Diagnose 1 shows that cNIGHT not counted, Remediation 3.

   *Trade-off:* two Cardano transactions, and the new address waits like a new registration.

3. **Move the cNIGHT so Midnight counts it.** While the key has one registration, send the cNIGHT, in a transaction of its own, to an address of the registered wallet: the script's `ADDRESS ok` line for it must show the registered stake key (an `addr1v` address has none). Or register the wallet that holds it, with Remediation 1.

   *Trade-off:* a Cardano fee, and the moved cNIGHT waits before it counts (**inferred**).
4. **DUST at 0 on Mainnet since the ledger 9 upgrade.** Nothing to register again. Move the app or wallet to wallet SDK 2.0.0 with an indexer on 4.4.101 (Mainnet's is Blockfrost); the replayed balance shows after it syncs. If Diagnose 1 shows the registration and DUST generating and the wallet still shows 0, Stop and escalate.

## Confirm fixed

- Diagnose 1 with `--dust <the wallet's DUST address>` exits 0 and ends with `DUST ok: registered once and generating DUST for` that address.
- That wallet's DUST balance grows.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- The script prints an `ESCALATE FINDING`.
- A registration was removed and the user did not remove it.
- A `NIGHT FINDING`, or a resynced wallet still short after `DUST ok`, a day after the fix.
- The script keeps exiting 1 while Koios and the indexer answer for others.
- A source in Key identifiers disagrees with its row and no step covers that.

Include the network, the script's output, and the DApp's exact message.

## Key identifiers

Each row names a public source, a repo file (`github:`) or an issue's state (`issue:`), and text it must contain. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| Mainnet's mapping validator and cNIGHT token | `github:midnightntwrk/midnight-node/res/mainnet/cnight-config.json` | `"mapping_validator_address": "addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7"` `"cnight_policy_id": "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa"` `"cnight_asset_name": "NIGHT"` |
| Preprod's (Preview uses the same on its own Cardano network) | `github:midnightntwrk/midnight-node/res/preprod/cnight-config.json` | `"mapping_validator_address": "addr_test1wplxjzranravtp574s2wz00md7vz9rzpucu252je68u9a8qzjheng"` `"cnight_policy_id": "d2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1"` |
| Preview's | `github:midnightntwrk/midnight-node/res/preview/cnight-config.json` | `"mapping_validator_address": "addr_test1wplxjzranravtp574s2wz00md7vz9rzpucu252je68u9a8qzjheng"` `"cnight_policy_id": "d2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1"` |
| About 12 hours on Mainnet, the cNgD DApp, the Blockfrost endpoints and DUST address prefixes | `github:midnightntwrk/midnight-docs/docs/guides/networks-and-environments.mdx` | `reach a Midnight node, which takes about 12 hours` `https://midnight-dust-mainnet.nethermind.io/` `https://midnight-mainnet.blockfrost.io/api/v0?project_id=<token>` `https://midnight-preprod.blockfrost.io/api/v0?project_id=<token>` `mn_dust_preprod` `mn_dust_preview` |
| The DApp's wait per network and its syncing banner | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/components/dashboard/IndexerSyncBanner.tsx` | `isPreview ? '2.5 hours' : '12 hours'` `Registration Syncing` |
| The banner shows while the DApp holds a registration and the indexer says unregistered | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/components/dashboard/CardanoWalletCard.tsx` | `registrationUtxo && generationStatus?.registered === false` |
| The DApp looks up a registration by the Midnight wallet, else by the Cardano wallet | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/contexts/WalletContext.tsx` | `useRegistrationUtxo(cardanoState.address, midnightState.coinPublicKey)` `Auto-populate Midnight state from on-chain registration when Midnight wallet isn't connected` |
| The DApp's buttons, and its DUST Balance without a wallet | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/components/dashboard/MidnightWalletCard.tsx` | `'CHANGE ADDRESS'` `'STOP GENERATION'` `'NO REGISTRATION FOUND'` `specksToTDust(generationStatus.currentCapacity)` |
| CHANGE ADDRESS replaces the registration; register and CHANGE ADDRESS move all the wallet's cNIGHT; every action needs cNIGHT | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/lib/dustTransactionsUtils.ts` | `private static async buildUpdateTransaction(lucid: LucidEvolution, newDustPKH: string, registrationUtxo: UTxO)` `txBuilder.collectFrom([registrationUtxo], spendRedeemer);` `txBuilder.collectFrom(cnightUtxos);` `No cNIGHT tokens found in wallet. You need cNIGHT to register.` `You need cNIGHT to update.` |
| The DApp's Generation Rate | `github:midnightntwrk/midnight-cnight-to-dust-dapp/src/components/dashboard/GenerationRateCard.tsx` | `BigInt(generationStatus.generationRate) * 3600n` |
| The ledger 9 DUST reset: replayed to the cap on Mainnet, shown on wallet SDK 2.0.0 and indexer 4.4.101; Preprod cleared registrations not backed by cNIGHT | `github:midnightntwrk/midnight-docs/docs/relnotes/ledger-9.mdx` | `replays every live registration automatically` `wallet SDK 2.0.0 against an indexer on 4.4.101` `cleared DUST registrations that aren't backed by cNIGHT` |
| The CHANGE ADDRESS issue is closed (fixed in the node) | `issue:midnightntwrk/midnight-node#2121` | `closed` |
| The DApp's lookup by DUST address is still open | `issue:midnightntwrk/midnight-cnight-to-dust-dapp#249` | `open` |
| The indexer's queries and the fields the script reads | `github:midnightntwrk/midnight-indexer/indexer-api/graphql/schema-v4.graphql` | `dustGenerationStatus(cardanoRewardAddresses: [CardanoRewardAddress!]!)` `dustGenerations(cardanoRewardAddresses: [CardanoRewardAddress!]!)` `registered: Boolean!` `valid: Boolean!` `utxoTxHash: HexEncoded` |
| `dustGenerationStatus` reads the newest generating UTXO | `github:midnightntwrk/midnight-indexer/indexer-api/src/infra/storage/dust.rs` | `ORDER BY ctime DESC` |
| `dustGenerations` adds up every generating UTXO for the DUST address | `github:midnightntwrk/midnight-indexer/indexer-api/src/infra/storage/dust_generations.rs` | `night_balance = night_balance.saturating_add(value);` `WHERE owner = $1` |
| cNIGHT counts only if its key has one registration when the UTXO is created | `github:midnightntwrk/midnight-node/pallets/cnight-observation/src/lib.rs` | `let Some(ref dust_public_key) = Self::get_registration(&data.owner) else {` `(Some(only), None) => Some(only),` |
| Below specVersion 2000000, a transaction's new cNIGHT is processed before its registration changes | `github:midnightntwrk/midnight-node/primitives/cnight-observation/src/lib.rs` | `pub const DATA_ORDERED_UTXOS_SPEC_VERSION: u32 = 2_000_000;` |
| One registration per stake key; DUST accrues to the address in it; a removal needs the stake key's signature | `github:midnightntwrk/servicedesk/runbooks/cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md` | `live registration UTXO at the mapping validator` `accrues to the DUST address in the datum` `On-chain authorization needs only the **stake-key signature**` |

## Reference material

- **Worked case:** [midnight-cnight-to-dust-dapp#231](https://github.com/midnightntwrk/midnight-cnight-to-dust-dapp/issues/231), `Registration Syncing` for weeks after a registration that had been removed twice.
- **Measurements:** in this runbook's pull request.
- **Script tests:** [scripts/test-check-dust-registration.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-after-registration-runbook/scripts/test-check-dust-registration.mjs) tests every verdict offline on recorded answers.
