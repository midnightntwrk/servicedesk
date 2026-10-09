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
| [Migrating from the official indexer/RPC to Blockfrost](indexer-blockfrost-migration-runbook/indexer-blockfrost-migration-runbook.md) | Switching mainnet (official endpoints scheduled to shut down; still answering 2026-10-07) or preprod to Blockfrost: URL and `project_id` changes, the event-id offsets measured between the official indexer and Blockfrost, preseed bundles, and "Wallet sync timeout" right after funding, because Blockfrost's indexer backs off unshielded progress updates on idle subscriptions; and how to tell which indexer a preseed bundle was cut against. |
| [Batched deploy for oversized contracts](contract-batched-deploy-runbook/contract-batched-deploy-runbook.md) | Deploy fails with "exceeded block limit in transaction fee computation", or is rejected with RPC 1010 "Transaction would exhaust the block limits" (SDK: "Transaction submission error"), because every circuit's verifier key rides in the deploy and a tx may use only ~65% of the 50 KB/block `bytesWritten` limit. Fix: deploy a subset, then insert the remaining keys via maintenance updates. |
| [Toolchain and package version mismatch](toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md) | Contract import, deploy or proving fails before submission ("Version mismatch: compiled code expects …", "Failed to configure constructor context with coin public key", "expected instance of ContractMaintenanceAuthority", "export named 'Clock'", proof server `400` on `/check`) because the compiler, runtime, wallet SDK or ZKIR format isn't the network-supported set (the newest compiler and runtime are ahead of every network), or the contract and midnight-js load different on-chain runtime copies. |
| [Node rejection codes (1010 "Custom error: N")](node-1010-custom-error-runbook/node-1010-custom-error-runbook.md) | Submission fails with only `(FiberFailure) SubmissionError: Transaction submission error`. The node's reason, `1010: Invalid Transaction: Custom error: N`, is in `String(err)` and the `RPC-CORE` console line, not `err.message` (midnight-js contract calls do include it), and N depends on the node version (node 2.x renumbers ten codes; preview, preprod and mainnet run 1.0.400). Decoder script, and fixes for 182 intent TTL, 193 already on chain, 196 or `TransactionInvalidError` DUST already spent, 170 DUST proof, 168 fee checks, 186 effects check. |
| [Compact compile errors in AI-written code](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) | `compact compile` rejects a contract an agent wrote or copied: invented names (`unbound identifier`), old names (`apparent use of an old … name`), methods ledger types don't have (`Map.get`), syntax and operators from other languages, missing `disclose()`, and features from newer compilers (0.34.0, 0.35.0) on the 0.31.1 compiler the networks need. A checker flags the known mistakes and explains the compiler's message with a fix that compiles. |

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
| `exceeded block limit in transaction fee computation` | [Batched deploy](contract-batched-deploy-runbook/contract-batched-deploy-runbook.md) |
| `Transaction would exhaust the block limits` (RPC 1010) | [Batched deploy](contract-batched-deploy-runbook/contract-batched-deploy-runbook.md) |
| `1010: Invalid Transaction: Custom error:` (any N) | [Node rejection codes](node-1010-custom-error-runbook/node-1010-custom-error-runbook.md) |
| `Transaction submission error` with no code in `err.message` (look for `RPC-CORE: submitAndWatchExtrinsic` on the console) | [Node rejection codes](node-1010-custom-error-runbook/node-1010-custom-error-runbook.md) |
| `Transaction is invalid and was rejected by the node` | [Node rejection codes](node-1010-custom-error-runbook/node-1010-custom-error-runbook.md) |
| `Version mismatch: compiled code expects` | [Toolchain mismatch](toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md) |
| `Failed to configure constructor context with coin public key` | [Toolchain mismatch](toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md) |
| `expected instance of ContractMaintenanceAuthority` | [Toolchain mismatch](toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md) |
| `does not provide an export named 'Clock'` | [Toolchain mismatch](toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md) |
| `unbound identifier` (from `compact compile`) | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `apparent use of an old standard-library / ledger operator name` | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `undefined for ledger field type` | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `potential witness-value disclosure must be declared but is not` | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `no compatible function named` | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `language version` … `mismatch` (0.23.0, 0.26.0 or 0.27.0, from `compact compile`) | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `has no field named` | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `(which is reserved for future use)` | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `cross-contract calls are not yet supported` / `contract-info.json; try (re)compiling` | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
| `another binding found for` … `in the same scope` | [Compact compile errors](compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md) |
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
