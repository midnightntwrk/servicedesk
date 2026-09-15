# AGENTS.md — runbooks

Instructions for AI agents working with these runbooks. There are two kinds of agent that
end up here; **work out which one you are first**, then follow that section. The
[README](README.md) holds the runbook format and authoring conventions; the repo-level
[`process.md`](../process.md) holds the wider triage/handover workflow. This file is about
*using* and *creating* runbooks specifically.

A runbook is a self-contained diagnosis-and-fix guide for a recurring Midnight ecosystem
issue: symptom → root cause → key identifiers → a runnable diagnostic → remediation
options → references. It's written to be picked up mid-incident by either kind of agent.

---

## Which agent are you?

- **You're resolving an issue on behalf of a user** — you're running in the user's own
  environment (their machine, wallet, repo) to fix *their* problem. → **Section 1.**
- **You're on an MNF/STL-owned account triaging user issues** — you're working the
  servicedesk front door / triage board, an account under `@midnightntwrk`. → **Section 2.**

If neither fits (e.g. you're just reading), default to Section 1's safety rules.

---

## Section 1 — Agents resolving an issue on behalf of a user

You are acting for the user. Your job is to get them unblocked safely, not to look
authoritative.

1. **Find the matching runbook** via the [Index](README.md). Match on the *symptom*, then
   confirm the *root cause* section actually describes the user's situation before acting —
   symptoms overlap.
2. **Work it top to bottom.** Run the diagnostic first (prefer the no-API-key path where
   the runbook offers one) and confirm the root cause from real evidence — on-chain state,
   indexer, source — before telling the user what's wrong.
3. **Verify before asserting.** Midnight moves fast. Code line references, version numbers,
   addresses and identifiers in a runbook are point-in-time as of its compile date. Re-check
   anything you're about to state as fact against current source (`/verify`, octocode, the
   actual repo) — do not repeat a runbook claim you haven't re-grounded.
4. **Never take the user's keys or seed phrase.** Not "paste it here", not "just for this
   step". Any remediation that requires signing is **run by the user, locally, on their
   machine.** Hand them the script; the script reads secrets from a local file that never
   leaves their machine (companion scripts live in the runbook's own `scripts/` subdirectory).
5. **Don't take irreversible or outward-facing actions on their behalf without explicit
   consent.** Submitting an on-chain transaction, posting publicly, moving funds — build it,
   **dry-run it**, show them, and let them run the real thing. Default to dry-run.
6. **If no runbook matches, don't improvise a fix and present it as settled.** Diagnose
   read-only, be explicit about what's confirmed vs guessed, and route the user to open an
   issue at the servicedesk front door (include the diagnostic output). A wrong "fix" that
   touches mainnet costs the user real money.
7. **Report faithfully.** If a diagnostic errored or a step was skipped, say so with the
   output. Don't declare it fixed until the on-chain / observed state confirms it.

---

## Section 2 — MNF/STL accounts triaging user issues

You're triaging on the board (see [`process.md`](../process.md)). Beyond resolving the case
in front of you, you turn hard-won triage findings into runbooks so the next occurrence is
cheap. **Create a runbook when the issue is recurring, or when diagnosing it took real
investigation that would otherwise be repeated.** One-off, self-evident issues don't need
one.

### Creating a runbook from a triage discussion

The triage thread *is* your source material — the worked case. (Example: servicedesk `#188`
→ `cnight-dust-duplicate-registration-runbook/`.) Distil it, don't transcribe it.

1. **Follow the README structure and conventions.** One directory per runbook,
   `<area>-<short-topic>-runbook/` (kebab-case), holding the runbook file
   `<area>-<short-topic>-runbook.md` and its assets. Sections: Symptom → Root cause →
   Key identifiers → Diagnose → Remediation options → Reference material. Add a row to the
   README [Index](README.md).
2. **Symptom** in the user's terms (what they'd search for), including the exact
   warning/error text. **Root cause** stated only once *verified* — pull the mechanism from
   source/spec/on-chain evidence, not from the thread's speculation. Note the compile date
   and treat every line-ref/version as point-in-time.
3. **Key identifiers**: prefer stable, *public* protocol values — validator addresses,
   policy IDs, token units, repo/spec paths. These make the runbook re-verifiable.
4. **Diagnostic**: include something runnable, and **prefer no-API-key** (e.g. a public
   indexer/explorer) so a user-side agent can run it without provisioning. Keep it
   self-contained.
5. **Remediation**: list the options with trade-offs. Every signing remediation is
   **run by the affected user locally — never request their keys/seed.** Companion scripts
   go in the runbook's own `scripts/` subdirectory, linked from the runbook; a script meant to run inside
   another repo must say where it goes, keep relative imports valid for that location, and
   default to a dry-run.
6. **Scrub PII and secrets.** No seed phrases or private keys, ever. Don't paste an
   individual user's personal data into the runbook body — link the worked-case issue number
   instead. Public on-chain identifiers and the issue link are fine; a person's private
   details are not.
7. **File the upstream bug** when the root cause is a product defect, and link that tracking
   issue in the runbook (e.g. `midnight-cnight-to-dust-dapp#249`). The runbook documents the
   workaround; the tracking issue is how it gets fixed for good.
8. **Reference material**: worked-case issue, upstream tracking issue(s), specs/source, and
   any internal context — so the next agent can re-verify rather than trust.

### Landing it

Open a PR against `main` (conventional-commit style, kebab-case branch). Runbook changes are
owned by `@midnightntwrk/mn-servicedesk` / `mn-sre` per [CODEOWNERS](../CODEOWNERS); get a
review before merge. Write so that **both** a human and a Section-1 agent can pick the runbook
up mid-incident with no other context.
