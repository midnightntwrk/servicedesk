# Runbook: WalletFacade balance/finalization hang (DUST fee balancing spins forever)

A server-side wallet call to balance/finalize a transaction **never returns**: the process
goes CPU-bound and RSS climbs without bound until a watchdog/OOM kills it. The transaction is
never submitted. Use this to recognise the fingerprint, confirm it's the DUST-balancing loop,
and unblock the operator.

_Compiled 2026-09-17 from session investigation (source read at midnight-wallet commit
`7365f982f1149930764334e30a744848d3d67829`). Verify line references and versions against
current source before asserting — the Midnight ecosystem changes fast._

---

## Symptom

- App calls `WalletFacade.balanceUnboundTransaction()` (or `balanceTransaction` /
  `balanceAndProveTransaction` / `estimateTransactionFee`) after constructing and proving a
  transaction. The call **enters and never returns**; the last app-level marker is something
  like `wallet-balance/finalization-enter`.
- The operator/wallet process is **CPU-bound** and its **RSS grows continuously** (reported
  case: ~510 MiB → ~1.74 GiB before a watchdog killed it; a related report saw 3.4 GB at
  15 min, ~16 MB/s then ~1.2 MB/s with no plateau). No error is thrown — it just spins.
- Node, proof server and indexer stay healthy; the wallet is fully synced (all pending
  counts 0) *before* the call. So it is **not** a sync/replay problem.
- Strongly correlated with transactions that **mint a brand-new custom shielded token type
  the wallet has never held** (e.g. deploying/initialising a contract that mints its own
  token), and with an operator wallet that **has already paid several fees** (holds multiple
  part-drained DUST coins). A plain NIGHT transfer from the same wallet balances fine.

## Root cause

A **non-terminating fixed-point loop** in DUST fee balancing, caused by a **sign-convention
bug**. `TransactingCapabilityImplementation.computeBalancingRecipe`
(`packages/dust-wallet/src/v1/Transacting.ts`, lines ~617-692) runs
`Effect.iterate(..., { while: (s) => !s.converged })` **with no iteration cap**, exiting only
on `converged: newFee <= recipeAmountCoverage`.

- The loop **seed** (`initialFees`) is the ledger's own **signed** imbalance from
  `feeImbalance()` (line ~607): *negative* means "DUST deficit," which the shared balancer
  reads as "select more input coins."
- On every pass after the first, `currentFee` is reassigned to `newFee` — the return of
  `dryRunFee` → `calculateFee` (`feesWithMargin`, lines ~565-605), an **unsigned,
  always-positive absolute fee**, not a signed imbalance.
- Feeding that positive value into `CapImbalances.fromEntry('dust', currentFee)` (line ~652)
  makes the shared balancer `doBalance` (`packages/capabilities/src/balancer/Balancer.ts`)
  misread the shortfall as a **surplus**: with `outputFeeOverhead: 0n` and target `0n`,
  `shouldAddOutput` becomes `newFee >= 0` → always true. It manufactures a change output
  (`CounterOffer.addOutput`) that zeroes the internal imbalance **without selecting any
  coin** → `recipe.inputs` comes back **empty**.
- With `recipeInputs = []`, `dryRunFee([], …)` is a pure function of inputs that never change,
  so it returns the **same** `newFee` forever; `recipeAmountCoverage` stays `0n`; `converged`
  is `false` forever. **Absorbing fixed point**, not slow convergence.
- Each pass still does real work — `CoreWallet.spendCoins`, a fresh `Intent` /
  `DustActions` / `Transaction` (WASM-backed `ledger-v8`), `eraseProofs`/`merge` — so the
  loop is CPU-bound and allocates fresh WASM objects every iteration that can't be reclaimed:
  that is the unbounded RSS growth.
- Because coin selection is never reached again, **`InsufficientFundsError` can never fire** —
  the failure is a silent hang, never a thrown "insufficient DUST."

**Why a custom-token mint triggers it and a plain transfer doesn't.** The bug only activates
once pass 1 fails to converge. Pass 1 picks whole DUST UTXOs (ascending `chooseCoin`, which
overshoots), and for a plain transfer the small marginal fee of attaching one DUST spend is
absorbed by that overshoot → converges on pass 1, never touching the buggy branch. A
market/contract **init that mints a new shielded token** carries a Compact circuit call with
its own ZK proof + new commitment/nullifier structure, which raises `feesWithMargin` for the
merged transaction beyond the pre-attachment estimate — pass 1 under-covers, pass 2 hits the
sign bug's fixed point, and it can never escape **regardless of how much DUST the wallet
holds**. This matches the reported minimal boundary shape (segment count 1, identifier
count 1, 0 offers, DUST action false): cost is dominated by the mint payload, not offer/
segment counts.

This is a **DUST-balancing** defect only. Shielded balancing
(`packages/shielded-wallet/src/v1/TransactionImbalances.ts`) consumes the ledger's
already-signed `imbalances()` map directly with no unsigned re-derivation, so a zero-held new
token type there throws `InsufficientFundsError` in a single pass instead of looping —
consistent with the hang being at (never returning from) the DUST step.

## Key identifiers

- **Affected packages / commit.** All seven packages in the reported stack tag the **same**
  monorepo release cut → `7365f982f1149930764334e30a744848d3d67829`:
  `@midnight-ntwrk/wallet-sdk-facade@4.1.0`, `wallet-sdk-shielded@3.0.2`,
  `wallet-sdk-dust-wallet@4.2.0`, `wallet-sdk-unshielded-wallet@3.1.0`,
  `wallet-sdk-runtime@1.0.5`, `wallet-sdk-capabilities@3.3.1`, `wallet-sdk@1.2.0`;
  with `@midnight-ntwrk/ledger-v8@8.1.0`.
- **Suspect code** (`midnightntwrk/midnight-wallet`, at that commit):
  - `packages/dust-wallet/src/v1/Transacting.ts` — `computeBalancingRecipe` (~617-692);
    loop `while: !s.converged` (~642); termination `newFee <= recipeAmountCoverage` (~677);
    signed seed `feeImbalance` (~607); positive-fee reinjection at `CapImbalances.fromEntry`
    (~652); `dryRunFee`/`calculateFee` (~565-605).
  - `packages/capabilities/src/balancer/Balancer.ts` — `doBalance` `shouldAddOutput` branch.
  - `packages/capabilities/src/balancer/CounterOffer.ts` — `addOutput` (zeroes imbalance, no
    input selected).
  - `packages/facade/src/index.ts` — `balanceUnboundTransaction` (~604-670), the
    shielded → unshielded → **dust** dispatch. (Reporter's cited `3695-3781` is a bundled/dist
    line range, not this source file.)
- **Fix (upstream):** `midnightntwrk/midnight-wallet` **PR #741** —
  "fix(dust-wallet): terminate `computeBalancingRecipe` instead of looping forever"
  (branch `chrispalaskas/dust-fee-balancing-terminates`). **Open / unmerged as of the compile
  date — not in any published release.** Verified downstream first as a wrapper
  (`shieldedtech/moth-wallet#141`, `#142`) with live-devnet A/B traces.
- **Not** these (ruled out): `midnight-wallet#648` (shielded `pendingOutputs.values.map`
  sync failure — needs a real pending output; here pending=0), `#639` (DUST *state size /
  deserialize* from foreign generation leaves — here DUST state is ~180 KiB, 7-11 ms),
  `#704` (facade memory leak scaling with `appliedIndex` during **sync** — here the hang is
  in balancing, not sync).

## Diagnose (no API key)

1. **Confirm the fingerprint** (all four): call never returns from a `WalletFacade`
   balance/finalize method; process CPU-bound; RSS growing monotonically; the transaction
   **mints a new shielded token the wallet holds 0 of** (contract/market init). If any is
   absent, reconsider — see the ruled-out issues above.

2. **Confirm the operator is on an affected build.** The fix (PR #741) is unmerged, so
   **every currently-published `wallet-sdk-dust-wallet` is affected**; this check is really
   "are they on the SDK at all, and is it pre-fix?":

   ```sh
   npm ls @midnight-ntwrk/wallet-sdk-dust-wallet @midnight-ntwrk/wallet-sdk-facade \
          @midnight-ntwrk/wallet-sdk-capabilities @midnight-ntwrk/ledger-v8 2>/dev/null
   # affected if dust-wallet resolves to 4.2.0 (or any release lacking PR #741).
   ```

3. **Confirm it's the DUST leg, not shielded/unshielded.** Two cheap ways:
   - The facade dispatches serially shielded → unshielded → **dust** (`index.ts:604-670`);
     shielded/unshielded balancing of a zero-held new token **throws** quickly rather than
     spinning, so a silent CPU-bound spin with no throw is the DUST step.
   - If you can add a log or break: the spin is inside `computeBalancingRecipe`'s
     `Effect.iterate`; `recipe.inputs` will be **empty** on pass 2+ while `newFee` stays a
     fixed positive number. That empty-inputs-with-positive-fee pair *is* the bug.

## Remediation

Fastest to slowest / most invasive. Accrued funds are never at risk — the tx was never
submitted.

1. **Fail fast instead of OOM (operational stopgap).** Wrap the balance/finalize call in a
   bounded timeout so a spin surfaces as a bounded error rather than an OOM watchdog kill.
   Does **not** fix it — just stops the 1 GiB+ RSS blowup while you apply a real remedy.

2. **Consolidate the operator's DUST into fewer, larger UTXOs (primary workaround).** The
   loop only diverges when pass-1 whole-coin selection can't cover the fee the mint induces.
   A wallet holding one/few DUST coins each **comfortably larger than the transaction fee**
   converges on pass 1 and never reaches the sign bug. Practically: drain the many
   part-drained sub-fee dust coins (they regenerate toward the per-NIGHT cap), or run the
   mint from a freshly-registered operator whose DUST hasn't been fragmented by prior fees.
   Re-fragmentation reintroduces the risk, so keep the fee-paying operator's DUST few-and-fat.

3. **Reduce the fee jump the mint introduces (situational).** Anything that lowers the merged
   transaction's `feesWithMargin` relative to the pre-balance estimate widens the pass-1
   convergence margin (e.g. not co-bundling several new-token mints into one balance call).
   Weaker than (2); use only if consolidation isn't available.

4. **Upgrade once PR #741 ships (real fix).** It rewrites `computeBalancingRecipe` to seed
   every pass with a signed deficit, feed measured per-input fee overhead so a second pass
   completes, and terminate structurally (a pass selecting no coin fails
   `SelectionMadeNoProgress`) rather than on a counter — and returns `InsufficientFundsError`
   for genuinely unaffordable pools instead of hanging. **Not yet released**; watch PR #741 /
   the dust-wallet changelog and re-verify the fix is in the version you pin.

5. **Client-side wrapper (only if you can't wait and can patch).** The same fix was first
   shipped downstream as a wrapper around the SDK loop (`shieldedtech/moth-wallet#141`,
   `#142`). Reserve for teams already comfortable patching the balancing path; prefer (2)
   otherwise.

## Reference material

- Worked support case this runbook came from: `midnightntwrk/servicedesk#194`.
- Upstream fix / tracking: `midnightntwrk/midnight-wallet#741` (open/unmerged at compile
  date). Downstream reproduction + traces: `shieldedtech/moth-wallet#141`, `#142`.
- Source (commit `7365f982f1149930764334e30a744848d3d67829`):
  `packages/dust-wallet/src/v1/Transacting.ts`,
  `packages/capabilities/src/balancer/Balancer.ts`,
  `packages/capabilities/src/balancer/CounterOffer.ts`,
  `packages/facade/src/index.ts`,
  `packages/shielded-wallet/src/v1/TransactionImbalances.ts`.
- Adjacent-but-distinct issues (do **not** conflate): `midnight-wallet#648`, `#639`, `#704`;
  and `#700` (read-only zero-fee → empty `DustActions`), a different DUST fee-path defect.
