# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.2] — 2026-06-09

### Added
- `.github/workflows/pages.yml` — GitHub Actions Pages deployment workflow;
  prevents Pages source resetting to None (snag a)
- `index.html` — live open-issues board section, populated via GitHub public
  API on page load (snag c)
- `index.html` — Security section with private advisory CTA and
  mn_security_issue group roster (snag e)
- `index.html` — Issues nav link in top navigation bar (snag b)
- `SPEC-v1.7.2.md` — specification with complete file manifest for this branch

### Fixed
- `index.html` — SLA tile counts were hardcoded zeros; replaced with live
  GitHub Search API calls (snag d)
- `index.html` — copyTemplate() now accepts btn parameter; shows error state
  and opens fallback URL if fetch or clipboard write fails
- `_layouts/default.html` — Issues nav link added for parity with index.html
- `CHANGELOG.md` — was empty; this entry

### Changed
- `index.html` — footer text updated to reflect API-based data source
- `index.html` — SLA band heading timestamp is now live rather than hardcoded

