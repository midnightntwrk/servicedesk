---
title: "npm, yarn or Node fail while setting up a Midnight project"
when_to_use: "npm or yarn fails before any Midnight code runs: no package.json, a missing script, Windows paths under WSL, a Node engine warning, EACCES on a global install, or a project made from an archived repo or create-mn-app."
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-28"
last_reviewed: "2026-10-28"
error_strings:
  - "Could not read package.json"
  - "Missing script:"
  - "UNC paths are not supported"
  - "Defaulting to Windows directory"
  - "EPERM: operation not permitted"
  - "EBADENGINE"
  - "EBADDEVENGINES"
  - "EACCES: permission denied"
  - "command not found: yarn"
  - "yarn: command not found"
  - "However the current global version of Yarn is"
  - "Command 'nvm' not found"
  - "failed to resolve"
  - "EJSONPARSE"
  - "ENOSPC: no space left on device"
  - "This repository is archived and no longer maintained"
  - "DEPRECATED — migrate to Kapa + Midnight Expert"
review_when:
  - "The docs' Getting started gains a scaffolder command (an npx starter that replaces create-mn-app): point Remediation 2 at it"
  - "midnight-examples stops using Yarn through Corepack, or the docs stop recommending WSL on Windows: re-check Remediations 4 and 5"
---

# Runbook: npm, yarn or Node fail while setting up a Midnight project

npm or yarn stops before any Midnight code runs: a command from another project's guide, the wrong folder, Windows' npm inside WSL, the wrong Node, or a starter that is now archived. A read-only script checks for all of them.

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported** or **inferred** has none, so trust it less.

## Symptom

| If you see | Go to |
|---|---|
| `npm error enoent Could not read package.json` | Diagnose 1 |
| `npm error Missing script: "setup"` (or another name) | Diagnose 1, with `--script` |
| `UNC paths are not supported. Defaulting to Windows directory.`, then `EPERM: operation not permitted, mkdir 'C:\Windows\…'` | Diagnose 1 |
| `npm warn EBADENGINE Unsupported engine` or `npm warn EBADDEVENGINES` | Diagnose 1 |
| `EACCES: permission denied` from `npm install -g` or `corepack enable` | Diagnose 1 |
| `command not found: yarn` or `yarn: command not found` | Diagnose 1 |
| `This project's package.json defines "packageManager": "yarn@…". However the current global version of Yarn is …` | Diagnose 1 |
| `Command 'nvm' not found` | Remediation 3 |
| `npm error 404 Not Found - GET https://registry.npmjs.org/<name>`, or Bun's `error: <name>@* failed to resolve`, for a package in your own repo | Diagnose 1 |
| `npm error code EJSONPARSE` | Diagnose 1 |
| `ENOSPC: no space left on device` | Diagnose 1 |
| A repo's README starts `This repository is archived and no longer maintained` | Remediation 2 |
| midnight-mcp's npm page says `DEPRECATED — migrate to Kapa + Midnight Expert` | Remediation 6 |
| Only `npm error A complete log of this run can be found in: …` | Diagnose 2 |

### Not this runbook

- **A 404 for a nonexistent `@midnight-ntwrk/…` package, or nonexistent SDK functions:** the [AI-written SDK code runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/sdk-ai-generated-code-errors-runbook/sdk-ai-generated-code-errors-runbook.md).
- **The install works, then `Version mismatch` or `checkRuntimeVersion is not a function`:** the [toolchain version mismatch runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md).
- **`compact: command not found`, Docker not running, or port 6300 already in use:** the docs' [Troubleshoot installation problems](https://docs.midnight.network/troubleshoot/installation-problems).

## Root cause

1. **A command from one project's guide, run in another, or in no project at all.** Each starter has its own scripts: `npm run setup` is create-mn-app's, `npm run env:up` midnight-examples'. npm reads the package.json of the folder it runs in.
2. **Archived starters.** Midnight repos such as example-bboard and midnight-local-dev are archived. Each README says so, names the replacement (mostly midnight-examples), and rules out SDK updates. create-mn-app's README says the same, but its npm package still installs (**measured**).
3. **Windows' npm inside WSL.** WSL adds the Windows PATH to its own by default, so with no npm inside WSL, `npm` and `npx` are Windows' copies. They run under CMD, which can't use a `\\wsl.localhost` folder and falls back to `C:\Windows` (**inferred**). The docs don't support Windows natively and recommend WSL.
4. **The wrong Node or npm.** A project names its Node in `engines` and `.nvmrc`, and can name npm in `devEngines`. `EBADENGINE` and `EBADDEVENGINES` are only warnings: the install carries on and a later step fails (**reported**).
5. **Root-owned global folders.** `npm install -g` writes to npm's global folder, and `corepack enable` writes its yarn shim next to the `corepack` binary. When those belong to root, as with Node from apt (**reported**), both fail with EACCES. nvm installs Node under `~/.nvm`, which the user owns.
6. **midnight-mcp is retired.** Its npm description says so and names Kapa and Midnight Expert.

## Before you start

- **You need** Node 18.15 or newer and the script. No npm install.
- **Safety.** The script only reads: the project folder, `npm config get prefix`, and the GitHub API's archived flag (`--offline` skips that). It downloads to `/tmp`. Every Remediation changes only the user's machine: the user runs it, or you do with their consent. Don't use `sudo` with npm.

## Diagnose

1. **What's wrong in this project?** In the same shell as the failing command, in the project you're setting up (even for an `npm install -g` or `corepack enable` error):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/toolchain-project-setup-runbook/scripts/check-project-setup.mjs -o /tmp/check-project-setup.mjs
   node /tmp/check-project-setup.mjs .
   ```

   If npm said `Missing script: "<name>"`, add `--script <name>`. Exit 0: nothing found; 2: findings; 1: it couldn't run, and says why. Each `FINDING` names its Remediation or gives the fix on the line. Fix the first; rerun.
   - `node: command not found` inside WSL, or a `WSL FINDING`: Remediation 4, before anything else. Until then, other lines may describe Windows' tools.
   - `NVMRC NOTE`: Remediation 3 if the install or build still fails. `GLOBAL NOTE`: Remediation 5. `WSL NOTE`: Remediation 4's last step.
   - `ENGINES unread`: compare `node --version` with the range yourself. `REPO … could not check`: rerun later.
   - `RESULT nothing here explains…`, or every finding fixed and the command still fails: Diagnose 2.

2. **Which error did npm hit?** Read the log npm printed the path of:

   ```sh
   grep ' error ' <the log path npm printed>
   ```

   npm marks each error line with ` error ` (**measured**). Match the `code` line (`EACCES`, `ENOENT`, …) against the Symptom table. If nothing there matches, Stop and escalate.

## Remediation

1. **Run it in the project folder.** `cd` into the folder the `PROJECT` line names, if it's the project you meant, and run the command again. For a script that lives in a workspace, run it the way the `SCRIPT` line says.

   *Trade-off:* none.

2. **Use the commands of the project you have, or start from a maintained one.** `npm run` (or `yarn run`) in the project folder lists its scripts; a guide's command that isn't there was written for another project. Don't patch an archived repo or a create-mn-app project: the archived repo's README names its replacement. To start over, use the docs' [Hello world](https://docs.midnight.network/getting-started/hello-world) or the [midnight-examples learning path](https://github.com/midnightntwrk/midnight-examples#learning-path), and that README's commands.

   *Trade-off:* a project on an archived starter moves over by hand.

3. **Switch to the project's Node and npm.** With [nvm](https://github.com/nvm-sh/nvm#installing-and-updating) (`Command 'nvm' not found` means it isn't installed: install it, then open a new shell):

   ```sh
   nvm install    # reads the nearest .nvmrc
   nvm use
   node --version
   ```

   With no `.nvmrc`, add the version the `NODE` line or your guide names (the docs' Hello world: Prerequisites). For an `NPM` line, then `npm install -g npm@<the major it names>`. Then install again.

   *Trade-off:* new shells start with nvm's default, the first version it installed, until `nvm alias default <version>`.

4. **Use Node inside WSL, on the WSL file system.** In the WSL shell, install nvm and Node (Remediation 3), not Ubuntu's suggested `sudo apt install nodejs`, which leads to Remediation 5's EACCES. Open a new shell and check that `which node npm npx` prints no path under `/mnt/c/`. Keep projects under `~`, not `/mnt/c/`, and restart them there (Remediation 2).

   *Trade-off:* projects under `/mnt/c/` still run, but Microsoft recommends the WSL file system for speed.

5. **Yarn and global installs, without sudo.** Yarn comes from Corepack: run `corepack enable` once, open a new shell, and each project gets the Yarn it pins. Don't `npm install -g yarn` for these projects. A global Yarn 1 first on PATH (the `YARN` line names it) blocks a newer pinned Yarn: `corepack enable` replaces it, or point `--install-directory` at a folder earlier on PATH (**reported**). On EACCES from either, use Node from nvm (Remediation 3), which npm's docs call the best way to avoid these errors. To keep a system Node whose version suits the project instead:

   ```sh
   corepack enable --install-directory ~/.local/bin   # a folder already on your PATH
   ```

   For `npm install -g`, the docs' [Linux fix](https://docs.midnight.network/how-to/fix-package-repository-access-failures#platform-specific-fixes) sets npm's prefix to a folder in your home. Before moving to nvm later, run `npm config delete prefix`: nvm refuses a prefix. If `corepack` is missing, `npm install -g corepack` after that fix.

   *Trade-off:* global tools need reinstalling under nvm's Node.

6. **Replace midnight-mcp.** Remove it from the file the `MCP` line names and follow the [migration post](https://docs.midnight.network/blog/migrating-to-kapa-and-midnight-expert): Kapa's MCP server for docs search, and Midnight Expert.

   *Trade-off:* Midnight Expert is Claude Code plugins; other editors get Kapa alone.

## Confirm fixed

- Run in the project folder, the script exits 0, with no `GLOBAL NOTE` if the error was EACCES.
- The failing command runs, and the install ends without `EBADENGINE`, `EACCES` or `ENOSPC`.
- On WSL, `which node npm npx` prints no `/mnt/c/` path, and new projects live under `~`.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) if:

- Every finding is fixed, the command still fails, and the log's error matches no Symptom row.
- A maintained example, not archived, fails its own README steps on the Node its `.nvmrc` pins. Open it on [midnight-examples](https://github.com/midnightntwrk/midnight-examples/issues) too.
- A maintained guide (the docs, or a README that isn't archived) sends readers to an archived repo, or an archived repo's README names no replacement.
- A source in Key identifiers disagrees with its row and no step covers that.

Include the script's output, the failing command's `npm error` lines, and the OS (say if it's WSL). Remove any token or seed first.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). [check-runbook.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/authoring/check-runbook.mjs) tests every row daily against each source's newest version, or the npm version a row pins. For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| example-bboard is archived and names its replacement | `github:midnightntwrk/example-bboard/README.md` | `This repository is archived and no longer maintained.` `midnight-examples` `will not be updated for future SDK releases` |
| midnight-local-dev is archived | `github:midnightntwrk/midnight-local-dev/README.md` | `This repository is archived and no longer maintained.` |
| create-mn-app's README says it is archived | `github:midnightntwrk/create-mn-app/README.md` | `is no longer Midnight's project scaffolder` |
| create-mn-app projects have a setup script, and package.json says create-mn-app made them | `github:midnightntwrk/create-mn-app/templates/hello-world/package.json.template` | `"setup": "npx tsx src/setup.ts"` `created with create-mn-app` |
| midnight-examples: a learning path, Node through nvm, and a newer npm than Node 22's | `github:midnightntwrk/midnight-examples/README.md` | `## Learning path` `nvm use` `Node 22 bundles npm 10` |
| The docs' Hello world: Node and Yarn | `github:midnightntwrk/midnight-docs/docs/getting-started/hello-world.mdx` | `22 or 24` `corepack enable` `the project uses the Yarn version it pins` |
| The docs don't support Windows natively and recommend WSL | `github:midnightntwrk/midnight-docs/docs/getting-started/installation.mdx` | `Windows is not supported natively` `development through WSL is recommended` |
| The docs' Linux fix for global installs | `github:midnightntwrk/midnight-docs/docs/troubleshoot/fix-package-repository-access-failures.mdx` | `## Platform-specific fixes` `npm config set prefix` |
| Where corepack enable writes its shims | `npm:corepack/README.md` | `will create shims next` `--install-directory` |
| npm recommends a version manager for global EACCES | `github:npm/documentation/content/packages-and-modules/getting-packages-from-the-registry/resolving-eacces-permissions-errors-when-installing-packages-globally.mdx` | `This is the best way to avoid permissions issues.` |
| nvm reads the nearest .nvmrc and rejects an npm prefix | `github:nvm-sh/nvm/nvm.sh` | `nvm_find_up '.nvmrc'` `setting, which are incompatible with nvm.` |
| nvm's folder, and its default version | `github:nvm-sh/nvm/README.md` | `The script clones the nvm repository to` `New shells will start with the default version of node` |
| WSL adds the Windows PATH by default | `github:MicrosoftDocs/WSL/WSL/wsl-config.md` | `whether WSL will add Windows path elements to the` |
| Microsoft recommends the WSL file system | `github:MicrosoftDocs/WSL/WSL/filesystems.md` | `For the fastest performance speed, store your files in the WSL file system` |
| midnight-mcp is deprecated | `npm:midnight-mcp/package.json` | `DEPRECATED — migrate to Kapa + Midnight Expert` |
| The midnight-mcp migration post | `github:midnightntwrk/midnight-docs/blog/2026-06-25-migrating-to-kapa-and-midnight-expert.mdx` | `slug: migrating-to-kapa-and-midnight-expert` `It's a suite of [Claude Code]` |

## Reference material

- **Reports:** 66 questions about npm and Node put to the docs' AI assistant, August to October 2026 (not public).
- **Script:** [scripts/check-project-setup.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/toolchain-project-setup-runbook/scripts/check-project-setup.mjs) is the read-only check in Diagnose 1. [scripts/test-check-project-setup.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/toolchain-project-setup-runbook/scripts/test-check-project-setup.mjs) tests it offline.
