# Midnight Network — ServiceDesk

Single entry point for bug reports, support requests, and operational reference across the Midnight ecosystem.

**[→ Open the landing page](https://midnightntwrk.github.io/servicedesk)**

---

## Raise a ticket

| What | Template |
|------|----------|
| 🐛 Bug or unexpected behaviour | [Open bug report](../../issues/new?template=bug-report.yml) |
| ❓ Technical support or question | [Open help request](../../issues/new?template=help-request.yml) |
| 📚 Developer documentation gap or error | [Open doc improvement](../../issues/new?template=documentation-improvement.yml) |
| 🔒 Security vulnerability | [GitHub private reporting](../../security/advisories/new) — or email security@midnight.foundation if unavailable |

Feature requests follow the product process, not this tracker.

---

## Support board

[MNF-STL-Support project board](https://github.com/orgs/midnightntwrk/projects/33) — Kanban view of all open tickets.

---

## Priority and SLA targets

| Priority | Label | Description | Response target | Handled by |
|----------|-------|-------------|-----------------|------------|
| P1 Critical | `priority:p1` | Network down, consensus failure, active exploit | 30 min — any time | PagerDuty + `@shieldedtech/shielded-sre` |
| P2 High | `priority:p2` | Major feature broken, security vulnerability, significant user impact | 4 business hours | SLA clock; cc `@shieldedtech/shielded-sre` on breach |
| P3 Medium | `priority:p3` | Feature degraded, workaround available | 1 business day | SLA clock; cc `@shieldedtech/shielded-sre` on breach |
| P4 Low | `priority:p4` | Minor issue, cosmetic, enhancement | 3 business days | SLA clock |

Business hours: 09:00–18:00 UTC, Monday–Friday.
P1 critical issues require synchronous notification in addition to filing a GitHub issue.

---

## Reference documents

| Document | Audience |
|----------|----------|
| [Runtime Upgrade vs Hardfork Guide](./documents/hard-fork-runtime-upgrades.md) | Node operators |
| [Bootstrap Node Governance Model](./documents/bootnodes.md) | Node operators · Draft |
| [Triage & Workflow Process](./process.md) | Triage team |
| [AI Bug Report Policy](./ai-reports.md) | All reporters |
| [Copy-paste Templates](./templates/) | SRE / comms |

---

## Security

Vulnerabilities must not be filed as public issues.

**Primary:** Use [GitHub private vulnerability reporting](../../security/advisories/new).  
**Fallback:** Email [security@midnight.foundation](mailto:security@midnight.foundation) if GitHub reporting is unavailable or goes unanswered within 3 business days.

See [SECURITY.md](./SECURITY.md) for the full policy.

---

## Labels reference

Labels applied automatically by the triage workflow:

| Prefix | Values | Applied by |
|--------|--------|-----------|
| `priority:` | `p1` `p2` `p3` `p4` | `triage.yml` — from Severity field |
| `comp:` | node, ledger, indexer, proof-server, zk, compiler, zkir, runtime, sdk-js, wallet, dapp-connector, faucet, partner-chains, bridge, charts, metrics, build, docs | `triage.yml` — from Component field |
| `network:` | mainnet, preprod, preview | `triage.yml` — from Network field |
| `source:` | user-report, grafana, anomaly-detector, indexer-alert, internal-test, other | `triage.yml` — from First seen field |
| `sla:` | response-at-risk, response-breached | `sla-clock.yml` — hourly |
| `pd:` | paged | `p1-pagerduty.yml` — on P1 trigger |
| `type:` | bug, question, docs | Set by Issue Form |
| `status:` | triage | Set by Issue Form |

---

## Getting help

- **Docs:** [docs.midnight.network](https://docs.midnight.network)
- **Discussions:** [GitHub Discussions](../../discussions)
- **Discord:** Midnight Network community server
- **Contributing:** See [CONTRIBUTING.md](./CONTRIBUTING.md)
