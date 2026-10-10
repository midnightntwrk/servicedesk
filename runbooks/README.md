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
| [Proof server and proving failures](proof-server-proving-failures-runbook/proof-server-proving-failures-runbook.md) | A deploy or call fails while proving: midnight-js `'check'`/`'prove' returned an error` (`ECONNREFUSED`/`ECONNRESET …:6300`, `Failed Proof Server response` with code 400, 404, 429 or 500, `AbortError: The user aborted a request.`) or the wallet's `(FiberFailure) Wallet.Proving: Failed to prove transaction`. Causes: a proof server still downloading its keys or exited after `Failed to fetch data … Giving up.`, flags lost to the image's `bash -c` entrypoint, a port nothing listens on, a wrong URL, a 400 whose reason is only in the verbose log, job capacity, timeouts, memory. Checker with a test proof. |
| [Node rejection codes (1010 "Custom error: N")](node-1010-custom-error-runbook/node-1010-custom-error-runbook.md) | Submission fails with only `(FiberFailure) SubmissionError: Transaction submission error`. The node's reason, `1010: Invalid Transaction: Custom error: N`, is in `String(err)` and the `RPC-CORE` console line, not `err.message` (midnight-js contract calls do include it), and N depends on the node version (node 2.x renumbers ten codes; preview, preprod and mainnet run 1.0.400). Decoder script, and fixes for 182 intent TTL, 193 already on chain, 196 or `TransactionInvalidError` DUST already spent, 170 DUST proof, 168 fee checks, 186 effects check. |

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
