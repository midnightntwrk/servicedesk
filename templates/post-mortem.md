---
audience: "node-operators developers internal"
when_to_use: "After any P1 or P2 incident is resolved"
owner: "mn-sre"
last_reviewed: "2026-04-29"
---

# Incident Post-Mortem — [Incident title]

**Date:** YYYY-MM-DD
**Duration:** HH:MM – HH:MM UTC
**Severity:** P1 / P2
**Networks affected:** [Mainnet / Preprod / Preview]
**Linked GitHub issue:** [#number](https://github.com/midnightntwrk/servicedesk/issues/NUMBER)
**PagerDuty incident:** [PD-XXXXX] _(P1 only)_

## Summary

[1–3 sentences: what happened, its impact on users or the network, and how it was resolved.]

## Timeline

| Time (UTC) | Event |
|-----------|-------|
| HH:MM | First detection — [who noticed, how] |
| HH:MM | PagerDuty triggered / team notified |
| HH:MM | [First diagnostic step] |
| HH:MM | Root cause identified |
| HH:MM | Fix deployed to [network] |
| HH:MM | Incident resolved — network / service restored |

## Root cause

[Technical description of the underlying cause. Be specific: which component, which code path, what condition triggered it.]

## Contributing factors

[What made this incident worse or harder to detect — gaps in monitoring, missing runbooks, unclear escalation paths, etc.]

## Resolution

[What was done to resolve the incident — hotfix deployed, configuration change, rollback, etc.]

## Impact

| Metric | Value |
|--------|-------|
| Duration | X hours Y minutes |
| Users affected | [estimate or "unknown"] |
| Networks affected | [list] |
| Blocks missed / transactions failed | [if applicable] |

## Action items

| Action | Owner | Due | Issue |
|--------|-------|-----|-------|
| [Preventive or detection improvement] | @handle | YYYY-MM-DD | [#] |
| [Runbook update] | @handle | YYYY-MM-DD | [#] |
| [Monitoring gap addressed] | @handle | YYYY-MM-DD | [#] |

## Lessons learned

**What worked well:**
- [Things that helped contain or resolve the incident quickly]

**What could be improved:**
- [Gaps in tooling, process, or communication]

---

_Written by [Name] · Published [Date] · Reviewed by [Name]_
