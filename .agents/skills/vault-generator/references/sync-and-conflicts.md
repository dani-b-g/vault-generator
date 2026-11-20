# Incremental sync and conflicts

## What sync detects

| Change | Detection | Effect |
| --- | --- | --- |
| new / modified / deleted file | SHA-256 per file (mtime+size shortcut) | notes created / updated / marked stale |
| renamed or moved file (same content) | identical hash at a new path | same note id, note updated in place |
| new / removed project or package | context detection vs `state.projects` | reported in `structural` |
| dependency changes | dependency graph vs `state.projects` | reported in `structural`, relation properties updated |
| contract changes | fingerprints of API operations/schemas and public symbols | reported in `contracts` (added / changed / removed) |
| broken references | link check during analysis and `validate` | listed under Open questions |
| repeated run without changes | identical plan | every note `unchanged`, no writes except state |

## Decision table for a managed note

| Region edited by user? | Source changed? | Result |
| --- | --- | --- |
| no | no | unchanged |
| no | yes | updated |
| yes | no | kept as is (`preserved-edited`, reported once) |
| yes | yes, non-overlapping | 3-way merge (`merged`) |
| yes | yes, overlapping | `conflict`: your version stays in the note, the regenerated one is saved to `.vault-generator/conflicts/<id>.incoming.md` (with merge markers when a base exists), the note is tagged `status/conflict` |

Content outside the markers is never touched. Frontmatter is merged key by key: user-added list values and
user-modified scalars are kept.

## Resolving conflicts

```sh
VG --mode conflicts --json                                  # list with diffs
VG --mode conflicts --resolve <id> --take mine              # keep your version
VG --mode conflicts --resolve <id> --take source            # take the regenerated version (yours is backed up)
VG --mode conflicts --resolve <id> --take merged            # you resolved the markers by hand in the note
```

Policies for a whole sync: `--on-conflict keep-mine` or `--on-conflict take-source`. The default
(`save-both`) never resolves a destructive conflict silently.

## Deleted sources

Notes whose source disappeared are kept, prefixed with a stale warning and tagged `status/stale`. Use
`--prune-stale` to move them to `.vault-generator/trash/<run>/` (recoverable). Notes outside the current scope
are left untouched.

## Recovery

Every run that changes files writes `.vault-generator/backups/<run>/` with a copy of each file before it
changed, and a journal. `VG --mode restore` lists runs; `--run <id> [--path note.md]` restores. The last
`retention.backupRuns` runs (default 10) are kept. For full history, keep the vault in git.
