# Comms Templates

Copy-paste message templates for direct communication with operators, infrastructure providers, and partners — the short notices that go out by email, Discord, or Slack rather than as published documents.

For long-form documents (release notes, announcements, post-mortems) use the templates in the parent [`templates/`](../) directory.

| Template | Audience | When to use |
|----------|----------|-------------|
| [Security release — infrastructure providers](./security-release-infra-providers.md) | Infrastructure providers (RPC, indexer, archive operators) | A security fix shipped privately to validators first, public release pending |

## Conventions

- Every template starts with the same frontmatter as the parent directory: `audience`, `when_to_use`, `owner`, `last_reviewed`.
- Placeholders are in `[square brackets]`. Optional lines are marked `[If applicable]` — delete them rather than leaving them blank.
- This repository is **public**. Do not commit vulnerability details, private repository names, internal contacts, or embargo dates into a template — keep those as placeholders and fill them in at send time.
