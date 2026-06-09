# Applying the v1.6 uplift

This archive contains every new and modified file for the servicedesk v1.6 uplift.
Apply it to an existing clone of `midnightntwrk/servicedesk` using the commands in §19 of the spec
(or Appendix H of the workbook document).

## What changed between v1.5 and v1.6

### v1.6 changes (this archive)
- `CODEOWNERS` — simplified: global owner is now `@hegaleon` only; exactly 3 files carry `mn-security` co-review
- `.github/workflows/route-iac.yml` — NEW: routes issues labelled `route:iac` to `shieldedtech/shielded-iac`

### Files in this archive

#### Modified files (existing files with targeted changes)
- `.github/workflows/triage.yml` — SHA pin fix: @v7 → @3a2844b (v9.0.0)
- `.github/ISSUE_TEMPLATE/bug-report.yml` — corrects ai-reports.md URL
- `CODEOWNERS` — simplified ownership; 3 security-gated files; global owner @hegaleon
- `README.md` — condensed fallback format; corrected labels, SLA table, security contact

#### New files
- `.github/workflows/route-iac.yml` — on `route:iac` label: mirrors issue to shieldedtech/shielded-iac, comments back, stamps route:iac:routed
- `.github/workflows/data-refresh.yml` — 15-min cron: writes _data/sla.yml and _data/activity.yml
- `.github/workflows/template-staleness.yml` — weekly: opens tracking issues for stale templates
- `.github/ISSUE_TEMPLATE/documentation-improvement.yml` — replaces documentation-improvement.md
- `_config.yml` — Jekyll/Pages site config
- `index.html` — Jekyll landing page (Liquid-templated)
- `_layouts/default.html` — Jekyll HTML shell with all styles
- `_data/sla.yml` — placeholder (populated by data-refresh.yml)
- `_data/announcements.yml` — placeholder
- `_data/activity.yml` — placeholder (populated by data-refresh.yml)
- `templates/release-notes.md` — copy-paste template with front-matter
- `templates/announcement.md` — copy-paste template with front-matter
- `templates/post-mortem.md` — copy-paste template with front-matter

#### Files to remove
- `.github/ISSUE_TEMPLATE/documentation-improvement.md` — superseded by .yml version

## Secrets required before merging

| Secret name | Used by | How to obtain |
|---|---|---|
| `PAGERDUTY_ROUTING_KEY` | `p1-pagerduty.yml` | PagerDuty → Integrations → API Access Keys |
| `IAC_APP_ID` | `route-iac.yml` | GitHub App settings page → App ID field |
| `IAC_APP_PRIVATE_KEY` | `route-iac.yml` | GitHub App settings page → Generate a private key |

`PAGERDUTY_ROUTING_KEY` is likely already present if P1 paging is operational.
`IAC_APP_ID` and `IAC_APP_PRIVATE_KEY` must be added as repository secrets before `route-iac.yml` is triggered.

# Applying the v1.7.3 uplift (snag-list: resolve-page-issues)

Apply to an existing clone of `midnightntwrk/servicedesk` on branch
`chore/resolve-page-issues`. Full steps in §10 of `SPEC-v1.7.3.md`.

## New files
- `.github/workflows/pages.yml` — GitHub Actions Pages deployment
- `SPEC-v1.7.3.md` — this specification

## Replaced files (overwrite entirely — do not merge)
- `index.html` — complete replacement; 633 lines; MD5 b9e2227e843ae8e0c55bef3c1daf0b00
- `CHANGELOG.md` — complete replacement

## Modified files (surgical change)
- `_layouts/default.html` — one Issues nav link inserted after Process link

## Appended files
- `APPLY.md` — this section

## Files verified unchanged
- `templates/*.md` — all links confirmed active (snag f)
- `documents/*.md` — all links confirmed active (snag f)
- `_config.yml`, `CODEOWNERS`, `README.md` — no changes needed
- `SECURITY.md` — security-gated; not touched on this branch

## Post-merge manual step (required)
Settings → Pages → Source → GitHub Actions

## Secrets required
No new secrets. Pre-existing secrets needed:

| Secret | Used by |
|--------|---------|
| `PAGERDUTY_ROUTING_KEY` | `p1-pagerduty.yml` |
| `IAC_APP_ID` | `route-iac.yml` |
| `IAC_APP_PRIVATE_KEY` | `route-iac.yml` |
