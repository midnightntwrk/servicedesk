# Internal note: running `register-once.ts`

Support-side notes for validating the script **before** handing it to a user, and for
sourcing `dustPKH` safely. Not for the user — the user only needs the inline header + the
setup/run steps in the issue reply.

This is the registration mirror of `deregister-specific.ts`. It reuses the dapp's own
`DustTransactionsUtils.buildRegistrationTransaction(lucid, dustPKH)`, verified on current
`main` to be a **pure, single-registration builder**: it mints the auth NFT and pays one
UTXO to the mapping validator with datum `{ c_wallet: VerificationKey[stakeKeyHash],
dust_address: dustPKH }`. **It has no existing-registration guard** — it will happily
create a second registration if one already exists, which is the duplicate bug. So this
script is only safe when the stake key is confirmed at ZERO.

## The two caveats from `deregister-specific.NOTES.md` apply verbatim

Same runtime, same builder module, so both still bite:

1. **`getRuntimeConfig()` under plain node** — set `CARDANO_NET=Mainnet`. The registration
   builder calls `getCnightUnitFromConfig()` too (it filters the wallet's cNIGHT UTXOs for
   rotation), so the same server-vs-client branch and the same fix apply. Re-check
   `src/config/runtime-config.ts` on current `main`.
2. **`@/` path-alias resolution under `tsx`** — try `npx tsx --tsconfig ./tsconfig.json …`
   first, else the `node --import tsx --import tsconfig-paths/register …` loader form.

See that file for the detail; do not duplicate the fixes here, just apply them.

## The registration-specific hazard: getting `dustPKH` wrong

Unlike the deregister path (where `dustPKH` is unused and passed as `''`), here `dustPKH`
is the **DUST address that will receive DUST**, written verbatim into the datum. A wrong
value silently registers DUST to an address the user does not control — unrecoverable, and
it still consumes their one valid registration slot. This is the main reason **Path A
(register via the DApp after clearing its cache) is the default** — the DApp derives
`dustPKH` from the connected wallet, so the user never hand-types it. Only reach for this
script when the stale UI won't clear.

Sourcing `dustPKH` for the script, safest first:
- **From the DApp itself.** With the DApp open (even on the stale screen), the DUST address
  it would register is visible in the DUST-address field / the `[DustTransactions]`
  registration log line (`dustPKH: …`). That is the exact 32-byte hex to pass.
- **Cross-check against a prior known-good registration** for this user if one exists in
  the diagnostic history — but only if the user *intends the same DUST address*. Note the
  datum bytes printed by `cnight_dust_diag.py` may carry a leading tag/length byte from the
  CBOR parse; compare the trailing 32 bytes, and confirm length is 64 hex before trusting.
- **Never derive it yourself from a seed or address guess.** If you cannot get an
  authoritative 32-byte value, do not run the script — use Path A.

## Recommended validation before handing over

1. Clone the dapp at current `main`, `npm install`; drop the script in `scripts/`.
2. Confirm on current `main` that `buildRegistrationTransaction` is still
   `(lucid, dustPKH)` and still has no dup-guard (structure can drift).
3. With a **test** wallet's `owner.seed`, run the **dry run** (no `--submit`) against a
   throwaway 64-hex dustPKH — expect "Built OK (dry run)" if the wallet holds cNIGHT, or the
   builder's "No cNIGHT tokens found" error if it doesn't. Either proves the builder path
   (config, aliases, cNIGHT lookup) resolves without submitting.
4. Only once (1)–(3) pass, give the user the reply.

## Other run facts (already in the script header, repeated for reviewers)

- The registration tx rotates **all** cNIGHT (spends + re-creates it) — by design. The
  builder errors with "No cNIGHT tokens found" if the wallet holds none, so the user must
  register from the wallet that actually holds the cNIGHT.
- Authorization/identity is the wallet's **stake key hash** (`addressDetails.stakeCredential.hash`),
  added as a signer; `fromSeed` provides it. This is what the registration is keyed to.
- The script enforces **exactly one** dustPKH argument and dry-runs by default — there is no
  batch/multi mode, deliberately, because the target state is exactly one registration.
- Never accept a user's seed. The script reads it from a local `owner.seed`; the user runs
  it and signs locally.
