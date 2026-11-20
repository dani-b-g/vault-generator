# Vault format

## Note anatomy

```markdown
---
title: "@acme/http"
type: project            # project | module | api | document | decision | example | operations | moc
version: 0.9.0
tags: [type/project, kind/library, project/acme-http, tech/typescript]
aliases: ["@acme/http"]
technologies: [TypeScript]
belongs_to: ["[[acme-libs]]"]
depends_on: ["[[acme-utils]]"]       # verified relations only
used_by: []
symbols: [HttpClient]
vg:                                   # owned by vault-generator
  id: vg-1a2b3c4d5e                   # stable id, survives renames and moves
  key: project:repo:packages/http     # identity of the knowledge unit
  origin: generated                   # generated | imported | derived | manual
  status: current                     # current | needs-review | stale | conflict | deprecated
  access: public                      # public | restricted
  confidence: verified                # verified | inferred | heuristic
  sources: ["repo:packages/http/package.json@3f2a…"]   # provenance with content hash
  analyzer: detect
---
<!-- vg:begin -->
...generated content (headings, tables, cited facts, provenance callout)...
<!-- vg:end -->

<!-- Add your own notes below this line. vault-generator never modifies content outside the vg:begin / vg:end block. -->
Your notes here.
```

- Everything **outside** the markers belongs to the user and is never modified.
- **Inside** the markers the user may edit; sync merges the edits with new source content (3-way) or records a conflict.
- Removing the markers detaches the note: it becomes manual and is never touched again.
- Properties added by the user are kept. List properties merge user values with generated ones.

## Stable identity

`vg.id` is derived from the scope id and the knowledge key, and stored in `.vault-generator/state.json`.
Renaming or moving a note keeps its id; sync finds it by id and leaves it where the user put it. Renaming a
source file whose content did not change keeps the id too (hash-based rename detection).

## Links

- Body links and relation properties are Obsidian wikilinks using the note's file name (path-qualified only when two notes share a name).
- Relative Markdown links in imported documents are rewritten to wikilinks (including `#heading` anchors); links to code files point to the module note plus the source path; links whose target is missing are kept as text with a ⚠️ marker and listed under Open questions.
- Images referenced by documents are copied to `_attachments/<source>/…` and linked relatively.

## Adaptive layout

| Situation | Layout |
| --- | --- |
| ≤ 12 notes | flat |
| one project | by category (`Modules/`, `Docs/…`, `API/`, `Decisions/`) when a category has enough notes |
| several projects or sources | by project (`<project>/…`), workspace-level documents under `Workspace/`, hubs at the root |
| more than 8 projects | by project kind (`Applications/`, `Libraries/`, …) |

Documentation keeps its own folder structure (minus `docs/` style roots). Folders with fewer than two notes
are collapsed. Small projects are a single note (modules folded in). Oversized documents are split by heading
into parts with a parent note. Identical documents found in several places become one note listing all sources.

## Hub notes (MOCs)

Created only when they carry value: Home (multi-project), Technologies, Decisions (≥ 3 ADRs), Examples (≥ 3),
Open questions (contradictions, possible relations, broken links, unsupported files, conversion limitations,
excluded restricted documents, instruction-like content). In a single-project vault the project note is the home.

## `.vault-generator/`

| File | Content | Commit? |
| --- | --- | --- |
| `manifest.json` | scope id, sources (relative paths), detected context, scope, layout, decisions, open conflicts, transformers, trusted plugins | yes |
| `state.json` | per-note generated hashes and managed properties, ids, source file hashes, contract fingerprints | yes |
| `base/<id>.md` | last generated region (merge base for 3-way merges) | yes |
| `conflicts/<id>.incoming.md` | regenerated version waiting for a decision | yes |
| `examples.json` | examples generated from the vault (paths, validation) | yes |
| `local.json` | absolute paths of sources on other drives (machine specific) | no (ignored) |
| `index.sqlite` | search index (derived, rebuildable) | no (ignored) |
| `backups/<run>/` | copies of every file changed by a run + journal | no (ignored) |
| `trash/<run>/` | notes removed by `--prune-stale` | no (ignored) |

The manifest and state never contain absolute private paths, secrets or file contents.
