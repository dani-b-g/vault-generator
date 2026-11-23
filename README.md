# vault-generator

**English** | **[Español](README.es.md)**

**An Agent Skill that turns any codebase or documentation set into an indexed Obsidian knowledge vault — and lets AI agents retrieve only what a task needs.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js ≥ 22.18](https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933.svg)
![Agents: Claude Code · Codex](https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex-6f42c1.svg)
![Runtime dependencies: none to install](https://img.shields.io/badge/runtime%20deps-none%20to%20install-success.svg)

`vault-generator` follows the open [Agent Skills](https://agentskills.io/specification) format. You invoke it from
your coding agent (`/vault-generator` in Claude Code, `$vault-generator` in Codex). It analyses the projects,
packages, documentation and configuration in front of it, then builds an
[Obsidian](https://obsidian.md) vault. Every note cites its sources, carries a stable identifier and links to related
notes. The vault stays in sync as the code changes. Agents (and people) can then ask it focused questions instead of
reading the whole repository.

> **Status:** early release (`1.0.0`). The engine and its 51 automated tests run locally on Node.js. See
> [Limitations](#limitations) before relying on it for large or unusual codebases.

---

## Contents

- [Why](#why)
- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Using the skill](#using-the-skill)
- [Installation](#installation)
- [Example](#example)
- [How it works](#how-it-works)
- [What it guarantees](#what-it-guarantees)
- [Security and privacy](#security-and-privacy)
- [Supported sources](#supported-sources)
- [Reference](#reference)
- [Configuration](#configuration)
- [Extending](#extending)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Why

Coding agents work best with the right context and worst with too much of it. In a real repository, the knowledge an
agent needs is scattered across READMEs, generated API docs, OpenAPI specs, manifests, decision records and the code
itself. Pasting all of it into a prompt is expensive and noisy. Leaving it out leads to invented APIs.

`vault-generator` builds that knowledge base once, keeps it current, and answers with **cited fragments within a
token budget**. It also states plainly when the vault does not know something.

## What it does

- **Understands the workspace before touching it.** It works out whether it is looking at a single project, a
  monorepo, several repositories, a documentation site or an existing vault. It identifies projects and packages from
  their manifests (not folder names), builds the internal dependency graph, and notices when you are inside a larger
  workspace.
- **Generates an Obsidian vault whose structure comes from the sources.** The layout is flat, by category or by
  project, depending on what was found. Notes carry YAML properties, wikilinks, tags, aliases, maps of content, Mermaid
  diagrams and attachments.
- **Keeps provenance and evidence.** Every note lists the files it came from (with content hashes). Every relation
  between projects, modules, APIs and documents carries the evidence behind it, and inferred relations are never
  presented as facts.
- **Syncs incrementally without overwriting your work.** Only changed sources are reprocessed. Your edits are kept or
  merged, conflicts are saved aside instead of resolved silently, and every run can be undone.
- **Retrieves selectively.** A local SQLite full-text index over sections, symbols, API operations and relations
  powers `search` and task-specific `context` packages for agents.
- **Transforms and exports.** It converts HTML to Markdown, OpenAPI to an API reference, code to an API reference and
  Obsidian notes to CommonMark. It exports the vault as a static site, a single Markdown bundle, an agent context
  package or a brand-new Agent Skill.
- **Generates grounded examples.** Code examples and small demo apps only use APIs documented in the vault, and they
  are never reported as validated unless they were actually run.
- **Asks instead of guessing.** Scope, destination, contradictory documentation, the default version, restricted
  content and example requirements are all asked about. Answers are remembered.

## Quick start

**Requirements:** Node.js **22.18 or newer**, plus [Claude Code](https://code.claude.com) and/or the
[Codex CLI](https://developers.openai.com/codex). Nothing else needs to be installed: the two small parsers the
engine uses are bundled.

**In Claude Code**, install it as a plugin (one command, no clone):

```text
/plugin install vault-generator --marketplace dani-b-g/vault-generator
```

**In Codex, or to commit the skill with your project**, use the installer:

```sh
git clone https://github.com/dani-b-g/vault-generator.git
cd vault-generator

# install the skill into the project you want to document (for Claude Code and Codex)
node skills/vault-generator/scripts/install.ts --target /path/to/your/project --agent both
```

Then, in the project you want to document:

```text
/vault-generator          ← Claude Code
$vault-generator          ← Codex
```

With no arguments the skill analyses the directory, shows you what it found and the evidence for it, asks what it
cannot determine, previews the notes it would create, and generates the vault (by default in `knowledge-vault/`) once
you agree.

To make the skill available in every project instead, use `--global`. It installs into `~/.claude/skills` and
`~/.agents/skills`. [Installation](#installation) covers every option. The next section, [Using the skill](#using-the-skill),
lists every operation you can run.

## Using the skill

`vault-generator` is one skill with one entry point. There are no separate sub-skills to install or call. What you can
run are its **operations** (the engine calls them *modes*): sixteen of them, from `analyze` to `export`. The agent picks
the right operation from your request and asks you for anything it cannot decide.

### Three ways to ask

| Style | Example | What happens |
| --- | --- | --- |
| No arguments | `/vault-generator` | Analyses the directory (or reports what changed, if a vault already exists), asks what it cannot decide, previews the notes and generates once you agree |
| Natural language, English or Spanish | `/vault-generator where is the session token validated?` | The agent maps the request to an operation |
| Explicit operation | `$vault-generator --mode search "retry policy" --project @acme/http` | Your flags are passed to the engine as given |

In the commands below, `vg` stands for `node <skill-dir>/scripts/vg.mjs`, the engine the agent runs for you.
`<skill-dir>` is `.claude/skills/vault-generator` (or `.agents/skills/vault-generator`) after a project installation.
You can run `vg` yourself too. [Running the engine yourself](#running-the-engine-yourself) covers the output format
and exit codes.

### Operations

| Group | Operation | Purpose | Writes files |
| --- | --- | --- | --- |
| Build and maintain | `analyze` | Detect the context (single project, monorepo, several repositories, docs site, existing vault) and propose a strategy | no |
| | `generate` | Build the vault from the selected sources | yes |
| | `sync` | Incremental update after the sources change | yes |
| | `status` | What changed since the last run: sources, hand-edited notes, open conflicts | no |
| Find knowledge | `search` | Selective retrieval, with filters | no |
| | `context` | Task-specific context package for an agent, within a token budget | no (unless `--output`) |
| Check and repair | `validate` | Check structure, metadata, identifiers, links and the index | no |
| | `reorganize` | Evaluate the vault structure; `--apply` moves notes (with backups) | only with `--apply` |
| | `conflicts` | List sync conflicts and resolve them | only with `--resolve` |
| | `restore` | List backups and undo a run | only with `--run` |
| | `index` | Update or rebuild the search index | yes (the index) |
| Convert and export | `transform` | Convert files between formats | yes |
| | `export` | Static site, Markdown bundle, agent context or a new Agent Skill | yes |
| | `examples` | Code examples and demo apps grounded in documented APIs | yes, outside the vault |
| Inspect the installation | `capabilities` | Analyzers, transformers and formats actually installed | no |
| | `validate-skill` | Check an Agent Skill directory against the specification | no |

With no operation given, `vg` runs `status` when it finds a managed vault and `analyze` otherwise. `vg sync` works as
well as `vg --mode sync`.

### Build and maintain

```text
/vault-generator analyze this repository
/vault-generator generate a vault only for packages/core and its dependencies
/vault-generator sync the vault, I changed the API
/vault-generator what changed since the last run?
$vault-generator sincroniza el vault
```

```sh
vg --mode analyze                                            # read-only: what is here and what would be asked
vg --mode generate --dry-run                                 # preview the notes, write nothing
vg --mode generate --answer destination=default              # write the vault (first run asks where to put it)
vg --mode status                                             # sources added, modified or removed since the last run
vg --mode sync                                               # bring the vault up to date
```

| Operation | Options | Notes |
| --- | --- | --- |
| `generate` | `--source`, `--scope`, `--vault`, `--depth`, `--language`, `--dry-run`, `--answer` | Blocking questions stop the run before anything is written. The first run asks where to create the vault (default `knowledge-vault/`) |
| `sync` | `--on-conflict save-both\|keep-mine\|take-source` (default `save-both`), `--prune-stale`, `--trust-plugins` | Reports counts, conflicts, API contract changes and structural changes. Notes whose source disappeared are flagged stale; `--prune-stale` moves them to `.vault-generator/trash/` |
| `analyze`, `status` | | Read-only. Without a vault, `status` falls back to `analyze` |

Common scopes:

```sh
vg --mode generate                                           # the whole project or monorepo
vg --mode generate --scope packages/core                     # part of a monorepo (+ its internal dependencies)
vg --mode generate --source ../frontend --source ../backend  # several repositories in one vault
vg --mode generate --source ./docs-site                      # documentation only
vg --mode generate --source ../project --vault ~/MyVault     # into an existing Obsidian vault
```

### Find knowledge

```text
/vault-generator where is the session token validated?
/vault-generator prepare context to add pagination to the /orders endpoint
```

```sh
vg --mode search "retry policy" --project @acme/http --type document --limit 5
vg --mode search --note "api-client" --section "Public API"            # read one section of one note
vg --mode context "add pagination to the /orders endpoint" --budget 3000
vg --mode context "add pagination to the /orders endpoint" --output context/orders   # also writes orders.md and .json
```

| Operation | Options |
| --- | --- |
| `search` | `--project`, `--type project\|module\|api\|document\|decision\|example\|operations\|moc`, `--tech`, `--version` (`any` searches every version), `--tag`, `--status`, `--limit` (default 8). `--note <path or title>` with `--section <heading>` reads one section |
| `context` | `--project`, `--version`, `--budget` in tokens (default 6000), `--limit` notes (default 8), `--format markdown\|json`, `--output <file>` |

Prefer `context` when you are about to implement, fix, test or migrate something. It returns cited fragments within the
budget, related notes, constraints and explicit uncertainties. `search` is for looking something up. Every hit says
which note and lines it came from, its sources and how confident the match is. When nothing matches, `search` exits
with code `3`: the vault does not cover it, so look at the source code.

### Check and repair

```sh
vg --mode validate                                           # errors fail with exit code 2
vg --mode validate --check-sources                           # also check that every cited source file still exists
vg --mode reorganize                                         # proposal only: orphans, oversized folders, ambiguous names
vg --mode reorganize --apply --answer reorganize-confirm=yes # apply the moves (backed up, links rewritten)
vg --mode conflicts                                          # open conflicts, with a diff of both versions
vg --mode conflicts --resolve <conflict-id> --take mine      # or source, or merged (you removed the markers by hand)
vg --mode restore                                            # list backup runs
vg --mode restore --run <runId> --dry-run                    # preview undoing a run; drop --dry-run to do it
vg --mode index --rebuild                                    # recreate the search index (also works on any Obsidian vault)
```

`validate` errors mean broken metadata, identifiers, markers or links, or a leaked secret or private path. Fix them
by running `sync` or `index`, not by editing the generated blocks. `reorganize --apply` and `restore` are themselves
backed up, so both can be undone.

### Convert and export

```text
/vault-generator export the vault as an HTML site
/vault-generator export a skill with the orders documentation
```

`transform` converts files that are not in the vault. The transformer is inferred from the input unless you name one
with `--transformer`:

| Input | Transformer | Result |
| --- | --- | --- |
| `.html` file, or a folder of HTML (including generated docs sites) | `html-to-markdown` | Markdown without the navigation chrome |
| OpenAPI or Swagger `.json` / `.yaml` | `openapi-to-markdown` | An API reference |
| Source code file or folder | `code-to-markdown` | An API reference of the public surface |
| Obsidian `.md` note | `obsidian-to-commonmark` | Portable CommonMark (wikilinks and callouts converted) |

```sh
vg --mode transform --input docs-site/ --output docs-md
vg --mode transform --input openapi.yaml
vg --mode transform --input note.md --transformer obsidian-to-commonmark
```

`export` turns the vault itself into something else:

| `--to` | Creates | Default location | Extra options |
| --- | --- | --- | --- |
| `html` | A static site with resolved links and a title search | `<vault>/.vault-generator/exports/site/` | `--project`, `--type`, `--tag` |
| `bundle` | One portable Markdown file | `<vault>/.vault-generator/exports/bundle.md` | `--project`, `--type`, `--tag` |
| `context` | A task-specific context package (Markdown and JSON) | `<vault>/.vault-generator/exports/context-<task>.md` and `.json` | `--task "<goal>"`, `--budget`, `--project`, `--type`, `--version` |
| `skill` | A new Agent Skill (`SKILL.md` plus one reference file per note) | `./<name>/` | `--name <skill-name>` (required; lowercase letters, digits and single hyphens), `--project`, `--type`, `--tag` |

```sh
vg --mode export --to html
vg --mode export --to bundle --output out/vault.md
vg --mode export --to context --task "add pagination to /orders" --output out/orders-context
vg --mode export --to skill --name orders-kb --project @acme/orders
```

Every `transform` and `export` reports its validations and anything lost in the conversion. `transform`,
`export --to bundle`, `export --to skill` and `examples` refuse to overwrite an existing output unless you pass
`--force`. `export --to html` and `export --to context` refresh the output they created earlier, and `html` refuses a
folder it did not create. Restricted notes are left out unless you pass `--include-restricted`.

`examples` writes code that only uses APIs documented in the vault:

```sh
vg --mode examples --project @acme/http --goal "retry a failed request" --kind snippet
vg --mode examples --project @acme/http --goal "paginate orders" --kind app --validate
```

| Option | Meaning |
| --- | --- |
| `--project`, `--goal`, `--kind snippet\|app` | What to build. Anything missing comes back as a question |
| `--output <dir>` | Where to write it (default `examples/<project>-<goal>`, outside the vault) |
| `--validate` | For a Node.js app, run `npm install` and start it. Without it only a syntax check runs |
| `--force` | Overwrite an existing example |

An example is never reported as validated unless its checks ran and passed.

### Inspect the installation

```sh
vg --mode capabilities                                       # analyzers, transformers, formats, plugins, search index
vg --mode validate-skill --skill-dir .claude/skills/vault-generator
```

### Options shared by every operation

| Option | Meaning |
| --- | --- |
| `--source <path>` | Source directory or file. Repeatable or comma separated. Default: the current directory, or the sources stored in the vault |
| `--scope <project>` | Limit to projects (id, name, path or glob). Internal dependencies are added automatically; `--answer scope-deps=exclude` keeps them as overview only |
| `--vault <dir>` | Vault directory. Default: the managed vault in or below the current directory, otherwise `<source>/knowledge-vault` |
| `--answer <id>=<value>` | Answer a question from a previous run. Repeatable. Stored in the vault, never asked again |
| `--depth shallow\|standard\|deep` | How much code detail goes into the notes (25, 80 or 400 symbols per module) |
| `--language en\|es` | Language of generated headings and labels (detected from the READMEs when not set) |
| `--dry-run` | Compute everything, write nothing, report the plan |
| `--include-restricted` | Include restricted notes in search, context and export. Use it only on purpose |
| `--config <file>`, `--cwd <dir>` | A configuration file; run as if from another directory |
| `--json`, `--verbose` | Machine-readable output; more detail (and stack traces on errors) |

### Questions the skill asks

When a decision changes the result and the sources cannot settle it, the engine returns a question instead of
guessing. A blocking question stops the run before anything is written (exit code `10`). Answer it in the chat, or add
`--answer <id>=<value>` and run the same command again. Optional questions do not block: they are mentioned in the
summary and can be answered on the next `sync`.

| Question | When | Options |
| --- | --- | --- |
| `destination` | The first `generate` | `default` (the proposed path) or any path |
| `vault-placement` | The destination already holds notes not created by this tool | `subfolder`, `root`, `cancel` |
| `scope` | More than 12 projects, or several unrelated ones with no workspace tool | `all`, or project ids |
| `restricted-docs` | Documents look private | `exclude`, `restricted`, `public` |
| `reorganize-confirm` | `reorganize --apply` has moves to make | `yes`, `no` |

Contradictions between sources, relations inferred from patterns and the default documentation version are optional
questions. [questions.md](skills/vault-generator/references/questions.md) lists every question and what each answer
does.

### Typical workflows

```sh
# First time
vg --mode analyze                                  # what is here?
vg --mode generate --dry-run                       # what would be written?
vg --mode generate --answer destination=default    # write it
vg --mode validate

# After changing code or docs
vg --mode status
vg --mode sync

# Before working on a task
vg --mode context "add a getProduct function to the api client" --budget 1200

# Share it
vg --mode export --to html
```

### Running the engine yourself

`vg` takes `--mode <operation>` (or the operation as the first word) and, optionally, a request in plain words. With
`--json` every call returns the same envelope, which is what the agent reads:

```json
{ "ok": true, "mode": "generate", "status": "done", "summary": "...", "data": {}, "questions": [], "warnings": [], "next": [] }
```

`status` is `done`, `needs_input`, `dry_run` or `error`, and `next` suggests the follow-up command.

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Error, such as an unknown mode, a bad option or an output that already exists |
| `2` | `validate` found errors |
| `3` | Nothing found (`search`) |
| `4` | Note or section not found (`search --note`) |
| `10` | Needs input: read `questions` and answer with `--answer` |

Without `--mode`, `vg "where is the retry policy documented?"` picks an operation from keywords in English or Spanish
(`sincroniza` runs `sync`, a question runs `search`) and says which one it chose in `warnings`. Agents choose the
operation themselves, so use `--mode` in scripts. The complete option reference is
[operations.md](skills/vault-generator/references/operations.md).

## Installation

There are two ways to install it: as a **Claude Code plugin** (one command, Claude Code only), or with the
**installer**, which copies the skill into your project or home directory for Claude Code and Codex. Steps 1 to 4 below
cover the installer; step 1 (the requirements) applies to both.

### Install as a Claude Code plugin

This repository is also a Claude Code plugin marketplace, so Claude Code can fetch, install and update the skill by
itself: no clone and no installer. It still needs Node.js 22.18 or newer.

```text
/plugin install vault-generator --marketplace dani-b-g/vault-generator
```

Claude Code asks you to confirm the marketplace, then lets you choose a scope: just you in every project (`user`),
everyone who works in a repository (`project`) or just you in one repository (`local`). From a shell, without starting
a session (Claude Code 2.1.292 or later):

```sh
claude plugin install vault-generator --marketplace dani-b-g/vault-generator
```

On older versions, add the marketplace first and then install:

```text
/plugin marketplace add dani-b-g/vault-generator
/plugin install vault-generator@vault-generator
```

Check it:

```sh
claude plugin list                    # vault-generator@vault-generator, Status: enabled
claude plugin details vault-generator
```

The skill answers to `/vault-generator` and to `/vault-generator:vault-generator`. If it does not appear, run
`/reload-plugins` or restart Claude Code, and look at the **Errors** tab of `/plugin`.

How it differs from the installer:

- **Claude Code only.** The plugin is for Claude Code. For Codex, use the installer.
- **Managed by Claude Code.** The copy lives under `~/.claude/plugins/`; do not edit it. With user scope nothing is
  added to your project. To give a team the skill, either install with `--scope project` (every teammate still runs the
  install once) or use the installer and commit `.claude/skills/`.
- **Updates.** Claude Code does not auto-update third-party marketplaces unless you turn it on (`/plugin`, then
  **Marketplaces**). Update by hand with `claude plugin update vault-generator@vault-generator`. The plugin version
  follows the commits of this repository.
- **Uninstall.** `claude plugin uninstall vault-generator@vault-generator`. Add
  `claude plugin marketplace remove vault-generator` to drop the marketplace as well.

### 1. Check the requirements

```sh
node --version     # must print v22.18.0 or newer
```

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | 22.18 or newer | Runs the TypeScript engine directly and provides the built-in SQLite search index |
| Claude Code and/or Codex CLI | current | To invoke the skill from an agent (`/vault-generator`, `$vault-generator`) |
| Git | any | Only to clone this repository; any download of the files works too |
| Python 3 | optional | Only to syntax-check generated Python examples |

There is no `npm install` step. Everything the skill needs at runtime is in `skills/vault-generator/`, including the
two bundled parsers. No environment variables or accounts are needed.

### 2. Get the skill

```sh
git clone https://github.com/dani-b-g/vault-generator.git
cd vault-generator
```

### 3. Install it

The installer copies `skills/vault-generator/` into the directories each agent scans for skills:

| Scope | Command | Claude Code location | Codex location |
| --- | --- | --- | --- |
| One project | `node skills/vault-generator/scripts/install.ts --target /path/to/project` | `<project>/.claude/skills/vault-generator/` | `<project>/.agents/skills/vault-generator/` |
| All your projects | `node skills/vault-generator/scripts/install.ts --global` | `~/.claude/skills/vault-generator/` | `~/.agents/skills/vault-generator/` |

Both agents are installed by default. Add `--agent claude` or `--agent codex` to install only one. On Windows,
PowerShell and Command Prompt use the same commands, with Windows paths such as `--target C:\work\my-project`.

Example output:

```text
✔ claude-code: installed /path/to/project/.claude/skills/vault-generator
✔ codex: installed /path/to/project/.agents/skills/vault-generator

Invoke with /vault-generator in Claude Code and $vault-generator in Codex (restart the agent if the skill does not appear).
```

**Project or global?** Install into a project when you want the whole team to get the skill: commit the
`.claude/skills/` and `.agents/skills/` folders with the project. Install globally when you want it available in
every repository on your machine, for yourself only.

**Manual installation** also works, because the skill is a self-contained folder. Copy `skills/vault-generator/` to one
of the locations above, keeping the folder name `vault-generator`.

### 4. Check that it works

```sh
# the engine runs on its own (no agent needed)
node /path/to/project/.claude/skills/vault-generator/scripts/vg.mjs --mode capabilities

# the installed copy is a valid Agent Skill
node /path/to/project/.claude/skills/vault-generator/scripts/vg.mjs --mode validate-skill \
  --skill-dir /path/to/project/.claude/skills/vault-generator
```

`capabilities` must report `search index available (SQLite FTS5)`. If it does not, your Node.js is too old.

Then open the project in your agent:

| Agent | Check | Invoke |
| --- | --- | --- |
| Claude Code | Type `/` and look for `vault-generator` in the list | `/vault-generator` |
| Codex | Run `/skills` and look for `vault-generator` | `$vault-generator` |

Claude Code picks up new skills while it is running. If the skill does not show up, restart the agent; Codex also
recommends a restart after installing a skill.

### Updating

Pull the latest version and run the same install command again:

```sh
git pull
node skills/vault-generator/scripts/install.ts --target /path/to/project
```

The installer is safe to repeat:

- An identical copy is left alone (`up-to-date`).
- A copy installed by an earlier version is replaced (`updated`).
- A copy you edited by hand, or a different skill that is also called `vault-generator`, is **not** replaced. The
  installer stops and reports `refused`. Add `--force` to replace it; a backup is saved first in
  `.vault-generator-install-backups/` (in the project, or in your home directory with `--global`).
- `--dry-run` shows what would happen without writing anything.

Updating the skill never touches the vaults you have generated. Run `sync` afterwards if you want existing vaults to
pick up improvements in the analyzers.

### Uninstalling

```sh
node skills/vault-generator/scripts/install.ts --target /path/to/project --uninstall
node skills/vault-generator/scripts/install.ts --global --uninstall
```

Only copies created by the installer are removed; anything else needs `--force`. Generated vaults are not deleted.
They are plain Markdown folders that you own.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| `vault-generator requires Node.js >= 22.18` | Upgrade Node.js (for example with `nvm install 22` or the installer from nodejs.org) |
| The skill does not appear in the agent | Restart the agent, check that the folder is called exactly `vault-generator` and contains `SKILL.md`, and that you opened the project the skill was installed into |
| `refused: installed copy was modified locally` | Your copy differs from the one being installed. Keep it, or re-run with `--force` (a backup is kept) |
| The agent asks for permission every time it runs the engine | Expected the first time. Allow `node … vg.mjs` in your agent's permission settings if you trust it |
| `search index UNAVAILABLE` in `capabilities` | Your Node.js build lacks `node:sqlite` with FTS5. Use an official Node.js 22.18+ build |
| The skill does not appear after a plugin install | Run `/reload-plugins` or restart Claude Code, then check `claude plugin list` and the **Errors** tab of `/plugin` |
| The one-step plugin install does not work | It needs Claude Code 2.1.292+ in a shell, or 2.1.275+ inside a session. Update Claude Code, or add the marketplace first and install in two steps |

## Example

Take a small pnpm monorepo with a Next.js app, a Fastify API and three shared packages. The first run asks before
writing anything:

```text
$ vg --mode generate
? [generate] Input needed before writing anything (1 blocking question(s)).

Questions (answer to continue):
  • [destination] (blocking) Where should the vault be created? Proposed: knowledge-vault
      why: Writing a new directory is a decision only you can make. Answer "default" to accept the proposal or give a path.
```

After the answer it generates one note per project, a home note with the dependency graph, a technologies index and an
*Open questions* note. This is the note for the shared API client, unedited:

````markdown
---
title: "@shop/api-client"
type: project
version: 0.2.0
tags: [kind/library, project/shop-api-client, tech/typescript, type/project]
belongs_to: ["[[shop]]"]
depends_on: ["[[shop-models]]"]
used_by: ["[[shop-web]]"]
symbols: [getProducts]
vg:
  id: vg-5d5aaa84ae
  origin: generated
  confidence: verified
  sources: ["shop:packages/api-client/package.json@b63a1f77c3e8"]
---
<!-- vg:begin -->
# @shop/api-client

**Kind:** library · **Ecosystem:** node · **Version:** `0.2.0` · **Path:** `packages/api-client`

## Purpose

*No description is declared in the sources.*

## Workspace dependencies

- [[shop-models]] — packages/api-client/package.json declares @shop/models (workspace:*) [prod]

## Public API

#### getProducts · function

```ts
async function getProducts(): Promise<Product[]>
```

Fetch all products from the API.

*Defined in* `packages/api-client/src/index.ts:4`

## Possible relations (unverified)

> [!question] These relations were derived from patterns (names, URLs, routes). They are not stated by any source; confirm or reject them before relying on them.

- [[shop-api-client]] **consumes** [[shop-api]] — literal "http://localhost:4000/products" matches route GET /products declared in apps/api/src/main.ts:5
<!-- vg:end -->

<!-- Add your own notes below this line. vault-generator never modifies content outside the vg:begin / vg:end block. -->
````

(Frontmatter shortened for the README.) A few things to notice:

- The missing description is stated, not invented.
- The `depends_on` relation is verified, because a manifest declares it.
- The client → API relation is only a pattern match, so it is listed as *possible* and the user is asked to confirm it.
- Anything written below the last line is never touched by a later sync.

An agent preparing to change this code asks for a context package instead of reading the repository:

```text
$ vg --mode context "add a getProduct function to the api client" --budget 1200
# Context package: add a getProduct function to the api client
> 6 fragment(s) · ~330/1200 tokens. Every fragment cites its note and original source.

## Uncertainties
- Some relations shown are inferred (unverified).

## Relevant knowledge
### @shop/api-client › Public API › getProducts · function
*Note:* `shop-api-client.md` lines 64–79 · *confidence:* high
*Sources:* `shop:packages/api-client/package.json@b63a1f77c3e8`
...
```

## How it works

```text
sources ─► context detection ─► safe scan ─► analyzers ─► knowledge model ─► adaptive planner
                                                                                    │
            search / context ◄── SQLite FTS5 index ◄── non-destructive reconciliation ◄┘
```

1. **Context detection** reads evidence: workspace files (npm, pnpm, Yarn, Nx, Turborepo, Lerna, Rush, Go
   workspaces, Cargo, Maven, Gradle, .NET solutions, uv, Deno, git submodules), manifests, git repositories,
   documentation trees and existing vaults. The result has a confidence score and a list of ambiguities.
2. **Scanning** honours `.gitignore`, skips dependency and build directories, never reads secret files, and flags
   documents that look private.
3. **Analyzers** extract documents (Markdown, MDX, HTML, generated doc sites, plain text, Mermaid), API contracts
   (OpenAPI 3 / Swagger 2), the public surface of the code (exported symbols, signatures, doc comments, HTTP
   routes, imports) and operational configuration (Docker, Compose, Kubernetes, CI workflows, Terraform, env
   templates, Makefiles).
4. **The knowledge model** joins all of this into projects, modules, documents, APIs, decisions and examples, linked
   by `belongs-to`, `depends-on`, `implements`, `exposes`, `consumes`, `documents`, `exemplifies`, `supersedes` and
   more. Each relation is `verified` (declared by a source), `inferred` (pattern match) or `confirmed` (by you). The
   model also detects contradictions between sources, such as different runtime versions or documented scripts that
   do not exist.
5. **The planner** decides the vault layout from what was found. It merges small projects into one note, splits
   oversized documents by heading and de-duplicates identical documents. Index notes are only created when they carry
   value.
6. **Reconciliation** writes the plan without destroying anything (see below), then **indexes** the vault in a local
   SQLite FTS5 database.

The skill's `SKILL.md` is short. The agent loads the detailed procedures from `references/` only when a task needs
them, following the Agent Skills progressive-disclosure model.

## What it guarantees

- **Evidence only.** Notes state what the sources show and cite them. Unknowns are written as unknowns.
- **Your content is yours.** Generated content lives between `<!-- vg:begin -->` and `<!-- vg:end -->`. Text outside
  that block is never modified. Edits inside it are merged with new source content (three-way merge) or recorded as a
  conflict with both versions kept. Properties you add to a note survive syncs.
- **Stable identity.** Every note has a stable `vg.id`. Renaming or moving a note, or renaming a source file whose
  content did not change, keeps its identity and its links.
- **Nothing is deleted.** Notes whose source disappeared are marked stale, not removed. Every run that changes files
  stores backups and a journal, and `restore` undoes it.
- **Idempotent and reproducible.** Running again with no changes writes nothing. The same sources and configuration
  produce the same notes.
- **Asks before deciding for you.** Blocking questions stop a run before anything is written. Answers are stored in
  the manifest and not asked again.

## Security and privacy

The scripts enforce these rules for their own reads and writes. They are code paths covered by tests, not
conventions:

- Writes only go to authorised directories (the vault and the output paths you name), never into `.git/` or
  `node_modules/`.
- Path traversal is rejected, and symbolic links are followed only when they stay inside the source.
- Secret files (`.env`, private keys, credentials, cloud configs, Terraform state) are never read. Secret-looking
  values in other files (tokens, keys, passwords, credentials in URLs) are redacted before they reach a note, the
  index or an export. `validate` fails if one slips through.
- Documents that look private need an explicit decision. Restricted notes are hidden from search, context and
  exports unless you ask for them.
- Text inside documents is treated as data. Content that looks like instructions to an AI agent is flagged in the
  vault, and the skill tells the agent never to follow it.
- The manifest and state store relative paths only, never absolute paths or file contents. Plugins run only after you
  explicitly trust them.
- Everything runs locally. The engine makes no network requests. The only exceptions are explicit opt-ins:
  `examples --validate` runs `npm install` / `npm start` for a generated example, and an exported HTML site loads
  Mermaid from a CDN in the reader's browser to draw diagrams.

The skill cannot restrict the other tools your agent has. Configure your agent's own permissions as well (Claude Code
`permissions.deny`, Codex `sandbox_mode` / `approval_policy`). See
[references/security.md](skills/vault-generator/references/security.md).

## Supported sources

| Kind | Supported |
| --- | --- |
| Documentation | Markdown, MDX (components become placeholders), HTML, plain text, Mermaid. reStructuredText and AsciiDoc are imported as text |
| Generated docs | TypeDoc, Compodoc, Javadoc, Sphinx, MkDocs and Docusaurus builds (navigation chrome removed) |
| API contracts | OpenAPI 3.x and Swagger 2.0 in JSON or YAML, with contract-change detection |
| Code (public surface) | TypeScript/JavaScript (incl. JSX, Vue, Svelte, Astro), Python, Go, Java, Kotlin, Scala, C#, Rust, Swift, PHP, Dart, C/C++ |
| Ecosystems | Node.js, Python, Go, Rust, JVM (Maven/Gradle), .NET, PHP, Ruby, Dart/Flutter, Elixir, Deno |
| Configuration | Dockerfile, Docker Compose, Kubernetes, GitHub Actions, GitLab CI, Terraform, Helm, env templates, Makefile/justfile, runtime version files |
| Vaults | Existing Obsidian vaults, with or without notes created by this tool |

Run `vg --mode capabilities` to see exactly what your installation supports, including what is not implemented.

## Reference

Detailed documentation lives with the skill and is what the agent reads:

| Document | Contents |
| --- | --- |
| [SKILL.md](skills/vault-generator/SKILL.md) | The instructions agents follow: activation, operation selection, questions, security |
| [operations.md](skills/vault-generator/references/operations.md) | Every mode and option of the CLI, exit codes, configuration keys |
| [questions.md](skills/vault-generator/references/questions.md) | Every question the skill can ask, when, and what each answer does |
| [vault-format.md](skills/vault-generator/references/vault-format.md) | Note anatomy, identifiers, links, layout rules, the `.vault-generator/` directory |
| [sync-and-conflicts.md](skills/vault-generator/references/sync-and-conflicts.md) | Change detection, merge rules, conflict resolution, recovery |
| [retrieval.md](skills/vault-generator/references/retrieval.md) | The index, search ranking and context packages |
| [security.md](skills/vault-generator/references/security.md) | Enforced controls and what you must configure in your agent |
| [examples.md](skills/vault-generator/references/examples.md) | How grounded examples and demo apps are produced and validated |
| [extending.md](skills/vault-generator/references/extending.md) | Writing analyzer and transformer plugins |

## Configuration

Configuration is optional. Add `vault-generator.config.json` at the root of a project to set defaults:

```json
{
  "sources": ["."],
  "vault": "knowledge-vault",
  "language": "en",
  "depth": "standard",
  "exclude": ["**/fixtures/**", "legacy/**"],
  "access": { "deny": ["secrets/**"], "restricted": ["docs/internal/**"] },
  "plugins": []
}
```

The main keys are the default sources, vault and scope; the language of generated notes (`en` or `es`, detected
automatically otherwise); the code detail level (`shallow`, `standard` or `deep`); include and exclude rules; and access
rules. A complete example with every key is in
[assets/vault-generator.config.example.json](skills/vault-generator/assets/vault-generator.config.example.json), and
each key is described in [operations.md](skills/vault-generator/references/operations.md#configuration-file). No
environment variables are used.

## Extending

New formats and output types are added as local plugins without changing the core:

```js
// vault-plugins/asciidoc.mjs — listed in "plugins" in the config
export default {
  analyzers: [{
    id: 'asciidoc', version: '1', description: 'AsciiDoc documents', handles: ['.adoc'],
    limitations: ['Tables and includes are not converted'],
    match: (file) => (file.ext === '.adoc' ? 30 : 0),
    analyze(file, ctx) { /* return documents, entities, relations and facts */ },
  }],
  transformers: [],
};
```

Every analyzer and transformer declares what it handles and what it cannot preserve, and `capabilities` reports both.
Plugins are loaded only after you review them and run once with `--trust-plugins`. Their content hash is pinned, so a
modified plugin has to be trusted again. See [extending.md](skills/vault-generator/references/extending.md) for the
full contract.

## Limitations

- **PDF, Word and PowerPoint files are not converted.** They are listed as unsupported in the vault, never silently
  dropped.
- **Retrieval is lexical** (BM25 ranking, symbol and operation matching, relation expansion). There are no embeddings
  or semantic search.
- **Code analysis is heuristic, not a compiler.** Complex generics, macros, overloads and re-export chains may be
  summarised or missed. Runtime behaviour is never inferred.
- **Relations between applications** that do not share a declared contract are only detected by pattern matching
  (for example a URL in one project matching a route in another). They stay "possible" until you confirm them.
- **External OpenAPI `$ref` files and remote sources** are not fetched.
- **Example scaffolding** supports Node.js and Python projects only.
- **Tested on** Node.js 24 on Windows with the automated suite. End-to-end invocation from inside Claude Code and
  Codex has not yet been covered by automated tests.

## Roadmap

- Optional PDF and DOCX extractors as plugins with declared dependencies.
- Optional local embeddings for hybrid search.
- Compiler-backed analyzers (TypeScript compiler API, Roslyn, `go/ast`) as plugins.
- Service relations from generated clients, message queues and event schemas.
- Example scaffolding for Go, JVM and .NET.
- Batched synchronisation for very large vaults.

## Development

```text
skills/vault-generator/        the skill (this is what gets installed)
├── SKILL.md                   agent instructions
├── agents/openai.yaml         Codex interface metadata
├── references/                on-demand documentation
├── assets/                    example configuration
└── scripts/
    ├── vg.mjs                 CLI entry point
    ├── install.ts             installer
    ├── vendor/                bundled parsers (yaml, smol-toml) and their licences
    └── lib/                   the engine (detection, analyzers, model, planner, reconciliation, index, …)
tests/                         unit tests and the scenario suite (isolated temporary fixtures)
tools/build-vendor.mjs         rebuilds the bundled parsers
tools/version.mjs              keeps the version in sync across files and checks it
.claude-plugin/marketplace.json  Claude Code plugin marketplace (points at skills/vault-generator)
.github/workflows/             CI (ci.yml) and release (release.yml)
```

`.claude/skills/vault-generator/` and `.agents/skills/vault-generator/` are installed copies, so the skill can be tried
in this repository itself. Re-run the installer after changing `skills/vault-generator/`.

```sh
npm install              # development tools only (TypeScript, esbuild, parser sources)
npm test                 # 51 tests: unit tests plus 28 end-to-end scenarios
npm run typecheck
npm run validate-skill   # checks SKILL.md against the Agent Skills specification
claude plugin validate . --strict  # checks the plugin marketplace (needs Claude Code)
npm run version:check    # the version is the same everywhere and the installed copies match the skill
npm run vendor           # rebuild the bundled parsers after upgrading them
```

The engine is TypeScript that Node runs directly (type stripping). There is no build step and no runtime
`node_modules`.

### Releases

CI (`.github/workflows/ci.yml`) runs on every push to `master` and on every pull request. It runs the type check, the
test suite and `validate-skill` on Ubuntu and Windows with Node.js 22.18 and 24. It also runs
`claude plugin validate . --strict`, and checks that the version is the same in every file and that the installed copies
match the skill.

To publish a release, open the **Actions** tab on GitHub, choose **Release** in the list on the left and click
**Run workflow**. Then choose:

- **Use workflow from**: the branch to release from. The default branch is preselected.
- **bump**: `patch`, `minor` or `major`.
- **beta**: tick it to publish a beta (a pre-release) instead of a stable release.

From version `0.1.0`: `patch` gives `0.1.1`, `minor` gives `0.2.0` and `major` gives `1.0.0`. With **beta** ticked,
`minor` gives `0.2.0-beta.1`, and running it again gives `0.2.0-beta.2`. Running `minor` without **beta** after that
publishes `0.2.0`.

The workflow rewrites every file that carries the version (`npm run version:set`), runs the type check, the tests and
`validate-skill` on the result, and only then commits the change and the tag `vX.Y.Z` to the chosen branch in one atomic
push. It then creates a GitHub release with generated notes and two assets: `vault-generator-skill-vX.Y.Z.zip` (the
skill folder, ready to unzip into `.claude/skills` or `.agents/skills`) and `SHA256SUMS`. If a check fails, nothing is
pushed.

The workflow has to be started from the Actions tab: the Releases page only lists releases. It pushes to the chosen
branch, so it fails if that branch requires pull requests.

The plugin marketplace has no `version` field, so `claude plugin install` always installs the latest commit of the
default branch. The zip is how to pin a release.

## Contributing

Issues and pull requests are welcome. Before opening a pull request:

1. Keep the output deterministic (stable ordering, no timestamps in notes). Reproducibility is a tested guarantee.
2. Add or update a fixture and a test for the behaviour you change (`tests/fixtures.ts`, `tests/scenarios/`).
3. Run `npm test`, `npm run typecheck` and `npm run validate-skill`.
4. If you add an analyzer or transformer, declare its limitations honestly. Do not register capabilities that are not
   implemented.
5. Never commit real credentials. The test fixtures build their fake secrets at runtime so that secret scanners do not
   flag the repository.

Contributions are accepted under the Apache License 2.0 (section 5 of the license).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attributions.

**Original project creator:** [dani-b-g](https://github.com/dani-b-g)  
**Original source:** https://github.com/dani-b-g/vault-generator

Commercial and non-commercial use, modification, and redistribution are permitted under Apache 2.0. When redistributing this project or a derivative work (including portions of its code), retain the applicable license, copyright and attribution notices in accordance with Section 4 of Apache 2.0. This does not require public-facing credit merely for using the tool or for publishing documents generated with it.

The skill bundles [yaml](https://github.com/eemeli/yaml) (ISC) and [smol-toml](https://github.com/squirrelchat/smol-toml)
(BSD-3-Clause) in `skills/vault-generator/scripts/vendor/`, with their licence texts. The installed skill carries its
own `LICENSE.txt` and `NOTICE.txt`.

Obsidian is a trademark of Dynalist Inc. Claude Code is a product of Anthropic and Codex a product of OpenAI.
`vault-generator` is an independent project and is not affiliated with or endorsed by any of them.
