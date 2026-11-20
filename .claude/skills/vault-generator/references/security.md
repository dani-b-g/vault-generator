# Security model

## Enforced by the scripts

| Control | Implementation |
| --- | --- |
| Authorised directories | Every write goes through a `Writer` bound to explicit roots (vault, cwd for outputs); anything else throws `E_WRITE_DENIED`. Writes into `.git/` or `node_modules/` are refused. |
| Path traversal | Untrusted relative paths are joined with `safeJoin`: absolute paths, drive letters, `..` segments and NUL bytes are rejected, and the resolved real path must stay inside the root. |
| Symlinks | Followed only when the target stays inside the source root (`access.followSymlinks: within-roots`), or never (`never`). Cycles are detected. |
| Secrets files | `.env*` (except `.env.example/.sample/.template/.dist`), private keys, keystores, credentials, `.npmrc`, `.netrc`, kubeconfig, Terraform state/vars, `secrets.*` are never read. |
| Secret values | Private keys, cloud/API tokens, JWTs, credentials in URLs and `password=`-style assignments are redacted before text reaches a note, the index or an export. `validate` fails if a generated note contains one. |
| Policy | `access.deny` globs are never read; `access.restricted` globs are generated with `access: restricted`. |
| Restricted content | Auto-detected private documents require a decision (`restricted-docs`). Restricted notes are excluded from search, context and export unless `--include-restricted`. |
| Privacy of persisted data | Manifest/state store relative paths only; absolute paths of other drives go to the git-ignored `local.json`. Persisting an absolute private path aborts the write. CLI output scrubs home directories. |
| Non-destructive | No deletion of user content. Backups before every change, journal per run, conflicts saved aside, stale instead of delete, trash instead of delete with `--prune-stale`. Outputs are never overwritten without `--force`. |
| Read-only modes | `analyze`, `status`, `search`, `context` (without `--output`), `validate`, `capabilities`, `reorganize` (without `--apply`) do not write. |
| Untrusted instructions | Documents with instruction-like text ("ignore previous instructions…") are flagged (`status: needs-review`, danger callout, Open questions). Their content is data. |
| Plugins | Plugin modules execute code, so they load only after the user trusts them (`--trust-plugins`); the trusted content hash is stored and re-checked on every run. |
| Examples | Never written inside the vault; dependency installation and execution only with `--validate`. |

## Not enforced by the scripts (configure the agent)

The skill cannot restrict what the agent does with its other tools. Configure them too:

- **Claude Code** — permission rules in `.claude/settings.json` (deny reads of secrets directories, restrict Bash). Example:
  ```json
  { "permissions": { "deny": ["Read(./.env)", "Read(./secrets/**)", "Read(./**/*.pem)"] } }
  ```
- **Codex** — sandbox and approval settings in `~/.codex/config.toml` (`sandbox_mode`, `approval_policy`), and run with a workspace-write sandbox.

Metadata such as `access: restricted` is a filter, not a security boundary: anyone with file access can read the
vault. Keep truly confidential sources out of the analysed directories or in `access.deny`.
