# Midnight Release Template | Infrastructure

# Midnight Network — Infrastructure Release Template

> **Ledger era:** Midnight Ledger X.0
**Target networks:** Preview  
****Release date:** YYYY-MM-DD
**Document status:** `DRAFT` **Maintained by:** Midnight Protocol Engineering / Midnight Midnight Foundation Release Coordination
> 

---

## Overview

This release process is exclusive to major protocol release versions for infrastructure components: ledger, node, indexer, proof-server. 

A brief plain-language summary of what this release delivers — 2–3 sentences suitable for a mixed audience of node operators(FNOs), DApp developers, and ecosystem partners. State what changed, why it matters, and which networks are affected.

> Example: *This release delivers Midnight Ledger 8.0(+) to Preview, introducing breaking changes to the proof system and expanded unshielded transaction support. Node operators must upgrade to midnight-node 0.22.x before the target epoch. DApp developers should update all SDK packages to the versions listed in the compatibility matrix.*
> 

---

## Environments and endpoints

Midnight uses dedicated network services to power DApp development across Preview, Preprod, and Mainnet. The table below lists the active RPC, indexer, and proof server endpoints for this release.

| Environment | RPC endpoint | Indexer API | Proof server |
| --- | --- | --- | --- |
| Preview | `<rpc-preview-url>` | `<indexer-preview-url>` | `<proof-server-preview-url>` |
| Preprod | `<rpc-preprod-url>` | `<indexer-preprod-url>` | `<proof-server-preprod-url>` |
| Mainnet | `<rpc-mainnet-url>` | `<indexer-mainnet-url>` | `<proof-server-mainnet-url>` |

This table will be used to populate the docs source of truth under the [Environments and endpoints](https://docs.midnight.network/relnotes/network) section.

---

## Compatibility matrix

> This matrix reflects tested versions for this release only. Earlier versions may still function but are not guaranteed or supported.
> 

| Functional area | Component | Version | Notes |
| --- | --- | --- | --- |
| **Network** | Network | Preview / Preprod / Mainnet | Active testnet and mainnet environments |
|  | Node (Midnight) | X.Y.Z | Minimum required for this release |
|  | Ledger | X.Y.Z | Core ledger logic |
| **Indexing & Data** | Midnight Indexer | X.Y.Z | Midnight-specific blockchain indexer |
| **ZK & Proving** | Proof Server | X.Y.Z | Handles ZKP proof generation |
|  | ZK Circuit | X.Y.Z | Circuit version — must match node version |
|  | Prover key binding | `<hash>` | Operators must update if changed |
|  | Verifier key binding | `<hash>` |  |

---

## What’s new

### Feature or change title

Describe the feature or change in plain language. Include what it does, why it was introduced, and which component(s) are affected. This should be a summary of the release notes from each affected component.

**Affected components:** Node / Ledger / Indexer *(list applicable)*

- Node
- Ledger
- Indexer
- ….

---

## Improvements

| Component | Improvement | Impact |
| --- | --- | --- |
| Node | Brief description | Performance / stability / usability |
| Ledger | Brief description | Performance / stability / usability |
| Midnight Indexer | Brief description | Performance / stability / usability |

---

## Bug fixes

Bug fixes should be tied to existing Github Issues, where possible. This allows for a feedback loop to developers experiencing a specific issue. 

| GitHub Issue | Component | Description | Severity |
| --- | --- | --- | --- |
| #000 | Node | Brief description of the bug and what was fixed | High / Medium / Low |
| #000 | Ledger | Brief description of the bug and what was fixed | High / Medium / Low |
| #000 | Indexer | Brief description of the bug and what was fixed | High / Medium / Low |

---

## Backward Compatibility

Now that the Midnight mainnet is live, a certain amount of backward compatibility is expected. If an infrastructure release breaks that backward compatibility, it must be explicitly noted. Node operators should always run the latest version of the infrastructure, but DApp developers may or may not update their Dapps based on specific functionality depending on backward compatibility.

## Breaking changes

> ⚠️ Review this section carefully before upgrading. Breaking changes require action from node operators and/or DApp developers.
> 

### Change title

**Affected:** Federated Node Operators(FNOs)  / FNOs *(delete as applicable)*

**Component:** Node / Ledger / Compact JS / DApp Connector API / *(specify)*

**What changed:** Describe the breaking change precisely. Where relevant, include the old and new API signatures, config keys, or CLI flags.

**Action required:** Describe exactly what operators or developers must do before or after upgrading.

**Migration guide:** [Link to full migration guide](about:blank#)

---

*Add one sub-section per breaking change.*

---

## ZK and privacy layer changes

*Complete this section if this release includes changes to the proof system, shielded transaction logic, compliance oracle, or ZK circuit versions. This is a Midnight-specific gate with no equivalent in standard Cardano node releases.*

| Component | Previous version | This release | Notes |
| --- | --- | --- | --- |
| ZK circuit version | vA.B | vX.Y | Describe impact on existing proofs |
| Proof Server | vA.B | vX.Y |  |
| Prover key | `<prev-hash>` | `<new-hash>` | Operators must update prover keys if changed |
| Verifier key | `<prev-hash>` | `<new-hash>` |  |
| Proof generation SLA (median) | Xs | Xs | Benchmark: `bench/zk-gen-001` |
| On-chain verification budget | X ExUnits | X ExUnits | Benchmark: `bench/zk-verify-001` |
- [ ]  ZK circuit audit report reviewed (link: )
- [ ]  Outstanding audit findings triaged and documented

---

## Ledger and on-chain runtime changes

*Complete this section if this release modifies ledger state logic, transaction structure, or the on-chain runtime pallet.*

| Area | Change | Notes |
| --- | --- | --- |
| Transaction types | Describe any new or removed transaction types |  |
| Fee mechanism | Describe any changes to DUST/NIGHT fee logic |  |
| Ledger state | Describe state root or storage backend changes |  |
| Plutus / Compact circuit | Version change or new instruction support |  |
| Conway / governance | Any changes to on-chain governance integration |  |

---

## Governance and hard fork notes

*Complete this section only if this release is associated with an on-chain governance action or hard fork. Otherwise, a normal “rolling node update” process is expected.*

| Item | Detail |
| --- | --- |
| Hard fork name |  |
| Target epoch |  |
| On-chain governance action ID |  |
| Governance action state | `RATIFIED` / `ENACTED` |
| SPO upgrade threshold | ≥ 70% by stake required |
| Exchange upgrade status | Notified / Confirmed |
- [ ]  Midnight Foundation Hard Fork Working Group sign-off received
- [ ]  F/SPO upgrade threshold met (current status: TBD [SPO readiness dashboard](about:blank#))
- [ ]  Hard fork date confirmed with Midnight Foundation release coordination lead

---

## Privately Known issues

The obfuscation of privately known security issues is paramount to protocol security. Privately known issues should be communicated through the [Security Incident SOP](https://www.notion.so/SOP-Security-Incident-DRAFT-33f4057b9f23800cbf0eeb1c80a8bad9?pvs=21).

## Publicly Known issues

| Issue | Component | Description | Workaround |
| --- | --- | --- | --- |
| #000 | Indexer | Description of the known issue | Available workaround, or: *None — fix targeted for vX.Y.Z* |

---

## Component release notes and artefacts

Detailed release notes for each component are available at the links below. Use the artefact links to download or pull the correct version for your environment. Component release notes should conform to the [release notes template](https://github.com/midnightntwrk/midnight-docs/blob/main/RELEASE_NOTE_TEMPLATE.md).

| Component | Release notes | Artefact |
| --- | --- | --- |
| Ledger | [GitHub releases](https://github.com/midnightntwrk/midnight-ledger/releases) | Rust crate / WASM bindings |
| Node | [GitHub releases](https://github.com/midnightntwrk/midnight-node/releases) | `docker pull midnightntwrk/midnight-node:X.Y.Z` |
| Indexer | [GitHub releases](https://github.com/midnightntwrk/midnight-indexer/releases) | `docker pull midnightntwrk/midnight-indexer:X.Y.Z` |
| Compact Compiler | [GitHub releases](https://github.com/midnightntwrk/compact/releases) | `compact install X.Y.Z` |
| DApp Connector API | [GitHub releases](https://github.com/midnightntwrk/midnight-dapp-connector-api/releases) | `npm install @midnight-ntwrk/dapp-connector-api@X.Y.Z` |
| Wallet SDK | [Release notes](https://github.com/midnightntwrk/midnight-wallet/tree/main/release-notes) | `npm install @midnight-ntwrk/wallet-api@X.Y.Z` |
| Midnight.js | [GitHub releases](https://github.com/midnightntwrk/midnight-js/releases) | `npm install @midnight-ntwrk/midnight-js@X.Y.Z` |
| Compact JS | [Release notes](https://github.com/midnightntwrk/midnight-sdk/blob/main/compact-js/RELEASE_NOTES.md) | `npm install @midnight-ntwrk/compact-js@X.Y.Z` |
| Proof Server | GitHub releases | `docker pull midnightntwrk/proof-server:X.Y.Z` |

---

## Upgrade instructions

### Prerequisites

Before upgrading, confirm the following:

- Midnight Node `≥ X.Y.Z`
- Cardano Node `≥ 10.x` (partner chain dependency)
- `midnight-db-sync` `≥ A.B.C`
- Ledger era: Conway+
- Plutus: V3 required

### Steps for node operators (SPOs / FNOs)

1. Review the **Breaking changes** and **ZK and privacy layer changes** sections above.
2. Confirm your node key management and KES rotation is current.
3. Pull the updated Docker image and verify the SHA-256 digest against published artefact hashes.
4. Stop your running node instance gracefully.
5. Apply any configuration schema changes documented in the migration guide.
6. Restart the node. Confirm sync resumes and block production is stable within 2 epochs.
7. If running your own Midnight Indexer, pull the updated indexer image and reset per the migration guide if required.
8. Report any issues via [midnightntwrk/midnight-node](https://github.com/midnightntwrk/midnight-node/issues).

### Steps for DApp developers

1. Update SDK packages to the versions in the compatibility matrix above.
2. Recompile any Compact contracts using the updated `compactc` version.
3. Update circuit artefacts (prover key, verifier key, ZKIR) if the ZK circuit version has changed.
4. Run your test suite against the updated testnet environment using `testkit-js`.
5. Verify DApp Connector API compatibility with the updated wallet interface.

### Rollback

If you need to revert to the previous version, follow the [rollback procedure](about:blank#). Rollback criteria (e.g. block production below threshold within Y epochs) and the on-call rota are documented in the release readiness checklist.

---

## Release readiness gate status

This release is governed by the Midnight Foundation release readiness gate process. The table below summarises the gate verdict for each section at time of publication.

| Section | Status | Blocking? |
| --- | --- | --- |
| Release artefacts | ⬜ / ✅ | Yes |
| Network checks (Preview) | ⬜ / ✅ | Yes |
| Hard fork coordination | ⬜ / ✅ / N/A | If applicable |
| ZK and privacy layer validation | ⬜ / ✅ | Yes |
| Testing sign-off | ⬜ / ✅ | Yes |
| Security review | ⬜ / ✅ | Yes |
| Documentation | ⬜ / ✅ | No |
| Rollback plan | ⬜ / ✅ | Yes |
| Sign-off matrix | ⬜ / ✅ | Yes |

**Overall gate verdict:** `⬜ NOT YET ASSESSED` / `🔴 BLOCKED` / `🟡 CONDITIONAL` / `✅ CLEARED`

Full readiness checklist: [link to release readiness document](about:blank#)

---

## Sign-off

| Role | Name | Sign-off date | Status |
| --- | --- | --- | --- |
| Release Engineering Lead |  |  | ⬜ Pending |
| Protocol Engineering Lead |  |  | ⬜ Pending |
| ZK / Privacy Engineering Lead |  |  | ⬜ Pending |
| Security Lead |  |  | ⬜ Pending |
| QA / Testing Lead |  |  | ⬜ Pending |
| Release Lead && FNO liason (MNF) |  |  | ⬜ Pending |
| Ecosystem / Tooling Lead |  |  | ⬜ Pending |
| Hard Fork WG Chair (if applicable) |  |  | ⬜ Pending |

---

## Documentation and communication checklist

- [ ]  [Release notes](https://github.com/midnightntwrk/midnight-docs/blob/main/RELEASE_NOTE_TEMPLATE.md) drafted and reviewed per affected component
- [ ]  New compatibility matrix PR to [docs.midnight.network](https://docs.midnight.network/relnotes/support-matrix) (appended to existing)
- [ ]  Migration guide included in release notes for node operators (link: )
- [ ]  `CHANGELOG.md` updated in all affected repositories
- [ ]  Configuration schema changes documented
- [ ]  API / CLI breaking changes documented with migration path
- [ ]  Notifi communication prepared
    - [ ]  SPO bulletin published on Midnight Foundation forum (link: )
    - [ ]  Midnight Foundation Discord announcement drafted and reviewed
    - [ ]  Twitter/X post drafted (link: )

---
