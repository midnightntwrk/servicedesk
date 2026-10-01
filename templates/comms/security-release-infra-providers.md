---
audience: "infrastructure-providers"
when_to_use: "A node security release has been distributed privately to validators and the public release is still pending"
owner: "mn-sre"
last_reviewed: "2026-10-01"
---

# Security release notice — infrastructure providers

> Send once the majority of validators have upgraded via the private release. Do not include details of the vulnerability.

---

**Subject: Midnight Node [vX.Y.Z] — security release, action may be required**

Hi all,

We have released Midnight Node **[vX.Y.Z]**, a security release that may require action on your side.

**Background**
As this release addresses a security issue, it was distributed through a private repository to block producers first and withheld from public release until the majority of validators had upgraded. That threshold has now been reached.

**How to get it**
- **Now:** the release is available in the private **[private release repo]** repository. If you don't yet have access, contact **[channel/email]** and we'll add you.
- **Soon:** we are backporting the fix to the public repository. The public release (source, tagged images, release notes) is expected **[date / "in the coming days"]**, and we'll confirm here once it's live.

**What you need to do**
- **Upgrade** any nodes you operate (RPC, archive, indexer backends) to **[vX.Y.Z]**, either from the private repo now or from the public release once available.
- **[Config changes, flags, DB resync or compatibility notes — or "No configuration changes are required."]**

Full details of the issue will be shared once network-wide adoption is sufficient. Until then, please don't discuss it publicly or redistribute the private build.

Questions? Reach out in **[channel]** or at **[contact]**.

Thanks for your continued support,
[Name / Midnight team]
