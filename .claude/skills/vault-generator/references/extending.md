# Extending vault-generator

Extensions are local ES modules (`.mjs`, or `.ts` with Node ≥ 22.18) listed in the config `plugins` array.
They run code, so the user must review them and run once with `--trust-plugins`; the content hash is stored in
the manifest and checked on every run (a modified plugin is not loaded until trusted again).

```js
// vault-plugins/asciidoc.mjs
export default {
  analyzers: [/* Analyzer objects */],
  transformers: [/* Transformer objects */],
};
```

## Analyzer contract

```ts
interface Analyzer {
  id: string; version: string; description: string;
  handles: string[];          // shown by --mode capabilities
  limitations: string[];      // shown by --mode capabilities; be honest
  match(file: FileInfo, head: string): number;   // priority (> 0 handles it; built-ins use 1-50; plugins win ties)
  analyze(file: FileInfo, ctx: AnalyzerContext): AnalysisResult;
}
```

`FileInfo` gives `source`, `path` (posix, relative to the source root), `ext`, `format`, `hash`, `restricted`.
`ctx.read(file)` returns normalised UTF-8 text; `ctx.exists(rel)` checks a path inside the source.

`AnalysisResult`:
- `documents[]` — `DocumentUnit` with Obsidian Markdown `body`, `title`, `category` (readme, guide, reference, decision, example, …), `sections`, `links`, `version`, and **`lossy[]`: every feature that could not be preserved** (never claim a complete conversion when something was lost);
- `entities[]` — open vocabulary `type` (new types need no core change), `refs` (provenance), `confidence`, optional `fingerprint` for contract change detection;
- `relations[]` — `type`, `from`, `to`, `status: verified|inferred`, `evidence[]` (no evidence → no relation);
- `facts[]` — claims (`subject`, `value`, `authority`) used for contradiction detection;
- `code` — for code analyzers: imports and symbols;
- `limitations[]`, `warnings[]`.

Minimal example (AsciiDoc as text with headings):

```js
export default {
  analyzers: [{
    id: 'asciidoc', version: '1', description: 'AsciiDoc documents (headings and paragraphs)',
    handles: ['.adoc'], limitations: ['Tables, includes and attributes are not converted'],
    match: (f) => (f.ext === '.adoc' ? 30 : 0),
    analyze(f, ctx) {
      const text = ctx.read(f);
      const body = text.replace(/^(=+) (.*)$/gm, (_m, eq, t) => `${'#'.repeat(eq.length)} ${t}`);
      return {
        documents: [{ key: `doc:${f.source}:${f.path}`, file: { source: f.source, path: f.path }, title: /^# (.*)$/m.exec(body)?.[1] ?? f.path,
          kind: 'asciidoc', category: 'document', body, sections: [], links: [], codeBlocks: [], mermaid: 0, tables: 0, admonitions: [],
          lossy: ['AsciiDoc tables/includes/attributes not converted'] }],
        entities: [], relations: [], facts: [], limitations: [], warnings: [],
      };
    },
  }],
};
```

## Transformer contract

```ts
interface Transformer {
  id: string; version: string; description: string;
  kind: 'transform' | 'export';
  inputs: string[]; outputs: string[]; requires: string[]; dependencies: string[];
  capabilities: string[]; validations: string[]; limitations: string[];
  updatePolicy: 'overwrite-generated' | 'create-only' | 'merge';
  run(ctx: TransformContext, input?: string, output?: string): TransformResult | Promise<TransformResult>;
}
```

`run` must validate its own output and return `validations[]` (name, passed, detail) and `lossy[]`. Write files
only through paths inside `ctx.cwd` or `ctx.vaultDir`, never overwrite existing outputs unless
`ctx.args.force`, and exclude restricted notes unless `ctx.includeRestricted`. Do not register a transformer whose
core function is not implemented.

## Adding a format to the core

1. Classification: `scripts/lib/scan.ts` (`classify`) maps extensions to formats.
2. Analyzer: add a module under `scripts/lib/analyzers/` and register it in `analyzers/index.ts`.
3. Tests: add a fixture in `tests/fixtures.ts` and assertions in `tests/unit/` or `tests/scenarios/`.
4. Run `npm test` and `npm run typecheck`.

## Modifying an analyzer

Keep the output deterministic (sorted, no timestamps) so repeated runs produce identical notes. Bump its
`version` when its output changes meaningfully. Run the scenario tests: they check idempotence, provenance and
link integrity.
