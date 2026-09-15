/**
 * deregister-specific.ts
 * ----------------------------------------------------------------------------
 * Spend one or more *specific* cNIGHT→DUST registration UTXOs at the mapping
 * validator, to clear duplicate registrations the DApp can't see/clear.
 *
 * It reuses the DApp's OWN transaction builder
 * (DustTransactionsUtils.buildUnregistrationTransaction) so the datum/redeemer,
 * auth-NFT burn, and cNIGHT rotation exactly match production behaviour.
 *
 * On-chain authorization for a registration is the STAKE-KEY signature (the
 * datum's c_wallet), which the wallet owner has — so registrations pointing at
 * a *different* DUST address (invisible in the DApp UI) are still removable.
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
 *      (This must be the wallet whose STAKE KEY made the registrations.)
 *   4. Get a free Blockfrost *mainnet* project id: https://blockfrost.io
 *
 * ── RUN from the repo root (dry run first — builds + prints, does NOT submit) ─
 *   CARDANO_NET=Mainnet BLOCKFROST_PROJECT_ID=mainnet_xxx \
 *     npx tsx scripts/deregister-specific.ts \
 *       f05696e60b808d66958e2e31b61893cbcddfc9e2d90c09b26479dbb36f0552e6#0
 *
 * ── RUN (actually submit) ────────────────────────────────────────────────────
 *   add  --submit  to the command above.
 *
 * NOTE ON cNIGHT ROTATION: each unregister tx also spends and re-creates all
 * your cNIGHT (this is by design — it voids that block's DUST-production tx).
 * When clearing multiple UTXOs the script submits them ONE AT A TIME and waits
 * for each to confirm, so the next tx sees the freshly-rotated cNIGHT.
 * ----------------------------------------------------------------------------
 */
import { readFileSync } from 'node:fs';
import { Lucid, Blockfrost, type UTxO } from '@lucid-evolution/lucid';
import { DustTransactionsUtils } from '../src/lib/dustTransactionsUtils';

const BLOCKFROST_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';

function parseRef(arg: string): { txHash: string; outputIndex: number } {
  const [txHash, ixStr] = arg.split('#');
  if (!txHash || txHash.length !== 64 || ixStr === undefined) {
    throw new Error(`Bad UTxO ref "${arg}" — expected <64-hex-txhash>#<index>`);
  }
  return { txHash, outputIndex: Number(ixStr) };
}

async function main() {
  const args = process.argv.slice(2);
  const submit = args.includes('--submit');
  const refs = args.filter((a) => !a.startsWith('--')).map(parseRef);

  if (refs.length === 0) {
    console.error('Usage: npx tsx deregister-specific.ts <txhash#ix> [<txhash#ix> ...] [--submit]');
    process.exit(1);
  }

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
  console.log(`Targets: ${refs.length} registration UTxO(s) to spend.`);
  console.log(submit ? '\n*** SUBMIT MODE ***\n' : '\n*** DRY RUN (add --submit to send) ***\n');

  for (const ref of refs) {
    const refStr = `${ref.txHash}#${ref.outputIndex}`;
    console.log(`\n──── ${refStr} ────`);

    const found = await lucid.utxosByOutRef([ref]);
    if (found.length === 0) {
      console.log('  Not found on-chain (already spent, or wrong ref). Skipping.');
      continue;
    }
    const utxo: UTxO = found[0];
    console.log('  Found. address:', utxo.address);

    // dustPKH is unused in the unregister path — the builder only needs the UTxO.
    const tx = await DustTransactionsUtils.buildUnregistrationTransaction(lucid, '', utxo);

    if (!submit) {
      console.log('  Built OK (dry run). Not submitting.');
      continue;
    }

    const signed = await tx.sign.withWallet().complete();
    const hash = await signed.submit();
    console.log('  Submitted tx:', hash);
    console.log('  Waiting for confirmation…');
    await lucid.awaitTx(hash);
    console.log('  Confirmed. ✅');
  }

  console.log('\nDone. Re-run the Koios diagnostic to confirm exactly ONE (or ZERO) live registration remains.');
}

main().catch((e) => {
  console.error('\n❌ Failed:', e?.message ?? e);
  process.exit(1);
});
