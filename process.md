# Issue Triage & Workflow Process - STL/MNF Foundation

## Table of Contents

- [Overview](#overview)
- [The Strategy: The "Catch-All" Funnel](#the-strategy-the-catch-all-funnel)
- [1. Setup: The "Front Door" Repo](#1-setup-the-front-door-repo)
- [2. The Triage Board](#2-the-triage-board-github-projects)
- [3. The Workflow](#3-the-workflow-lather-rinse-repeat)
- [Advanced Automation](#advanced-automation-optional)
- [Roles Summary](#summary-of-roles)

---

## Overview

This document outlines the Midnight Network issue triage and workflow process for the Midnight Foundation team. The goal is to provide a unified, user-friendly intake system that routes issues to the correct component teams while preserving context and maintaining quality.

### Key Principles

1. **Single Entry Point**: All issues come through one repository
2. **No Technical Knowledge Required**: Users don't need to understand the architecture
3. **Preserve Context**: All conversation history follows the issue
4. **Efficient Routing**: Triage team routes to correct component repos
5. **Unified Tracking**: One project board shows all issues across all repos

---

## The Strategy: The "Catch-All" Funnel

The core concept is to create a **single repository specifically for intake**. This acts as your "Help Desk" for the entire Midnight blockchain ecosystem. **No code lives here, only issues.**

```mermaid
graph LR
    A[Community Users] --> B[midnight-foundation/issues]
    B --> C{Triage Team}
    C --> D[midnight-node]
    C --> E[midnight-ledger]
    C --> F[midnight-indexer]
    C --> G[compactc]
    C --> H[midnight-js]
    C --> I[midnight-wallet]
    C --> J[Other Repos...]

    D --> K[Component Engineers]
    E --> K
    F --> K
    G --> K
    H --> K
    I --> K
    J --> K

    style B fill:#e1f5ff
    style C fill:#fff4e6
    style K fill:#d4edda
```

---

## 1. Setup: The "Front Door" Repo

### Repository Configuration

This repository! https://github.com/midnightntwork/servicedesk/

**Permissions**: Open to the entire Midnight Foundation team for creating issues.

**Issue Templates**: YAML-based Issue Templates (using GitHub's `.github/ISSUE_TEMPLATE` feature).

### Required Fields

- Expected behavior
- Actual behavior
- Screenshots/logs
- Environment details (OS, versions, network)

**Dropdown asking**: "Which component does this impact?"

### Component Categories

```mermaid
mindmap
  root((Midnight<br/>Ecosystem))
    Blockchain Infrastructure
      Node
        Consensus
        Runtime
        RPC
      Ledger
        Transactions
        State Management
      Indexer
        Block Indexing
        GraphQL API
      ZK Proofs
        Circuits
        Proof System
      Proof Server
        Generation Service
    Smart Contracts
      Compact Compiler
        Compilation
        Type System
      ZKIR
        IR Generation
      Contract Runtime
        Execution
    Application Layer
      Midnight.js SDK
        Framework
        APIs
      Wallet SDK
        Key Management
        Transactions
      DApp Connector
        Integration
      Faucet
        Token Distribution
    Interoperability
      Partner Chains
        Cardano Bridge
      Bridge Contracts
        Cross-chain Ops
    Infrastructure
      Documentation
        Dev Docs
      Deployment
        Kubernetes
        Helm
      Metrics
        Observability
      Build System
        Nix
        Cargo
        Yarn
```

#### Component Breakdown

| Category | Components |
|----------|------------|
| **Blockchain Infrastructure** | • Node (midnight-node) - Consensus, runtime, RPC<br/>• Ledger (midnight-ledger) - Transaction processing, state<br/>• Indexer (midnight-indexer) - Block indexing, GraphQL API<br/>• ZK Proofs (midnight-zk) - Circuit implementation, proof system<br/>• Proof Server - ZK proof generation service |
| **Smart Contracts & Compilation** | • Compact Compiler (compactc) - Smart contract compilation<br/>• ZKIR - Zero-knowledge intermediate representation<br/>• Contract Runtime - On-chain execution environment |
| **Application Layer** | • Midnight.js SDK - TypeScript application framework<br/>• Wallet SDK (midnight-wallet) - Wallet operations<br/>• DApp Connector API - Application integration<br/>• Faucet - Token distribution service |
| **Interoperability & Integrations** | • Partner Chains - Cardano integration toolkit<br/>• Bridge Contracts - Cross-chain operations |
| **Infrastructure & Operations** | • Documentation (midnight-docs) - Developer documentation<br/>• Deployment (midnight-charts) - Kubernetes/Helm<br/>• Metrics & Monitoring - Observability tooling<br/>• Build System - Nix, Cargo, Yarn, Earthly |

### Additional Technical Context Needed

- **Network**: Testnet, Devnet, Localnet, Mainnet
- **Component Versions**: Node version, SDK version, compiler version
- **Build Environment**: Nix, Docker, Native (OS-specific)
- **Language Context**: Rust, TypeScript, Scheme (for Compact)

---

## 2. The Triage Board (GitHub Projects)

**Do not manage this via email notifications.**).

### Board Configuration

**View**: Kanban Board (Github project): MNF-STL-Support

**Columns**:
1. **New Triage** - All new issues land here automatically
2. **Needs Info** - Waiting for user clarification
3. **Validated** - Bug confirmed, ready for component assignment
4. **Engineering Backlog** - Assigned to component teams
5. **In Progress** - Actively being worked
6. **Testing/QA** - Fix ready for validation
7. **Done** - Resolved and closed

```mermaid
graph LR
    A[New Issue Created] --> B[New Triage]
    B --> C{Has Enough Info?}
    C -->|No| D[Needs Info]
    C -->|Yes| E{Can Reproduce?}
    D -->|User Responds| E
    D -->|14 Days No Response| F[Closed - Stale]
    E -->|No| G[Closed - Cannot Reproduce]
    E -->|Yes| H[Validated]
    H --> I{Transfer to<br/>Component Repo}
    I --> J[Engineering Backlog]
    J --> K[Sprint Planning]
    K --> L[In Progress]
    L --> M[Pull Request]
    M --> N[Testing/QA]
    N -->|Pass| O[Done]
    N -->|Fail| L
    O --> P[Closed - Fixed]

    style B fill:#fff4e6
    style D fill:#ffe8cc
    style H fill:#d4edda
    style J fill:#cce5ff
    style L fill:#b8daff
    style N fill:#c3e6cb
    style O fill:#d4edda
    style F fill:#f8d7da
    style G fill:#f8d7da
    style P fill:#d4edda
```

### Automation

- Set a workflow so that any new issue created in the repo is automatically added to the "New Triage" column
- Auto-label based on component selection from template
- Auto-assign to component maintainer teams

---

## 3. The Workflow: Lather, Rinse, Repeat

Here is how the Product Manager (PM) and Support team will execute the daily grooming cycle:

### Step 1: Intake (The User)

The user encounters a bug. They go to the issues repo and fill out the form.

#### Example Scenarios

| User Report | Potential Components |
|-------------|---------------------|
| "My proof generation fails with timeout error" | proof-server, midnight-zk, or contract issue |
| "Transaction not appearing in indexer GraphQL API" | node, ledger, or indexer issue |
| "Compact compiler errors on valid syntax" | compactc issue |
| "Wallet shows incorrect balance after transaction" | wallet SDK, indexer, or ledger issue |

**User doesn't need to know the internal architecture** - they just describe what broke and where they saw it break.

**Result**: A new issue appears in the "New Triage" column.

---

### Step 2: The Triage (PO/Support/Technical Triage Team)

**Frequency**: Daily (high priority), Twice weekly (normal priority)

The triage team looks at the "New Triage" column:

#### 1. Initial Assessment

✓ Is this a bug, feature request, or question?
✓ Is there enough information to reproduce?
✓ What component is actually affected?

#### 2. Validation & Reproduction

The triage engineer attempts to reproduce using:
- Local development environment (Nix devshell)
- Docker compose for service-level issues
- Test networks (devnet/testnet) for chain issues
- Relevant test suites (`cargo test`, `yarn test`)

#### 3. Component Determination

Key questions to route issues correctly:

```mermaid
graph TD
    Start{Issue Type?} --> ProofFails[Proof generation fails]
    Start --> TxNotIndexed[Transaction not indexed]
    Start --> WalletWrong[Wallet balance wrong]
    Start --> ContractFails[Contract deployment fails]
    Start --> SDKError[SDK throws error]

    ProofFails --> Q1{Compilation or<br/>Generation?}
    Q1 -->|Compilation| A1[compactc repo]
    Q1 -->|Generation| A2[midnight-ledger<br/>proof-server or<br/>midnight-zk]

    TxNotIndexed --> Q2{Visible on-chain<br/>via RPC?}
    Q2 -->|Yes| A3[midnight-indexer]
    Q2 -->|No| A4[midnight-node or<br/>midnight-ledger]

    WalletWrong --> Q3{Does indexer show<br/>correct data?}
    Q3 -->|Yes| A5[midnight-wallet]
    Q3 -->|No| A6[midnight-indexer or<br/>midnight-ledger]

    ContractFails --> Q4{At what stage?}
    Q4 -->|Compilation| A7[compactc]
    Q4 -->|Deployment Tx| A8[midnight-ledger]
    Q4 -->|Runtime Exec| A9[midnight-ledger<br/>onchain-runtime]

    SDKError --> Q5{Which package/<br/>function?}
    Q5 --> A10[midnight-js<br/>specific package]

    style Start fill:#e1f5ff
    style A1 fill:#d4edda
    style A2 fill:#d4edda
    style A3 fill:#d4edda
    style A4 fill:#d4edda
    style A5 fill:#d4edda
    style A6 fill:#d4edda
    style A7 fill:#d4edda
    style A8 fill:#d4edda
    style A9 fill:#d4edda
    style A10 fill:#d4edda
```

#### 4. Interaction

**If insufficient information**:
- Comment with specific questions using template responses
- Move to "Needs Info" column
- Set 7-day response timer

**If reproduced successfully**:
- Add reproduction steps to issue
- Move to "Validated" column
- Add technical labels (language, subsystem, severity)

#### 5. Labeling Strategy

**Component labels**:
```
comp:node, comp:ledger, comp:indexer, comp:zk, comp:compiler,
comp:sdk-js, comp:wallet, comp:proof-server, comp:faucet,
comp:partner-chains, comp:docs
```

**Language labels**:
```
lang:rust, lang:typescript, lang:scheme, lang:compact
```

**Severity labels**:
- `sev:critical` - Chain halt, data loss, security
- `sev:high` - Major functionality broken
- `sev:medium` - Workaround available
- `sev:low` - Minor inconvenience

**Type labels**:
```
type:bug, type:feature, type:docs, type:performance,
type:security, type:build, type:test
```

**Area labels**:
```
area:consensus, area:rpc, area:storage, area:crypto,
area:compilation, area:runtime, area:api, area:cli
```

---

### Step 3: The Handover (The "Transfer" Feature)

This is the most critical technical step. GitHub has a native **"Transfer Issue"** button on the right sidebar of every issue.

#### Process

```mermaid
sequenceDiagram
    participant User
    participant IssuesRepo as midnight-foundation/issues
    participant TriageTeam as Triage Engineer
    participant CompRepo as Component Repository
    participant Engineer as Component Engineer

    User->>IssuesRepo: Creates issue
    IssuesRepo->>TriageTeam: Notification
    TriageTeam->>TriageTeam: Validates & reproduces
    TriageTeam->>TriageTeam: Determines component
    TriageTeam->>IssuesRepo: Click "Transfer Issue"
    IssuesRepo->>CompRepo: Transfers issue (preserves history)
    CompRepo->>Engineer: CODEOWNERS notification
    Engineer->>CompRepo: Reviews issue
    Engineer->>CompRepo: Adds technical context
    Engineer->>CompRepo: Creates PR
    Engineer->>User: Notifies of fix
    User->>CompRepo: Verifies fix
```

#### Component Router

| Issue Component | Target Repository |
|----------------|-------------------|
| Node/Consensus/Runtime | `midnight-node` |
| Ledger/Transactions/ZK | `midnight-ledger` |
| Indexer/GraphQL/Query | `midnight-indexer` |
| ZK Circuits/Proofs | `midnight-zk` |
| Compact Compiler/ZKIR | `compactc` |
| SDK/DApp Framework | `midnight-js` |
| Wallet SDK | `midnight-wallet` |
| Faucet Service | `midnight-faucet` |
| Partner Chains/Bridge | `partner-chains` |
| Documentation | `midnight-docs` |
| Deployment/Infra | `midnight-charts` |

#### What Happens During Transfer

1. Issue physically moves from issues repo to target repo
2. All comments, screenshots, and history are preserved
3. The URL changes, and a redirect is left behind
4. Original submitter is notified of the transfer
5. Component team is auto-notified via CODEOWNERS

---

### Step 4: Engineering Grooming

**Frequency**: Weekly/Bi-weekly per component team

Now the issue exists inside the correct engineering repo.

#### 1. Component Team Review

- Tech lead or maintainer reviews the validated issue
- Assesses effort and complexity
- Determines sprint/milestone assignment
- May request additional technical investigation

#### 2. Technical Context Addition

Engineers add:
- Relevant code pointers (`file:line_number`)
- Related test cases that need updating
- Breaking change assessment
- API/ABI compatibility considerations
- Documentation update requirements

#### 3. Assignment

- PO or tech lead adds priority labels:
  - `priority:critical`, `priority:high`, `priority:medium`, `priority:low`
- Assigns to specific engineer or team
- Moves to "Engineering Backlog" column on unified project board

#### 4. Sprint Planning

- Engineers pick issues from backlog during sprint planning
- Move to "In Progress" when work begins
- Link PRs to issues for automatic tracking
- Move to "Testing/QA" when PR is merged to development branch

#### 5. Verification & Closure

- QA validates fix on appropriate network (devnet/testnet)
- Original reporter is asked to verify if possible
- Issue moves to "Done" and is closed
- If regression, issue is reopened and moved back to "In Progress"

---

## Advanced Automation (Optional)

If our volume gets high, we can use GitHub Actions to assist:

### Auto-Labeling

```mermaid
graph LR
    A[User selects<br/>Component] --> B{Auto-Labeling}
    B --> C[Compact Compiler]
    B --> D[Wallet SDK]
    B --> E[Proof timeout<br/>mentioned]

    C --> F[comp:compiler<br/>lang:scheme]
    D --> G[comp:wallet<br/>lang:typescript]
    E --> H[area:crypto<br/>comp:proof-server]

    style A fill:#e1f5ff
    style B fill:#fff4e6
    style F fill:#d4edda
    style G fill:#d4edda
    style H fill:#d4edda
```

**Examples**:
- If user selects "Compact Compiler" → auto-apply `comp:compiler`, `lang:scheme`
- If user selects "Wallet SDK" → auto-apply `comp:wallet`, `lang:typescript`
- If user mentions "proof timeout" → auto-apply `area:crypto`, `comp:proof-server`

### Smart Routing

- Parse error messages in issue body
- Match against known error patterns per component
- Suggest target repo for triage engineer

### Stale Bot

- Automatically close issues in "Needs Info" if user hasn't replied in 14 days
- Send 7-day warning before closure
- Allow easy reopening if user responds later

### Version Detection

- Parse version strings from issue body
- Auto-tag with version labels (e.g., `v0.26.0`)
- Flag if version is outdated/unsupported

### Duplicate Detection

- Use GitHub's native duplicate detection
- Suggest similar issues during filing
- Auto-link related issues by error message similarity

### CODEOWNERS Integration

- Automatically request review from component maintainers
- Route to correct Slack/Discord channels by component
- Ensure SLA compliance per component team

---

## Summary of Roles

```mermaid
graph TD
    User[User/Community Member] -->|Files issue| Issues[midnight-foundation/issues]
    Issues --> Triage[Triage Team]

    Triage -->|Daily review| Review{Review & Validate}
    Review -->|Need info| NeedInfo[Request Info]
    Review -->|Validated| Transfer[Transfer to Component Repo]

    Transfer --> Comp[Component Repository]
    Comp --> TechLead[Tech Lead/Maintainer]
    TechLead --> Engineer[Component Engineer]

    Engineer -->|Creates PR| PR[Pull Request]
    PR --> QA[QA/Testing Team]
    QA -->|Verified| Close[Close Issue]
    Close -->|Notify| User

    User -->|Verifies| Final{Verified?}
    Final -->|Yes| Done[Done]
    Final -->|Regression| Engineer

    style User fill:#e1f5ff
    style Triage fill:#fff4e6
    style TechLead fill:#cce5ff
    style Engineer fill:#b8daff
    style QA fill:#c3e6cb
    style Done fill:#d4edda
```

### Role Breakdown

#### User/Community Member
- Files raw issue in `midnight-foundation/issues`
- Provides environment details and reproduction steps
- Responds to clarification requests
- Verifies fixes when possible

#### Triage Team (PO/Support/Community Managers)
- Daily review of "New Triage" column
- Reproduces bugs and validates reports
- Routes issues to correct component repos
- Manages "Needs Info" follow-ups
- Maintains issue quality and completeness

#### Component Engineers
- Never looks at the issues repo directly
- Reviews issues transferred to their component repo
- Adds technical context and estimates
- Implements fixes and links PRs
- Verifies fixes are complete

#### Tech Leads/Maintainers
- Weekly grooming of component backlog
- Prioritizes issues for sprint planning
- Reviews complex issues requiring architectural decisions
- Ensures cross-component issues are properly coordinated

#### QA/Testing Team
- Validates fixes on appropriate networks
- Runs regression test suites
- Coordinates release testing
- Closes verified issues

---

## Midnight-Specific Considerations

### Multi-Language Stack

```mermaid
graph TD
    Issue[Issue Reported] --> Lang{Language?}

    Lang --> Rust[Rust Issue]
    Lang --> TS[TypeScript Issue]
    Lang --> Scheme[Scheme/Compact Issue]

    Rust --> RustReq[Required Info]
    TS --> TSReq[Required Info]
    Scheme --> SchemeReq[Required Info]

    RustReq --> R1[cargo logs]
    RustReq --> R2[RUST_BACKTRACE=1]
    RustReq --> R3[rustc version]

    TSReq --> T1[package.json versions]
    TSReq --> T2[Full stack traces]
    TSReq --> T3[Node.js version]

    SchemeReq --> S1[Compiler output]
    SchemeReq --> S2[ZKIR dumps]
    SchemeReq --> S3[compactc version]

    style Issue fill:#e1f5ff
    style Rust fill:#daa520
    style TS fill:#3178c6
    style Scheme fill:#9b59b6
```

**Rust issues**: Require cargo logs, `RUST_BACKTRACE` output
**TypeScript issues**: Need package versions, stack traces
**Scheme/Compact issues**: Require compiler output, ZKIR dumps

### Network-Specific Issues

- Testnet vs Devnet behavior differences
- Partner chain sync issues with Cardano
- Consensus issues affecting validator nodes

### Performance & ZK-Specific

- Proof generation times
- Circuit constraint counts
- WASM performance in browsers
- Memory usage for large state trees

### Build Environment

```mermaid
graph LR
    A[Build Issue] --> B{Environment?}
    B --> C[Nix flake]
    B --> D[Docker]
    B --> E[Native]
    B --> F[Earthly]

    C --> G[Check flake.lock]
    D --> H[Check Dockerfile]
    E --> I[Check OS/toolchain]
    F --> J[Check Earthfile]

    style A fill:#e1f5ff
    style C fill:#7e7eb8
    style D fill:#2496ed
    style E fill:#f77f00
    style F fill:#06d6a0
```

- Nix flake issues vs native builds
- Docker build failures
- Cross-compilation for WASM targets
- Earthly build reproducibility

### Security Issues

**⚠️ CRITICAL**: Do NOT use public issue tracker for security issues!

```mermaid
graph TD
    A[Security Issue Discovered] --> B{Report Channel}
    B -->|Correct| C[Email: security@midnight.foundation]
    B -->|WRONG| D[Public GitHub Issue ❌]

    C --> E[Private Disclosure]
    E --> F[Team Investigation]
    F --> G[Patch Developed]
    G --> H[Responsible Disclosure]
    H --> I[Public Announcement]

    D --> X[⚠️ DO NOT USE ⚠️]

    style A fill:#e63946
    style C fill:#2a9d8f
    style D fill:#d62828
    style X fill:#d62828
    style E fill:#06d6a0
    style I fill:#d4edda
```

**Process**:
- Route privately via `security@midnight.foundation`
- Do NOT use public issue tracker
- Follow responsible disclosure process
- Reference `SECURITY.md` in all repos

---
