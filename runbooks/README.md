# Runbooks

Reusable diagnosis-and-fix guides for recurring Midnight ecosystem issues — written to
be picked up by a human or an AI agent mid-incident. Each runbook is self-contained:
symptom, root cause, key identifiers, a runnable diagnostic (prefer no-API-key where
possible), remediation options, and links to source/specs/tracking issues.

## Index

| Runbook | Covers |
|---|---|
| [cNIGHT→DUST duplicate registrations](cnight-dust-duplicate-registration-runbook.md) | "DUST stopped generating" / balance 0 caused by 2+ live registration UTXOs for one Cardano stake key (DApp filter bug). |

## Conventions for adding a runbook

- **Filename:** `<area>-<short-topic>-runbook.md` (kebab-case).
- **Structure:** Symptom → Root cause → Key identifiers → Diagnose (script/steps) →
  Remediation options → Reference material (source, specs, issues, worked cases).
- **Verify before asserting.** Midnight moves fast; treat code line references and
  version-specific claims as point-in-time. Note the compile date and re-verify against
  current source. Prefer verified source/on-chain evidence over recalled knowledge.
- **Never take user keys or seed phrases.** Remediations that require signing must be run
  by the affected user locally; provide the script, not a request for their secrets.
- **Add a row to the Index above** when you add a file.
- **Companion scripts** live in [`scripts/`](scripts/) and are linked from the runbook
  that uses them. A script meant to run inside another repo must say where it goes and
  keep any relative imports valid for that location.
