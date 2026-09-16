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
   rotation), and now `src/lib/utils.ts` (imported for the address decode) also calls
   `getRuntimeConfig()` via `getMidnightNetworkId()` — so the same server-vs-client branch
   and the same fix apply, in one more module. Re-check `src/config/runtime-config.ts` on
   current `main`.
2. **`@/` path-alias resolution under `tsx`** — try `npx tsx --tsconfig ./tsconfig.json …`
   first, else the `node --import tsx --import tsconfig-paths/register …` loader form.
   Note: `src/lib/utils.ts` imports `@/config/runtime-config`, so it needs alias resolution
   too — same fix, nothing new.

See that file for the detail; do not duplicate the fixes here, just apply them.

Also confirm on current `main` that `src/lib/utils.ts` still exports `getDustAddressBytes`,
`getDustAddressFromBytes`, `validateDustAddress`, and `getMidnightNetworkId` with these
signatures — the script imports them directly. They depend on
`@midnight-ntwrk/wallet-sdk-address-format` (`MidnightBech32m`, `DustAddress`); a major bump
of that package could change `.serialize()` output, which is exactly why the round-trip
check is in the script.

## The registration-specific hazard: the DUST address (now handled in-script)

Unlike the deregister path (where `dustPKH` is unused and passed as `''`), here the DUST
address is written verbatim into the datum as **the address that will receive DUST**. A
wrong value silently registers DUST to an address the user does not control —
unrecoverable, and it still consumes their one valid registration slot.

**The script now removes the hand-typing hazard.** The user passes their PUBLIC
`mn_dust1…` address (no hex), and `resolveDustPKH()`:
1. `validateDustAddress(addr, networkId)` — rejects anything that isn't a valid DUST
   address for the network.
2. `getDustAddressBytes(addr, networkId)` — the **DApp's own** derivation
   (`MidnightBech32m.parse(addr).decode(DustAddress, networkId).serialize().toString('hex')`,
   `src/lib/utils.ts`). This is byte-for-byte what the DApp writes when it registers
   (`WalletContext.tsx` derives `dustPKH` the same way from `api.getDustAddress()`), so we
   don't hand-roll bech32 and the 32-vs-33-byte question is moot — whatever `.serialize()`
   yields is correct by construction.
3. **Round-trip check:** `getDustAddressFromBytes(hex, networkId)` must reproduce the
   input string exactly, or the script throws and refuses to build. `getDustAddressBytes`
   / `getDustAddressFromBytes` are proven inverses in production (`WalletContext.tsx` line
   ~775 reconstructs the address from the on-chain datum this way).

So the safe source of the value is simply **the user's own `mn_dust1…` address**, which
they can read from their Midnight wallet. Confirm the FULL string with them (short prefixes
collide); the round-trip check does the rest. A raw-hex override path exists for advanced
use but should not be needed.

Still true: **never derive it from a seed**, and if `validateDustAddress` or the round-trip
fails, do NOT submit — investigate first.

## Recommended validation before handing over

1. Clone the dapp at current `main`, `npm install`; drop the script in `scripts/`.
2. Confirm on current `main` that `buildRegistrationTransaction` is still
   `(lucid, dustPKH)` and still has no dup-guard (structure can drift).
3. Run the **dry run** (no `--submit`) against a real `mn_dust1…` address (a test-network
   one with `CARDANO_NET` set to match). Expect the "Round-trip re-encode … ✅ matches
   input" line, then "Built OK (dry run)" if the wallet holds cNIGHT, or the builder's
   "No cNIGHT tokens found" error if it doesn't. The round-trip line proves the address
   decode + `utils.ts` imports resolve; the rest proves the builder path (config, aliases,
   cNIGHT lookup) without submitting.
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
