/**
 * register-once.ts
 * ----------------------------------------------------------------------------
 * Create exactly ONE cNIGHT→DUST registration UTXO at the mapping validator,
 * bypassing the DApp UI. Use this when the chain shows ZERO live registrations
 * for the stake key but the DApp still shows a stale "Replicate Registrations
 * Detected" screen that blocks (or silently no-ops) the normal register flow.
 *
 * It reuses the DApp's OWN transaction builder
 * (DustTransactionsUtils.buildRegistrationTransaction) so the datum, auth-NFT
 * mint, and cNIGHT rotation exactly match production behaviour. That builder is
 * a pure, single-registration builder with NO existing-registration guard, so a
 * script that calls it ONCE produces exactly one clean registration.
 *
 * ── ⚠️  READ BEFORE RUNNING ─────────────────────────────────────────────────
 * 1. Run the Koios diagnostic first and confirm the stake key is at ZERO live
 *    registrations. This builder does NOT check — running it when a registration
 *    already exists RECREATES the duplicate-registration bug.
 * 2. The dustPKH you pass is written verbatim into the datum as the DUST address
 *    that will receive DUST. A WRONG value registers DUST to an address you do
 *    not control and cannot be recovered. Use the exact DUST address you intend,
 *    cross-checked (see NOTES).
 * 3. Register only ONCE. Do not re-run "because the DApp didn't update" — that
 *    double-submit reflex is exactly how duplicates are born. Verify on-chain.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * Your seed phrase NEVER leaves your machine and is never sent to anyone.
 * Support cannot and will not ask for it. This runs locally, you sign locally.
 *
 * ── SETUP ───────────────────────────────────────────────────────────────────
 *   1. git clone https://github.com/midnightntwrk/midnight-cnight-to-dust-dapp
 *      cd midnight-cnight-to-dust-dapp && npm install
 *   2. Put this file in the repo's `scripts/` dir (so ../src imports resolve).
 *   3. Put your 24-word wallet seed phrase (space-separated) in a file named
 *      `owner.seed` in the repo ROOT. chmod 600 owner.seed
 *      (This must be the wallet whose STAKE KEY should hold the registration,
 *      and it must currently hold cNIGHT.)
 *   4. Get a free Blockfrost *mainnet* project id: https://blockfrost.io
 *
 * ── RUN from the repo root (dry run first — builds + prints, does NOT submit) ─
 *   CARDANO_NET=Mainnet BLOCKFROST_PROJECT_ID=mainnet_xxx \
 *     npx tsx scripts/register-once.ts <dustPKH-64-hex>
 *
 * ── RUN (actually submit) ────────────────────────────────────────────────────
 *   add  --submit  to the command above.
 *
 * NOTE ON cNIGHT ROTATION: the registration tx spends and re-creates all your
 * cNIGHT (by design). The builder errors if the wallet holds no cNIGHT.
 * ----------------------------------------------------------------------------
 */
import { readFileSync } from 'node:fs';
import { Lucid, Blockfrost } from '@lucid-evolution/lucid';
import { DustTransactionsUtils } from '../src/lib/dustTransactionsUtils';

const BLOCKFROST_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';

function parseDustPKH(arg: string): string {
  const v = arg.trim().toLowerCase();
  // The builder writes this straight into datum.dust_address (32-byte hex string).
  if (!/^[0-9a-f]{64}$/.test(v)) {
    throw new Error(
      `Bad dustPKH "${arg}" — expected a 64-hex-character (32-byte) DUST address. ` +
        `Do NOT guess it; see register-once.NOTES.md for how to source it correctly.`
    );
  }
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const submit = args.includes('--submit');
  const positional = args.filter((a) => !a.startsWith('--'));

  if (positional.length !== 1) {
    console.error('Usage: npx tsx scripts/register-once.ts <dustPKH-64-hex> [--submit]');
    console.error('Exactly one dustPKH is required — this script creates ONE registration.');
    process.exit(1);
  }
  const dustPKH = parseDustPKH(positional[0]);

  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  if (!projectId) throw new Error('Set BLOCKFROST_PROJECT_ID (a mainnet Blockfrost project id).');
  if (process.env.CARDANO_NET !== 'Mainnet') {
    console.warn('⚠️  CARDANO_NET is not "Mainnet" — set CARDANO_NET=Mainnet so mainnet policy IDs are used.');
  }

  const mnemonic = readFileSync('owner.seed', 'utf8').trim();

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, projectId), 'Mainnet');
  lucid.selectWallet.fromSeed(mnemonic);

  const walletAddr = await lucid.wallet().address();
  const stakeAddr = await lucid.wallet().rewardAddress();
  console.log('Wallet payment address:', walletAddr);
  console.log('Wallet stake address:  ', stakeAddr);
  console.log('DUST address (dustPKH):', dustPKH);
  console.log('\n⚠️  Confirm the stake key is at ZERO live registrations (Koios diagnostic)');
  console.log('    and that the DUST address above is correct BEFORE using --submit.');
  console.log(submit ? '\n*** SUBMIT MODE — will create ONE registration ***\n' : '\n*** DRY RUN (add --submit to send) ***\n');

  // Pure builder: mints the auth NFT and writes one registration UTxO with
  // datum (stakeKeyHash from the wallet, dust_address = dustPKH). No dup guard.
  const tx = await DustTransactionsUtils.buildRegistrationTransaction(lucid, dustPKH);

  if (!submit) {
    console.log('Built OK (dry run). Not submitting.');
    console.log('If this looks right, re-run with --submit to create the single registration.');
    return;
  }

  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  console.log('Submitted tx:', hash);
  console.log('Waiting for confirmation…');
  await lucid.awaitTx(hash);
  console.log('Confirmed. ✅');

  console.log('\nDone. Re-run the Koios diagnostic to confirm EXACTLY ONE live registration.');
  console.log('DUST generation resumes once exactly one live registration exists for the stake key.');
}

main().catch((e) => {
  console.error('\n❌ Failed:', e?.message ?? e);
  process.exit(1);
});
