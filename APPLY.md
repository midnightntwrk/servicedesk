# Applying the v1.5 uplift

This archive contains every new and modified file for the servicedesk v1.5 uplift.
Apply it to an existing clone of `midnightntwrk/servicedesk` using the commands in §16 of the spec.

## Files in this archive

### Modified files (existing files with targeted changes)
- `.github/workflows/triage.yml` — SHA pin fix: @v7 → @3a2844b (v9.0.0)
- `.github/ISSUE_TEMPLATE/bug-report.yml` — corrects ai-reports.md URL
- `CODEOWNERS` — adds p1-pagerduty.yml, sla-clock.yml, documents/, templates/, _data/
- `README.md` — condensed fallback format; corrected labels, SLA table, security contact

### New files
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

### Files to remove
- `.github/ISSUE_TEMPLATE/documentation-improvement.md` — superseded by .yml version
