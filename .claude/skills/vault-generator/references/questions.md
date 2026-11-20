# Questions and decisions

The engine returns questions instead of guessing. Each has an `id` (the decision key), `prompt`, `why`,
`options`, an optional `default`, and `blocking`. Answer with `--answer <id>=<value>`. Answers are stored in
`manifest.decisions` and reused by later runs, so the same question is never asked twice.

## Blocking (asked before anything is written)

| id | When | Options |
| --- | --- | --- |
| `destination` | First `generate` without `--vault`. | `default` (proposed path) or any path. |
| `vault-placement` | The destination already contains notes not created by vault-generator. | `subfolder` (generated notes in `vault-generator/`), `root`, `cancel`. |
| `scope` | More than 12 projects, or several unrelated projects in a folder without a workspace tool. | `all`, or project ids (comma separated). |
| `parent-workspace` | The current directory is one package inside a larger workspace. | `this`, `workspace` (re-run from the root). |
| `restricted-docs` | Documents look private (`private/`, `confidential/` paths, or `access: confidential` frontmatter). | `exclude`, `restricted` (kept but hidden from search/context/export), `public`. |
| `reorganize-confirm` | `reorganize --apply` with proposed moves. | `yes`, `no`. |
| `example-project`, `example-goal`, `example-kind` | `examples` without enough requirements. | project id; free text; `snippet` or `app`. |
| `transformer` | `transform`/`export` cannot infer one transformer. | transformer ids. |

## Optional (do not block; mention them)

| id | When | Effect |
| --- | --- | --- |
| `contradiction:<hash>` | Sources disagree (runtime versions, documented scripts missing from the manifest). | Notes carry a warning callout and `status/needs-review` until answered; the answer is shown as resolved. `keep-both` keeps both claims visible. |
| `relation:<hash>` | A relation was inferred from a pattern (URL literal matches a route or API operation, docs mention a package). | `confirm` turns it into a property link (`consumes`, `implements`…); `reject` removes it; `later` keeps it in "Possible relations". |
| `default-version` | Documentation exists for several versions. | Search and context default to this version (`--version any` searches all). When unanswered the latest is assumed and recorded as `assumed`. |
| `scope-deps` | A `--scope` selection pulled in internal dependencies. | `exclude` keeps them as overview notes only. |
| `language` | Auto-detection picked a language you want to change. | `en`, `es`. |
| `conflict:<noteId>` | Listed by `conflicts`. | Resolve with `--mode conflicts --resolve … --take …`. |

## When you (the agent) should not ask

- The answer is already in `manifest.decisions` (check `status`).
- The user already stated it in the conversation: pass it as `--answer` directly.
- The sources determine it reliably (e.g. a single project with an obvious destination the user already accepted).
- The decision is minor and reversible (layout details, note names): the engine decides and the user can reorganize later.

## Grouping

Ask related blocking questions together (destination + placement; restricted docs + scope), at most four per
round, and explain each `why` in one sentence. Offer the engine's default as the first option when it has one.
