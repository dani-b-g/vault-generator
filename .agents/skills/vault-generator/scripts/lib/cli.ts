// Argument parsing + dispatch + output formatting. Output is JSON (--json) for agents or a compact
// human-readable report. Exit codes: 0 ok, 1 error, 2 validation failed, 3 no results, 10 needs input.
import path from 'node:path';
import type { OpOptions, OpResult } from './types.ts';
import { MODES } from './intent.ts';
import {
  opAnalyze, opCapabilities, opConflicts, opContext, opExamples, opGenerate, opIndex, opReorganize, opRestore, opSearch, opStatus, opTransform, opValidate, opValidateSkill, resolveMode,
} from './ops.ts';
import { scrubPrivatePaths } from './safety.ts';
import { VgError } from './util.ts';

const BOOL = new Set(['json', 'dry-run', 'rebuild', 'apply', 'force', 'include-restricted', 'include-stale', 'prune-stale', 'trust-plugins', 'validate', 'check-sources', 'help', 'verbose']);
const LIST = new Set(['source', 'scope', 'answer']);
const ALIASES: Record<string, string> = { m: 'mode', s: 'source', v: 'vault', q: 'query', o: 'output', i: 'input', h: 'help', 'dry': 'dry-run', n: 'dry-run' };

export interface Parsed {
  opts: OpOptions;
  help: boolean;
  errors: string[];
}

export function parseArgs(argv: string[], cwd = process.cwd()): Parsed {
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      a = a.replace(/^--?/, '');
      let val: string | undefined;
      const eq = a.indexOf('=');
      if (eq > 0) {
        val = a.slice(eq + 1);
        a = a.slice(0, eq);
      }
      const key = ALIASES[a] ?? a;
      if (key.startsWith('no-') && BOOL.has(key.slice(3))) {
        flags[key.slice(3)] = false;
        continue;
      }
      if (BOOL.has(key)) {
        flags[key] = val === undefined ? true : !['false', '0', 'no'].includes(val);
        continue;
      }
      if (val === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next.length > 2)) {
          errors.push(`--${key} needs a value`);
          continue;
        }
        val = next;
        i++;
      }
      if (LIST.has(key)) {
        const prev = (flags[key] as string[] | undefined) ?? [];
        flags[key] = [...prev, ...(key === 'answer' ? [val] : val.split(',').map((s) => s.trim()).filter(Boolean))];
      } else flags[key] = val;
    } else positional.push(a);
  }
  // `vg generate ...` style: first positional may be a mode
  let mode = typeof flags.mode === 'string' ? flags.mode : undefined;
  if (!mode && positional.length && (MODES as readonly string[]).includes(positional[0])) mode = positional.shift();
  if (mode && !(MODES as readonly string[]).includes(mode)) errors.push(`unknown mode "${mode}". Modes: ${MODES.join(', ')}`);
  const answers: Record<string, string> = {};
  for (const a of (flags.answer as string[] | undefined) ?? []) {
    const eq = a.indexOf('=');
    if (eq <= 0) errors.push(`--answer expects id=value, got "${a}"`);
    else answers[a.slice(0, eq).trim()] = a.slice(eq + 1).trim();
  }
  const depth = flags.depth as string | undefined;
  if (depth && !['shallow', 'standard', 'deep'].includes(depth)) errors.push('--depth must be shallow|standard|deep');
  const lang = (flags.language ?? flags.lang) as string | undefined;
  if (lang && !['en', 'es'].includes(lang)) errors.push('--language must be en|es');
  const request = (flags.request as string | undefined) ?? (flags.query as string | undefined) ?? (positional.length ? positional.join(' ') : undefined);
  const opts: OpOptions = {
    mode: mode ?? '',
    cwd: path.resolve(typeof flags.cwd === 'string' ? flags.cwd : cwd),
    vault: flags.vault as string | undefined,
    config: flags.config as string | undefined,
    sources: (flags.source as string[] | undefined) ?? [],
    scope: (flags.scope as string[] | undefined) ?? [],
    depth: depth as OpOptions['depth'],
    language: lang as OpOptions['language'],
    answers,
    dryRun: flags['dry-run'] === true,
    json: flags.json === true,
    request,
    flags,
  };
  return { opts, help: flags.help === true || mode === 'help', errors };
}

export async function dispatch(opts: OpOptions): Promise<OpResult> {
  const { mode, note } = resolveMode(opts);
  opts.mode = mode;
  let r: OpResult;
  switch (mode) {
    case 'analyze': r = await opAnalyze(opts); break;
    case 'generate': r = await opGenerate(opts, 'generate'); break;
    case 'sync': r = await opGenerate(opts, 'sync'); break;
    case 'status': r = await opStatus(opts); break;
    case 'index': r = await opIndex(opts); break;
    case 'search': r = await opSearch(opts); break;
    case 'context': r = await opContext(opts); break;
    case 'validate': r = await opValidate(opts); break;
    case 'reorganize': r = await opReorganize(opts); break;
    case 'transform': r = await opTransform(opts, 'transform'); break;
    case 'export': r = await opTransform(opts, 'export'); break;
    case 'examples': r = await opExamples(opts); break;
    case 'capabilities': r = await opCapabilities(opts); break;
    case 'conflicts': r = await opConflicts(opts); break;
    case 'restore': r = await opRestore(opts); break;
    case 'validate-skill': r = await opValidateSkill(opts); break;
    default: throw new VgError('E_ARGS', `unknown mode ${mode}`);
  }
  if (note) r.warnings.unshift(note);
  return r;
}

export const HELP = `vault-generator — turn code and documentation into an indexed Obsidian vault

Usage: node scripts/vg.mjs [--mode <mode>] [options] ["natural language request"]

Modes
  analyze       detect context and propose a strategy (read-only)        [default without a vault]
  generate      build a vault from the selected sources
  sync          incremental update after source changes
  status        what changed since the last run (read-only)                [default with a vault]
  search        selective retrieval: --mode search "query" [--project p --type t --tech x --version v]
  context       task-specific context package for an agent: --mode context "goal" [--budget 6000]
  validate      check structure, metadata, ids, links, index (read-only)
  reorganize    evaluate the vault structure; --apply to move notes (with backups)
  transform     convert sources: --input <file|dir> [--transformer id] [--output path]
  export        derived artefacts from the vault: --to html|bundle|context|skill
  examples      grounded code examples: --project p --goal "..." --kind snippet|app [--validate]
  capabilities  analyzers, transformers and formats installed here (read-only)
  index         rebuild/update the search index [--rebuild]
  conflicts     list sync conflicts; --resolve <id> --take mine|source|merged
  restore       list backups; --run <runId> [--path note.md] to restore
  validate-skill  validate an Agent Skill directory [--skill-dir dir]

Common options
  --source <path>        source directory (repeatable / comma separated; default: current dir)
  --scope <project>      limit to projects (id, name or path; repeatable)
  --vault <dir>          vault directory (default: <source>/knowledge-vault or the existing vault)
  --answer <id>=<value>  answer a question returned by a previous run (repeatable)
  --depth shallow|standard|deep   --language en|es   --config <file>
  --dry-run              show what would change without writing     --json   machine-readable output
  --include-restricted   include notes marked restricted (search/context/export)
  --on-conflict save-both|keep-mine|take-source   (sync; default save-both)
  --prune-stale          move notes whose source was deleted to .vault-generator/trash (sync)

Exit codes: 0 ok · 1 error · 2 validation failed · 3 no results · 10 needs input (see "questions")`;

export function formatHuman(r: OpResult, verbose = false): string {
  const out: string[] = [];
  const icon = r.status === 'done' ? '✔' : r.status === 'dry_run' ? '◌' : r.status === 'needs_input' ? '?' : '✖';
  out.push(`${icon} [${r.mode}] ${r.summary}`);
  for (const w of r.warnings) out.push(`  ! ${w}`);
  if (r.questions.length) {
    out.push('', r.status === 'needs_input' ? 'Questions (answer to continue):' : r.mode === 'analyze' ? 'Decisions a generate run will ask for:' : 'Optional decisions:');
    for (const q of r.questions) {
      out.push(`  • [${q.id}]${q.blocking ? ' (blocking)' : ''} ${q.prompt}`, `      why: ${q.why}`);
      for (const o of q.options) out.push(`      - ${o.value}: ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}`);
      if (q.default) out.push(`      default: ${q.default}`);
    }
  }
  const d = r.data as Record<string, any>;
  if (r.mode === 'search' && Array.isArray(d.hits)) {
    for (const h of d.hits) out.push('', `  ${h.title}  (${h.type}, confidence ${h.confidence})`, `    ${h.path}${h.section ? ` › ${h.section}` : ''}  lines ${h.lines[0]}-${h.lines[1]}`, `    ${h.snippet}`, ...(h.sources?.length ? [`    sources: ${h.sources.join(', ')}`] : []));
  } else if (r.mode === 'search' && d.text) out.push('', d.text);
  else if (r.mode === 'context' && d.markdown) out.push('', d.markdown);
  else if (r.mode === 'validate' && Array.isArray(d.issues)) {
    for (const i of d.issues.filter((x: { level: string }) => verbose || x.level !== 'info').slice(0, 60)) out.push(`  ${i.level === 'error' ? '✖' : i.level === 'warning' ? '!' : 'i'} ${i.code}${i.path ? ` ${i.path}` : ''}: ${i.message}`);
  } else if ((r.mode === 'generate' || r.mode === 'sync') && Array.isArray(d.changes)) {
    const shown = d.changes.filter((c: { action: string }) => verbose || c.action !== 'update').slice(0, 40);
    for (const c of shown) out.push(`  ${c.action.padEnd(16)} ${c.path}${c.detail ? `  (${c.detail})` : ''}`);
    if (d.contracts && (d.contracts.changed?.length || d.contracts.removed?.length || d.contracts.added?.length)) out.push('', '  Contract changes:', ...d.contracts.changed.map((c: string) => `    ~ ${c}`), ...d.contracts.added.map((c: string) => `    + ${c}`), ...d.contracts.removed.map((c: string) => `    - ${c}`));
    if (d.structural?.length) out.push('', '  Structural changes:', ...d.structural.map((s: string) => `    * ${s}`));
    if (Array.isArray(d.plannedNotes)) for (const n of d.plannedNotes.slice(0, 80)) out.push(`  + ${n.path}  (${n.type})`);
  } else if (r.mode === 'analyze') {
    for (const s of d.sources ?? []) out.push(`  source ${s.label}: ${s.kind} (confidence ${s.confidence})${s.workspaces.length ? ` · ${s.workspaces.map((w: { tool: string }) => w.tool).join(', ')}` : ''}${s.parentWorkspace ? ` · inside ${s.parentWorkspace.tool} workspace at ${s.parentWorkspace.path}` : ''}`);
    for (const p of d.projects ?? []) out.push(`  - ${p.name} [${p.kind}] ${p.path} ${p.frameworks.join(', ')}  ← ${p.kindEvidence[0] ?? ''}`);
    for (const c of d.contradictions ?? []) out.push(`  ⚠ ${c.detail}`);
  } else if (r.mode === 'capabilities') {
    out.push('', '  Analyzers:', ...d.analyzers.map((a: { id: string; description: string }) => `    ${a.id}: ${a.description}`), '', '  Transformers:', ...d.transformers.map((t: { id: string; kind: string; description: string }) => `    ${t.id} (${t.kind}): ${t.description}`), '', '  Not implemented (future):', ...d.notImplemented.map((n: string) => `    - ${n}`));
  } else if (verbose) out.push(JSON.stringify(r.data, null, 2));
  if (r.next.length) out.push('', 'Next:', ...r.next.map((n) => `  → ${n}`));
  return scrubPrivatePaths(out.join('\n'));
}

/** dispatch with errors converted into an OpResult (what the CLI prints) */
export async function runOp(opts: OpOptions): Promise<OpResult> {
  try {
    return await dispatch(opts);
  } catch (e) {
    const err = e as VgError;
    return { ok: false, mode: opts.mode || '?', status: 'error', summary: err.message, data: { code: err.code ?? 'E_INTERNAL', ...(opts.flags.verbose ? { stack: err.stack } : {}) }, questions: [], warnings: [], next: [], exitCode: 1 };
  }
}

export async function main(argv: string[]): Promise<number> {
  const { opts, help, errors } = parseArgs(argv);
  if (help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (errors.length) {
    const r: OpResult = { ok: false, mode: opts.mode || '?', status: 'error', summary: errors.join('; '), data: {}, questions: [], warnings: [], next: ['--help'], exitCode: 1 };
    process.stdout.write(`${opts.json ? JSON.stringify(r, null, 2) : formatHuman(r)}\n`);
    return 1;
  }
  const r = await runOp(opts);
  process.stdout.write(`${opts.json ? scrubPrivatePaths(JSON.stringify(r, null, 2)) : formatHuman(r, opts.flags.verbose === true)}\n`);
  return r.exitCode;
}
