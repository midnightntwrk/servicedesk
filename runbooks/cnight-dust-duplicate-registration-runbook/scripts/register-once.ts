/**
 * register-once.ts
 * ----------------------------------------------------------------------------
 * Create exactly ONE cNIGHT→DUST registration UTXO at the mapping validator,
 * bypassing the DApp UI. Use this when the chain shows ZERO live registrations
 * for the stake key but the DApp still shows a stale screen that blocks (or
 * silently no-ops) the normal register flow.
 *
 * You pass your PUBLIC DUST address (`mn_dust1…`). The script converts it to the
 * exact on-chain bytes using the DApp's OWN address library
 * (getDustAddressBytes → @midnight-ntwrk/wallet-sdk-address-format), then
 * ROUND-TRIPS it back to an `mn_dust1…` string and refuses to continue unless it
 * matches what you typed. So there is no hand-typed hex and no way to silently
 * register to the wrong address. It then reuses the DApp's own registration
 * builder (DustTransactionsUtils.buildRegistrationTransaction) so the datum,
 * auth-NFT mint, and cNIGHT rotation exactly match production behaviour.
 *
 * ── ⚠️  READ BEFORE RUNNING ─────────────────────────────────────────────────
 * 1. Confirm the stake key is at ZERO live registrations first. This builder
 *    does NOT check — running it when a registration already exists RECREATES
 *    the duplicate-registration bug.
 * 2. Register only ONCE. Do not re-run "because the DApp didn't update" — that
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
 *     npx tsx scripts/register-once.ts mn_dust1yourfulladdress…
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
import {
  getDustAddressBytes,
  getDustAddressFromBytes,
  validateDustAddress,
  getMidnightNetworkId,
} from '../src/lib/utils';

const BLOCKFROST_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';

/**
 * Turn the user's PUBLIC `mn_dust1…` address into the exact hex the datum needs,
 * using the DApp's own library, and verify it by round-tripping back to a
 * `mn_dust1…` string. Throws unless the round trip reproduces the input.
 * (A raw 64+-hex value is also accepted as an advanced override, but the address
 *  form is strongly preferred — it can't be mistyped without failing validation.)
 */
function resolveDustPKH(input: string): string {
  const networkId = getMidnightNetworkId(); // 'mainnet' when CARDANO_NET=Mainnet
  const arg = input.trim();

  if (/^mn_dust/i.test(arg)) {
    if (!validateDustAddress(arg, networkId)) {
      throw new Error(
        `"${arg}" is not a valid DUST address for network "${networkId}". ` +
          `Check the full mn_dust1… string and that CARDANO_NET matches the address's network.`
      );
    }
    const hex = getDustAddressBytes(arg, networkId);
    if (!hex) throw new Error(`Could not decode DUST address "${arg}".`);

    // Round-trip: bytes → address must reproduce exactly what was typed.
    const roundTrip = getDustAddressFromBytes(hex, networkId);
    if (!roundTrip || roundTrip !== arg) {
      throw new Error(
        `Round-trip check FAILED — refusing to register.\n` +
          `  input:      ${arg}\n` +
          `  re-encoded: ${roundTrip}\n` +
          `Do not submit; report this to support.`
      );
    }
    console.log('DUST address (input):     ', arg);
    console.log('DUST bytes (datum, hex):  ', hex);
    console.log('Round-trip re-encode:     ', roundTrip, '  ✅ matches input');
    return hex;
  }

  // Advanced override: caller passed raw datum bytes directly.
  const v = arg.toLowerCase();
  if (/^[0-9a-f]+$/.test(v) && v.length % 2 === 0 && v.length >= 64) {
    const roundTrip = getDustAddressFromBytes(v, networkId);
    console.log('DUST bytes (datum, hex):  ', v, '  (raw override)');
    console.log('Decodes to address:       ', roundTrip ?? '(could not re-encode — double-check this is a DUST address)');
    return v;
  }

  throw new Error(
    `Bad DUST address "${input}". Pass your public mn_dust1… address ` +
      `(preferred), or raw datum bytes as hex.`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const submit = args.includes('--submit');
  const positional = args.filter((a) => !a.startsWith('--'));

  if (positional.length !== 1) {
    console.error('Usage: npx tsx scripts/register-once.ts <mn_dust1…-address> [--submit]');
    console.error('Exactly one DUST address is required — this script creates ONE registration.');
    process.exit(1);
  }

  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  if (!projectId) throw new Error('Set BLOCKFROST_PROJECT_ID (a mainnet Blockfrost project id).');
  if (process.env.CARDANO_NET !== 'Mainnet') {
    console.warn('⚠️  CARDANO_NET is not "Mainnet" — set CARDANO_NET=Mainnet so mainnet policy IDs and the mainnet DUST-address network are used.');
  }

  // Resolve + verify the DUST address BEFORE loading the wallet or building anything.
  const dustPKH = resolveDustPKH(positional[0]);

  const mnemonic = readFileSync('owner.seed', 'utf8').trim();

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, projectId), 'Mainnet');
  lucid.selectWallet.fromSeed(mnemonic);

  const walletAddr = await lucid.wallet().address();
  const stakeAddr = await lucid.wallet().rewardAddress();
  console.log('\nWallet payment address:   ', walletAddr);
  console.log('Wallet stake address:     ', stakeAddr);
  console.log('\n⚠️  Confirm the stake key is at ZERO live registrations, and that the');
  console.log('    DUST address above is your own, BEFORE using --submit.');
  console.log(submit ? '\n*** SUBMIT MODE — will create ONE registration ***\n' : '\n*** DRY RUN (add --submit to send) ***\n');

  // Pure builder: mints the auth NFT and writes one registration UTxO with
  // datum (stakeKeyHash from the wallet, dust_address = dustPKH). No dup guard.
  const tx = await DustTransactionsUtils.buildRegistrationTransaction(lucid, dustPKH);

  if (!submit) {
    console.log('Built OK (dry run). Not submitting.');
    console.log('If the DUST address above is correct, re-run with --submit.');
    return;
  }

  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  console.log('Submitted tx:', hash);
  console.log('Waiting for confirmation…');
  await lucid.awaitTx(hash);
  console.log('Confirmed. ✅');

  console.log('\nDone. Re-run the chain check to confirm EXACTLY ONE live registration.');
  console.log('DUST generation resumes once exactly one live registration exists for the stake key.');
}

main().catch((e) => {
  console.error('\n❌ Failed:', e?.message ?? e);
  process.exit(1);
});
