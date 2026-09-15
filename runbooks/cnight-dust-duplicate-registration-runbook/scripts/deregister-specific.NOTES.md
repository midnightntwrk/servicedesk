# Internal note: running `deregister-specific.ts`

Support-side notes for validating the script **before** handing it to a user. Not for the
user — the user only needs the inline header + the setup/run steps in the issue reply.

The script reuses the dapp's own `DustTransactionsUtils.buildUnregistrationTransaction`,
which is written for the browser / Next.js server, not for a standalone `tsx` process.
Two things can bite when running it outside the dapp's normal runtime. Neither affects
on-chain safety (the script dry-runs and only submits with `--submit`), but either will
stop it running.

## 1. `getRuntimeConfig()` under plain node

`buildUnregistrationTransaction` → `getCnightUnitFromConfig()` → `getRuntimeConfig()`.
That function branches on environment: server-side it reads `process.env`, client-side it
`fetch`es `/api/runtime-config`. In a bare `tsx` process there's no Next server and no
`window`, so:

- **Set `CARDANO_NET=Mainnet`** so it selects the mainnet branch. The mainnet cNIGHT
  policy id (`0691b2fe…`) and encoded name (`4e49474854`) are already in `defaultConfig`,
  so `CARDANO_NET` is the only env var the builder strictly needs.
- If `getRuntimeConfig()` still tries to `fetch` (i.e. it keys off `typeof window` and
  guesses wrong for node), the run fails with a fetch/URL error. Fix: call the
  server variant directly, or stub it. Quickest patch in the clone:
  ```ts
  // top of scripts/deregister-specific.ts, before importing the builder
  process.env.CARDANO_NET ||= 'Mainnet';
  ```
  and if needed, shim `globalThis.fetch` isn't the answer — instead confirm which branch
  `getRuntimeConfig` takes in `src/config/runtime-config.ts` on current `main` (it changes)
  and, worst case, import `getServerRuntimeConfig` and monkeypatch. Re-check this against
  the file each time; it's the part most likely to have drifted.

## 2. `@/` path-alias resolution under `tsx`

`dustTransactionsUtils.ts` imports `@/config/contract_blueprint`, `@/config/runtime-config`,
`@/lib/...` etc. `tsx` runs TypeScript but does **not** resolve tsconfig `paths` aliases by
default, so the transitive imports can fail with `Cannot find module '@/config/...'`.

Options, in order of preference:
- **`npx tsx --tsconfig ./tsconfig.json scripts/deregister-specific.ts …`** — try first;
  recent `tsx` honours `paths` from the given tsconfig.
- If that doesn't resolve them, add `vite-tsconfig-paths` isn't relevant here (no vite);
  use `tsconfig-paths`:
  `node --import tsx --import tsconfig-paths/register scripts/deregister-specific.ts …`
  (ESM loader form; the plain `-r tsconfig-paths/register` is CJS and won't apply).
- Last resort: change the one direct import in the script from `@/`… — it's already a
  relative import (`../src/lib/dustTransactionsUtils`), so the alias problem is purely in
  the dapp's own files; you can't relative-ise those without editing the dapp. So stick
  with the loader approach above rather than rewriting dapp source.

## Recommended validation before handing over

1. Clone the dapp at current `main`, `npm install`.
2. Drop the script in `scripts/`, create a throwaway `owner.seed` for a **test** wallet
   (or a mainnet wallet with a known spent/nonexistent ref so nothing submits).
3. Run the **dry run** (no `--submit`) against a real-but-already-spent ref — expect
   "Not found on-chain … Skipping", which proves lucid init + provider + wallet-from-seed
   all work end to end without building a tx.
4. Then dry-run against a live ref (still no `--submit`) — expect "Built OK (dry run)",
   which proves the builder path (`getRuntimeConfig`, contract blueprint, aliases) works.
5. Only once (1)–(4) pass, give the user the reply. The two caveats above are the only
   things that realistically fail in step 3–4.

## Other run facts (already in the script header, repeated for reviewers)

- Each unregister tx rotates **all** cNIGHT (spends + re-creates it) — by design, it voids
  that block's DUST-production tx. Multiple targets are therefore submitted **sequentially**
  with `awaitTx` between them, so tx N+1 sees the cNIGHT that tx N re-created.
- Authorization is the **stake-key signature** (datum `c_wallet`), which `fromSeed` provides
  via `rewardAddress()` — this is why duplicates pointing at a different DUST address are
  removable even though the DApp hides them.
- `dustPKH` arg is unused in the unregister path; pass `''`.
- Never accept a user's seed. The script reads it from a local `owner.seed`; the user runs
  it and signs locally.
