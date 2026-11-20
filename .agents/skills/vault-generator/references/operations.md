# Operations reference

`VG` = `node <skill-dir>/scripts/vg.mjs`. Add `--json` for machine-readable output. Every mode accepts
`--cwd <dir>` (default: current directory), `--config <file>` and `--vault <dir>`.

## Common options

| Option | Meaning |
| --- | --- |
| `--source <path>` | Source directory or file. Repeatable or comma separated. Default: the current directory, or the sources stored in the manifest. |
| `--scope <project>` | Restrict to projects (id, name, path or glob). Internal dependencies are added automatically; `--answer scope-deps=exclude` keeps them as overview only. |
| `--vault <dir>` | Vault directory. Default: an existing managed vault in or below cwd, else `<source>/knowledge-vault` (asked). |
| `--answer <id>=<value>` | Answer a question from a previous result. Repeatable. Stored in the manifest. |
| `--depth shallow\|standard\|deep` | How much code detail goes into notes (symbols per module: 25 / 80 / 400). |
| `--language en\|es` | Language of generated headings and labels (auto-detected from READMEs when not set). |
| `--dry-run` | Compute everything, write nothing, report the plan. |
| `--include-restricted` | Include notes marked restricted in search/context/export (only on explicit user request). |
| `--verbose` | More detail in human output; stack traces on errors. |

## Modes

### analyze (read-only)
Detects context per source: kind (`single-project`, `monorepo`, `multi-repo-workspace`, `docs-only`,
`existing-vault`, `mixed`, `unknown`) with confidence, workspaces with evidence, repositories, projects
(kind + evidence, frameworks, languages), doc sources (generator, versions), vaults, parent workspace,
version mismatches, contradictions, skipped files. `questions` lists what `generate` will ask.

### generate
Full pipeline. Blocking questions stop the run before any write (`status: needs_input`). Output data:
`counts` (create/update/merged/conflict/preserved-edited/unchanged/stale), `changes`, `conflicts`,
`contradictions`, `layout`, `index`, `skipped`, `redactions`, `assumedDecisions`.

### sync
Same as generate against the manifest's sources and decisions. Adds `contracts` (API operations and public
symbols added/changed/removed) and `structural` (projects added/removed, dependency or kind changes).
Options: `--on-conflict save-both|keep-mine|take-source` (default `save-both`), `--prune-stale` (moves notes
whose source disappeared into `.vault-generator/trash/<run>`; default keeps them flagged `stale`),
`--trust-plugins` (load configured plugins after the user reviewed them).

### status (read-only)
Files added/modified/removed since the last run, notes edited by hand, open conflicts, decisions, index info.

### search (read-only)
`VG --mode search "query" [--project p] [--type project|module|api|document|decision|example|operations|moc] [--tech name] [--version v|any] [--tag t] [--status s] [--limit n]`.
Returns hits with note path, section, line range, snippet, sources, confidence (`high|medium|low`) and why it matched.
Read one section: `VG --mode search --note "<path or title>" --section "<heading>"`.
Exit code 3 when nothing matches: tell the user the vault does not cover it.

### context (read-only unless `--output`)
`VG --mode context "goal" [--project p] [--version v] [--budget 6000] [--limit 8] [--format markdown|json] [--output file]`.
Returns `data.markdown` (ready to read) and `data.package` (structured: fragments with citations, related notes,
constraints, APIs, examples, dependencies, versions, original files, uncertainties, budget).

### validate (read-only)
Errors: invalid frontmatter, missing `vg` metadata, duplicate ids/keys, broken markers, unresolved wikilinks in
generated notes, secrets or private paths in generated notes, corrupt manifest. Warnings: broken headings,
broken embeds/relative links, stale index, ambiguous names, invalid tags. Info: stale notes, hand-edited notes.
`--check-sources` also verifies that every cited source file still exists.

### reorganize
Without `--apply`: findings (orphans, single-note folders, oversized folders/notes, ambiguous names, notes moved
by the user) and proposed moves. With `--apply`: asks `reorganize-confirm`, then moves files, rewrites links,
updates state and index. Undo with `restore`.

### transform
`VG --mode transform --input <file|dir> [--transformer <id>] [--output <path>] [--force]`.
Built-in: `html-to-markdown`, `openapi-to-markdown`, `code-to-markdown`, `obsidian-to-commonmark`.
Inferred from the input when `--transformer` is omitted.

### export
`VG --mode export --to html|bundle|context|skill [--project p] [--type t] [--tag t] [--output path]`.
- `html` → `vault-to-html`: static site with resolved links (default output `.vault-generator/exports/site`).
- `bundle` → `vault-to-markdown-bundle`: one portable Markdown file.
- `context` → `agent-context`: `--task "goal"`, Markdown + JSON package.
- `skill` → `vault-to-skill`: `--name <skill-name>`, a new Agent Skill directory.

### examples
`VG --mode examples --project <id> --goal "..." --kind snippet|app [--output dir] [--validate] [--force]`.
Missing project/goal/kind come back as questions. Output outside the vault (default `examples/<slug>`).
`--validate` installs dependencies and runs the app (Node.js); without it only syntax checks run.

### capabilities (read-only)
Installed analyzers, transformers (with inputs, outputs, requirements, validations, limitations, update policy),
plugins, SQLite FTS5 availability, vendored libraries and the list of features that are not implemented.

### index
Updates the search index incrementally; `--rebuild` recreates it. Works on any Obsidian vault.

### conflicts
Lists open conflicts with a diff between your version and the incoming one. Resolve with
`--resolve <conflict-id|note-id|path> --take mine|source|merged` (`merged` = you removed the markers by hand).

### restore
Lists backup runs. `--run <runId> [--path <note>] [--dry-run]` restores files changed or moved by that run.
Restoring is itself backed up.

### validate-skill
`VG --mode validate-skill [--skill-dir dir]` checks an Agent Skill directory against the specification.

## Natural language without `--mode`

`VG "find where the auth token is validated"` maps the request to a mode with keyword rules (EN/ES) and reports
the inferred mode in `warnings`. Agents should choose the mode themselves using the table in SKILL.md.

## Configuration file

`vault-generator.config.json` (or `.vault-generator.json`) in the working directory. See
`assets/vault-generator.config.example.json`. Keys: `sources`, `vault`, `scope`, `language`, `depth`, `exclude`,
`include`, `ignoreDirs`, `useGitignore`, `access.{deny,restricted,followSymlinks,maxFileBytes}`,
`layout.{folderThreshold,maxNoteChars}`, `retention.backupRuns`, `attachments.{copy,maxBytes}`, `plugins`,
`truthPrecedence`. Unknown keys are rejected.
