# Runbooks

Reusable diagnosis-and-fix guides for recurring Midnight ecosystem issues — written to
be picked up by a human or an AI agent mid-incident. Each runbook is self-contained:
symptom, root cause, key identifiers, a runnable diagnostic (prefer no-API-key where
possible), remediation options, and links to source/specs/tracking issues.

**Agents:** read [AGENTS.md](AGENTS.md) first — separate guidance for agents resolving an
issue on behalf of a user vs. MNF/STL accounts triaging and authoring runbooks.

## Index

| Runbook | Covers |
|---|---|
| [cNIGHT→DUST duplicate registrations](cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md) | "DUST stopped generating" / balance 0 caused by 2+ live registration UTXOs for one Cardano stake key (DApp filter bug). |
| [WalletFacade balance/finalization hang](wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md) | Balance/finalize never returns — CPU-bound, unbounded RSS growth — from a non-terminating DUST fee-balancing loop, triggered by minting a new custom shielded token. |
| [Migrating from the official indexer/RPC to Blockfrost](indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) | Switching mainnet (official endpoints scheduled to shut down; still answering 2026-10-02) or preprod to Blockfrost: URL and `project_id` changes, the event-id offsets measured between the official indexer and Blockfrost, preseed bundles, and "Wallet sync timeout" right after funding, because Blockfrost's indexer backs off unshielded progress updates on idle subscriptions. |
| [Wallet sync stuck after the indexer changed](wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md) | Restored or saved wallet state fails its first sync update forever ("values inserted non-linearly into … tree", "received an event with a timestamp prior to the time already synced to"). The saved cursor is an indexer database id, so it breaks after a provider switch, a re-sync of the same endpoint, or blue/green. Not fixed by a ledger upgrade. |

## Error-string lookup

Triage shortcut: search the issue body or logs for these exact strings (a grep is enough).
Symptoms overlap, so confirm the runbook's root cause before acting.

| Error text (exact substring) | Runbook |
|---|---|
| `values inserted non-linearly into dust generation tree` | [Cursor mismatch](wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md) (and [Blockfrost](indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) if the app just switched) |
| `values inserted non-linearly into dust commitment tree` | [Cursor mismatch](wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md) |
| `values inserted non-linearly into zswap commitment tree` | [Cursor mismatch](wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md) |
| `received an event with a timestamp prior to the time already synced to` | [Cursor mismatch](wallet-sync-cursor-indexer-mismatch-runbook/wallet-sync-cursor-indexer-mismatch-runbook.md) |
| `Missing project token. Please include project_id in your request.` / `Invalid project token.` | [Blockfrost](indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) |
| `Wallet sync timeout after 90000ms` with `unshielded=false` | [Blockfrost](indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) |
| `TypeError: Invalid URL` at wallet build (placeholder `nodeWS`) | [Blockfrost](indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) |
| `Replicate Registrations Detected` | [cNIGHT→DUST duplicates](cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md) |
| No error: `balanceUnboundTransaction` / `balanceTransaction` never returns, CPU-bound, RSS climbing | [Balancing hang](wallet-dust-balancing-hang-runbook/wallet-dust-balancing-hang-runbook.md) |

## Conventions for adding a runbook

- **One directory per runbook.** Each runbook gets its own second-level directory,
  `<area>-<short-topic>-runbook/`, holding the runbook file and every supporting asset —
  so all material for an issue stays self-contained. The runbook file inside it keeps the
  same name: `<area>-<short-topic>-runbook/<area>-<short-topic>-runbook.md` (kebab-case).
- **Structure:** Symptom → Root cause → Key identifiers → Diagnose (script/steps) →
  Remediation options → Reference material (source, specs, issues, worked cases).
- **Verify before asserting.** Midnight moves fast; treat code line references and
  version-specific claims as point-in-time. Note the compile date and re-verify against
  current source. Prefer verified source/on-chain evidence over recalled knowledge.
- **Never take user keys or seed phrases.** Remediations that require signing must be run
  by the affected user locally; provide the script, not a request for their secrets.
- **Add a row to the Index above** when you add a runbook (link to the file inside its
  directory), and add its exact error strings to the **Error-string lookup**.
- **Companion scripts** live in a `scripts/` subdirectory of the runbook's own directory
  and are linked from the runbook that uses them. A script meant to run inside another repo
  must say where it goes and keep any relative imports valid for that location.
