// Operation handlers. Every handler returns an OpResult (JSON-serialisable) and never writes outside
// the authorised roots. Read-only modes (analyze, search, context, validate, capabilities, status)
// never modify files.
import fs from 'node:fs';
import path from 'node:path';
import type { OpOptions, OpResult, Question, TransformContext } from './types.ts';
import { prepare, runGenerate, scanAll, analyzeFiles, contentQuestions } from './pipeline.ts';
import { buildModel } from './model.ts';
import { BUILTIN_ANALYZERS, loadPlugins } from './analyzers/index.ts';
import { BUILTIN_TRANSFORMERS, findTransformer, inferTransformer } from './transformers.ts';
import { buildContext, readSection, renderContextMarkdown, searchVault } from './context.ts';
import { indexInfo, updateIndex } from './index-db.ts';
import { validateVault } from './validate.ts';
import { analyzeStructure, applyMoves } from './reorganize.ts';
import { generateExample } from './examples.ts';
import { listBackups, loadManifest, loadState, recordDecision, TOOL_VERSION, vgPaths } from './state.ts';
import { loadConfig } from './config.ts';
import { Writer, readJsonFile } from './fsutil.ts';
import { safeJoin, isInside } from './safety.ts';
import { parseNote, readVault, regionHash, renderNote } from './vault.ts';
import { unifiedDiff } from './diff3.ts';
import { normalizeText, toPosix, VgError, runId as newRunId } from './util.ts';
import { detectIntent } from './intent.ts';
import { validateSkillDir } from './skillcheck.ts';
import { RunJournal, type JournalEntry } from './state.ts';

const result = (mode: string, p: Partial<OpResult> & { summary: string }): OpResult => ({
  ok: p.status !== 'error', mode, status: p.status ?? 'done', summary: p.summary, data: p.data ?? {}, questions: p.questions ?? [], warnings: p.warnings ?? [], next: p.next ?? [],
  exitCode: p.exitCode ?? (p.status === 'needs_input' ? 10 : p.status === 'error' ? 1 : 0),
});
const rel = (cwd: string, p: string) => toPosix(path.relative(cwd, p)) || '.';
const needsInput = (mode: string, questions: Question[], summary: string, data: Record<string, unknown> = {}, next: string[] = []) =>
  result(mode, { status: 'needs_input', summary, questions, data, next: next.length ? next : [`answer with: --answer ${questions.filter((q) => q.blocking)[0]?.id ?? questions[0]?.id}=<value> (repeat --answer for each question)`] });

function vaultFor(opts: OpOptions, require = true): string {
  const loaded = loadConfig(opts.cwd, opts.config);
  const explicit = opts.vault ?? loaded.extra.vault;
  if (explicit) return path.resolve(opts.cwd, explicit);
  if (fs.existsSync(vgPaths(opts.cwd).manifest)) return opts.cwd;
  const def = path.join(opts.cwd, 'knowledge-vault');
  if (fs.existsSync(vgPaths(def).manifest)) return def;
  // one generated vault directly below cwd
  const below = fs.existsSync(opts.cwd) ? fs.readdirSync(opts.cwd, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(vgPaths(path.join(opts.cwd, e.name)).manifest)) : [];
  if (below.length === 1) return path.join(opts.cwd, below[0].name);
  if (below.length > 1) throw new VgError('E_AMBIGUOUS_VAULT', `Several vaults found (${below.map((b) => b.name).join(', ')}); pass --vault`);
  if (require) throw new VgError('E_NO_VAULT', 'No vault found. Generate one first (--mode generate) or pass --vault <dir>.');
  return def;
}

// ───────────────────────── analyze (read-only) ─────────────────────────
export async function opAnalyze(opts: OpOptions): Promise<OpResult> {
  const prep = prepare(opts, 'analyze');
  const scan = scanAll(prep);
  const plugins = await loadPlugins(path.dirname(prep.configFile ?? path.join(prep.cwd, 'x')), prep.config.plugins, prep.manifest?.trustedPlugins ?? {});
  const { analyses } = analyzeFiles(prep, scan.files, [...plugins.analyzers, ...BUILTIN_ANALYZERS]);
  const model = buildModel({
    config: prep.config, sources: prep.sources, reports: prep.reports, selected: prep.selection.keys, scopeMode: prep.selection.mode, files: scan.files, skipped: scan.skipped,
    analyses, decisions: prep.decisions, includeRestricted: (prep.decisions['restricted-docs']?.answer as 'exclude') ?? 'exclude', rootScripts: {},
  });
  // the questions a generate run would ask
  const genPrep = (() => {
    try {
      return prepare(opts, 'generate');
    } catch {
      return undefined;
    }
  })();
  const questions = [...(genPrep?.questions ?? []), ...contentQuestions(prep, scan.files, model, 'generate')];
  const data = {
    vault: { path: rel(prep.cwd, prep.vaultDir), exists: prep.vaultExists, managed: !!prep.manifest },
    language: prep.language,
    sources: prep.sources.map((s) => {
      const r = prep.reports[s.id];
      return {
        id: s.id, label: s.label, path: rel(prep.cwd, s.root), kind: r.kind, confidence: r.confidence, workspaces: r.workspaces.map((w) => ({ tool: w.tool, path: w.path, evidence: w.evidence })),
        repositories: r.repositories.map((x) => x.path), parentWorkspace: r.parentWorkspace, stats: r.stats, ambiguities: r.ambiguities, vaults: r.vaults,
        docSources: r.docSources, versionMismatches: r.versionMismatches.map((m) => ({ subject: m.subject, values: m.values })),
      };
    }),
    projects: model.projects.map((p) => ({ id: p.id, name: p.name, path: `${p.source}:${p.path}`, kind: p.kind, ecosystem: p.ecosystem, version: p.version, frameworks: p.frameworks.map((f) => `${f.name}${f.version ? `@${f.version}` : ''}`), languages: p.languages, kindEvidence: p.kindEvidence, selected: p.selected, partial: p.partial })),
    relations: model.relations.filter((r) => r.from.startsWith('project:') || r.type !== 'depends-on').slice(0, 60).map((r) => ({ type: r.type, from: r.from, to: r.to, status: r.status, evidence: r.evidence[0]?.note })),
    contradictions: model.contradictions.map((c) => ({ id: c.id, detail: c.detail, suggested: c.suggested })),
    documents: model.docs.length, apis: model.apis.length, configs: model.configs.length, modules: model.modules.length,
    skipped: summarizeSkips(scan.skipped), unsupported: model.unsupported.slice(0, 20), brokenLinks: model.brokenLinks.length, redactions: model.redactions,
    plannedLayout: genPrep ? 'see --mode generate --dry-run for the exact note list' : undefined,
  };
  const kinds = [...new Set(data.sources.map((s) => s.kind))].join(', ');
  return result('analyze', {
    summary: `${kinds} · ${model.projects.length} project(s), ${model.docs.length} document(s), ${model.apis.length} API spec(s), ${model.modules.length} code module(s). Nothing was written.`,
    data, questions, warnings: prep.notes,
    next: [questions.some((q) => q.blocking) ? 'answer the blocking questions, then run --mode generate' : '--mode generate --dry-run to preview notes, then --mode generate'],
  });
}
function summarizeSkips(sk: { reason: string; path: string }[]) {
  const by: Record<string, { count: number; examples: string[] }> = {};
  for (const s of sk) {
    const e = (by[s.reason] ??= { count: 0, examples: [] });
    e.count++;
    if (e.examples.length < 5) e.examples.push(s.path);
  }
  return by;
}

// ───────────────────────── generate / sync ─────────────────────────
export async function opGenerate(opts: OpOptions, mode: 'generate' | 'sync'): Promise<OpResult> {
  const out = await runGenerate(opts, mode);
  const cwd = out.prep.cwd;
  if (out.status === 'needs_input') {
    return needsInput(mode, out.questions, `Input needed before writing anything (${out.questions.filter((q) => q.blocking).length} blocking question(s)).`, {
      vault: rel(cwd, out.prep.vaultDir), sources: out.prep.sources.map((s) => ({ label: s.label, kind: out.prep.reports[s.id]?.kind })),
    });
  }
  const a = out.apply!;
  const c = a.counts;
  const nonBlocking = out.questions.filter((q) => !q.blocking && !out.prep.decisions[q.id]);
  const dataChanges = a.changes.filter((x) => x.action !== 'unchanged' && x.action !== 'out-of-scope');
  const data: Record<string, unknown> = {
    vault: rel(cwd, out.prep.vaultDir), runId: out.runId, layout: out.plan!.layout, counts: c, notes: out.plan!.notes.length,
    changes: dataChanges.slice(0, 200).map((x) => ({ path: x.path, action: x.action, detail: x.detail })),
    conflicts: a.conflicts.map((x) => ({ id: x.id, path: x.path, incoming: x.incoming, detail: x.detail })),
    contradictions: out.model!.contradictions.map((x) => ({ id: x.id, detail: x.detail, decided: out.prep.decisions[x.id]?.answer })),
    inferredRelations: out.model!.relations.filter((r) => r.status === 'inferred').length,
    index: out.index, attachments: a.attachments, assumedDecisions: out.prep.assumed, writes: out.writes,
    skipped: summarizeSkips(out.scan!.skipped), redactions: out.model!.redactions,
  };
  if (mode === 'sync') {
    data.contracts = out.contracts;
    data.structural = out.structural;
  }
  if (out.status === 'dry_run') {
    data.plannedNotes = out.plan!.notes.map((n) => ({ path: a.paths[n.id], type: n.type, title: n.title }));
    return result(mode, { status: 'dry_run', summary: `Dry run: ${out.plan!.notes.length} note(s) planned (${fmtCounts(c)}). Nothing was written.`, data, questions: nonBlocking, warnings: out.warnings, next: [`--mode ${mode} to write`] });
  }
  const parts = [`${out.plan!.notes.length} note(s): ${fmtCounts(c)}`];
  if (a.conflicts.length) parts.push(`${a.conflicts.length} conflict(s) need review`);
  if (out.contracts && (out.contracts.changed.length || out.contracts.removed.length)) parts.push(`${out.contracts.changed.length + out.contracts.removed.length} contract change(s)`);
  const next: string[] = [];
  if (a.conflicts.length) next.push('--mode conflicts to review and resolve conflicts');
  if (nonBlocking.length) next.push(`optional decisions pending (${nonBlocking.map((q) => q.id).slice(0, 5).join(', ')}): answer with --answer <id>=<value> and run --mode sync`);
  next.push('--mode validate', '--mode search "<query>"');
  return result(mode, { summary: `${mode === 'generate' ? 'Vault generated' : 'Vault synchronised'} at ${rel(cwd, out.prep.vaultDir)} — ${parts.join('; ')}.`, data, questions: nonBlocking, warnings: out.warnings, next });
}
const fmtCounts = (c: Record<string, number>) => Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'no changes';

// ───────────────────────── status ─────────────────────────
export async function opStatus(opts: OpOptions): Promise<OpResult> {
  const vaultDir = vaultFor(opts, false);
  const m = fs.existsSync(vgPaths(vaultDir).manifest) ? loadManifest(vaultDir) : undefined;
  if (!m) return opAnalyze(opts);
  const state = loadState(vaultDir);
  const prep = prepare({ ...opts, vault: vaultDir }, 'analyze');
  const scan = scanAll(prep, state.files);
  const now = new Map(scan.files.filter((f) => f.hash).map((f) => [`${f.source}:${f.path}`, f.hash]));
  const added = [...now.keys()].filter((k) => !state.files[k]);
  const removed = Object.keys(state.files).filter((k) => !now.has(k));
  const modified = [...now.entries()].filter(([k, h]) => state.files[k] && state.files[k].hash !== h).map(([k]) => k);
  const notes = readVault(vaultDir).filter((n) => n.hasVg);
  const edited = notes.filter((n) => state.notes[n.id] && n.regionHash && n.regionHash !== state.notes[n.id].genHash).map((n) => n.path);
  return result('status', {
    summary: `Vault "${m.name}" (${notes.length} managed notes). Sources: ${added.length} added, ${modified.length} modified, ${removed.length} removed since the last run. ${m.conflicts.length} open conflict(s).`,
    data: { vault: rel(opts.cwd, vaultDir), lastRun: m.sync.lastRunId, added: added.slice(0, 50), modified: modified.slice(0, 50), removed: removed.slice(0, 50), editedNotes: edited.slice(0, 50), conflicts: m.conflicts, decisions: m.decisions, index: indexInfo(vgPaths(vaultDir).index) },
    next: added.length + modified.length + removed.length ? ['--mode sync'] : ['--mode search "<query>"'],
  });
}

// ───────────────────────── index ─────────────────────────
export async function opIndex(opts: OpOptions): Promise<OpResult> {
  const vaultDir = opts.vault ? path.resolve(opts.cwd, opts.vault) : vaultFor(opts, false);
  if (!fs.existsSync(vaultDir)) throw new VgError('E_NO_VAULT', `vault not found: ${vaultDir}`);
  if (opts.dryRun) return result('index', { status: 'dry_run', summary: `Would index ${readVault(vaultDir).length} note(s).` });
  const paths = vgPaths(vaultDir);
  new Writer([vaultDir]).mkdir(paths.dir);
  const stats = updateIndex(paths.index, readVault(vaultDir), { rebuild: opts.flags.rebuild === true });
  const m = loadManifest(vaultDir);
  if (m) {
    m.indexing = { engine: 'sqlite-fts5', notes: stats.notes, contentHash: stats.contentHash };
    new Writer([vaultDir]).writeJson(paths.manifest, m);
  }
  return result('index', { summary: `Index updated: ${stats.notes} notes, ${stats.chunks} chunks (${stats.added} added, ${stats.updated} updated, ${stats.removed} removed, ${stats.unchanged} unchanged).`, data: { ...stats } });
}

// ───────────────────────── search / context ─────────────────────────
const filtersOf = (opts: OpOptions) => ({
  project: opts.flags.project as string | undefined, type: opts.flags.type as string | undefined, tech: opts.flags.tech as string | undefined, version: opts.flags.version as string | undefined,
  tag: opts.flags.tag as string | undefined, status: opts.flags.status as string | undefined, includeRestricted: opts.flags['include-restricted'] === true, includeStale: opts.flags['include-stale'] === true,
});
export async function opSearch(opts: OpOptions): Promise<OpResult> {
  const vaultDir = vaultFor(opts);
  const q = opts.request ?? String(opts.flags.query ?? '');
  if (opts.flags.note) {
    const sec = readSection(vaultDir, String(opts.flags.note), opts.flags.section as string | undefined);
    if (!sec) return result('search', { status: 'error', summary: `Note or section not found: ${String(opts.flags.note)}${opts.flags.section ? ` › ${String(opts.flags.section)}` : ''}`, exitCode: 4 });
    return result('search', { summary: `Section from ${sec.path}`, data: { path: sec.path, text: sec.text } });
  }
  if (!q) throw new VgError('E_ARGS', 'search needs a query: --mode search "<query>"');
  const limit = Number(opts.flags.limit ?? 8);
  const r = searchVault(vaultDir, q, filtersOf(opts), limit);
  const hits = r.hits.map((h) => ({ title: h.title, path: h.path, type: h.type, section: h.heading, lines: h.lines, confidence: h.confidence, snippet: h.snippet, sources: h.sources.slice(0, 3), matched: h.via ?? h.matched.join(', '), status: h.status, version: h.version || undefined }));
  const warnings: string[] = [];
  if (r.restrictedHidden && !filtersOf(opts).includeRestricted) warnings.push(`${r.restrictedHidden} restricted note(s) excluded from results`);
  if (r.defaultVersion && !opts.flags.version) warnings.push(`results limited to documentation version ${r.defaultVersion} (default); pass --version any to search all versions`);
  return result('search', {
    summary: hits.length ? `${hits.length} result(s) for "${q}"${hits[0].confidence === 'low' ? ' (weak matches only)' : ''}.` : `No information found in the vault for "${q}". The vault does not cover it; check the sources directly.`,
    data: { query: q, terms: r.terms, hits }, warnings,
    next: hits.length ? ['--mode search --note "<path>" --section "<heading>" to read a section', `--mode context "${q}" for a task-ready package`] : [],
    exitCode: hits.length ? 0 : 3,
  });
}
export async function opContext(opts: OpOptions): Promise<OpResult> {
  const vaultDir = vaultFor(opts);
  const goal = opts.request ?? String(opts.flags.task ?? '');
  if (!goal) throw new VgError('E_ARGS', 'context needs a goal: --mode context "<task>"');
  const pkg = buildContext(vaultDir, goal, { filters: filtersOf(opts), budget: Number(opts.flags.budget ?? 6000), maxNotes: Number(opts.flags.limit ?? 8) });
  const md = renderContextMarkdown(pkg, loadManifest(vaultDir));
  const outputs: string[] = [];
  if (opts.flags.output && !opts.dryRun) {
    const base = path.resolve(opts.cwd, String(opts.flags.output)).replace(/\.(md|json)$/i, '');
    const w = new Writer([opts.cwd, vaultDir]);
    w.write(`${base}.md`, md);
    w.writeJson(`${base}.json`, pkg);
    outputs.push(rel(opts.cwd, `${base}.md`), rel(opts.cwd, `${base}.json`));
  }
  return result('context', {
    summary: `Context package: ${pkg.fragments.length} fragment(s) from ${new Set(pkg.fragments.map((f) => f.notePath)).size} note(s), ~${pkg.budget.used} tokens.${pkg.uncertainties.length ? ` ${pkg.uncertainties.length} uncertainty note(s).` : ''}`,
    data: { markdown: opts.flags.format === 'json' ? undefined : md, package: opts.flags.format === 'markdown' ? undefined : pkg, outputs },
    exitCode: pkg.fragments.length ? 0 : 3,
  });
}

// ───────────────────────── validate ─────────────────────────
export async function opValidate(opts: OpOptions): Promise<OpResult> {
  const vaultDir = vaultFor(opts, false);
  const rep = validateVault(vaultDir, { checkSources: opts.flags['check-sources'] === true });
  const errors = rep.issues.filter((i) => i.level === 'error');
  const warnings = rep.issues.filter((i) => i.level === 'warning');
  return result('validate', {
    status: rep.ok ? 'done' : 'error',
    summary: `${rep.notes} note(s) (${rep.managed} managed, ${rep.manual} manual): ${errors.length} error(s), ${warnings.length} warning(s), ${rep.issues.length - errors.length - warnings.length} info.`,
    data: { vault: rel(opts.cwd, vaultDir), ...rep, issues: rep.issues.slice(0, 300) },
    next: rep.issues.some((i) => i.code.startsWith('index')) ? ['--mode index'] : rep.issues.some((i) => i.code === 'conflict') ? ['--mode conflicts'] : [],
    exitCode: rep.ok ? 0 : 2,
  });
}

// ───────────────────────── conflicts ─────────────────────────
export async function opConflicts(opts: OpOptions): Promise<OpResult> {
  const vaultDir = vaultFor(opts);
  const paths = vgPaths(vaultDir);
  const m = loadManifest(vaultDir)!;
  const id = opts.flags.resolve as string | undefined;
  const take = opts.flags.take as string | undefined;
  if (!id) {
    const list = m.conflicts.map((c) => {
      let diff = '';
      try {
        const cur = parseNote(normalizeText(fs.readFileSync(safeJoin(vaultDir, c.path), 'utf8'))).region ?? '';
        const inc = c.incoming ? parseNote(normalizeText(fs.readFileSync(safeJoin(vaultDir, c.incoming), 'utf8'))).region ?? '' : '';
        diff = unifiedDiff(cur, inc, 2, 60);
      } catch {
        diff = '(files missing)';
      }
      return { ...c, diff };
    });
    const qs: Question[] = list.map((c) => ({ id: `conflict:${c.noteId}`, kind: 'conflict', blocking: false, prompt: `${c.path}: ${c.detail}`, why: 'You edited the generated region and the source changed too.', options: [{ value: 'mine', label: 'Keep my version' }, { value: 'source', label: 'Take the regenerated version (mine is backed up)' }, { value: 'merged', label: 'I resolved the markers by hand in the note' }] }));
    return result('conflicts', { summary: `${list.length} open conflict(s).`, data: { conflicts: list }, questions: qs, next: list.length ? ['--mode conflicts --resolve <conflict-id|note-id> --take mine|source|merged'] : [] });
  }
  const c = m.conflicts.find((x) => x.id === id || x.noteId === id || x.path === id);
  if (!c) throw new VgError('E_ARGS', `conflict not found: ${id}`);
  if (!take || !['mine', 'source', 'merged'].includes(take)) throw new VgError('E_ARGS', '--take must be mine, source or merged');
  const w = new Writer([vaultDir], opts.dryRun);
  const journal = new RunJournal(paths, w, newRunId());
  const abs = safeJoin(vaultDir, c.path);
  const parts = parseNote(normalizeText(fs.readFileSync(abs, 'utf8')));
  const state = loadState(vaultDir);
  const st = state.notes[c.noteId];
  let region = parts.region ?? '';
  if (take === 'source') {
    if (!c.incoming) throw new VgError('E_STATE', 'no incoming version stored for this conflict');
    const inc = parseNote(normalizeText(fs.readFileSync(safeJoin(vaultDir, c.incoming), 'utf8')));
    region = (inc.region ?? '').replace(/^<<<<<<< [^\n]*\n[\s\S]*?\n=======\n([\s\S]*?)\n>>>>>>> [^\n]*$/gm, '$1');
  } else if (take === 'merged' && /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(region)) throw new VgError('E_STATE', 'conflict markers are still present in the note; edit it first or choose mine/source');
  const vg = { ...(parts.fm.vg as Record<string, unknown>), status: 'current' };
  const tags = Array.isArray(parts.fm.tags) ? (parts.fm.tags as string[]).filter((tg) => tg !== 'status/conflict') : parts.fm.tags;
  const b = journal.backup(c.path);
  journal.record({ action: 'update', path: c.path, backup: b });
  w.write(abs, renderNote({ ...parts.fm, vg, tags }, parts.pre, region, parts.post));
  if (st) {
    // the incoming (generated) version becomes the new base, so the next sync only re-flags real changes
    const inc = c.incoming && fs.existsSync(safeJoin(vaultDir, c.incoming)) ? parseNote(normalizeText(fs.readFileSync(safeJoin(vaultDir, c.incoming), 'utf8'))).region ?? region : region;
    const clean = inc.replace(/^<<<<<<< [^\n]*\n[\s\S]*?\n=======\n([\s\S]*?)\n>>>>>>> [^\n]*$/gm, '$1');
    st.genHash = take === 'source' ? regionHash(region) : regionHash(clean);
    w.write(path.join(paths.base, `${c.noteId}.md`), `${clean}\n`);
  }
  m.conflicts = m.conflicts.filter((x) => x !== c);
  recordDecision(m, `conflict:${c.noteId}`, take);
  delete m.decisions[`conflict:${c.noteId}`]; // one-shot: resolutions do not apply to future syncs
  if (!opts.dryRun) {
    journal.save('conflicts');
    w.writeJson(paths.manifest, m);
    w.writeJson(paths.state, state);
    updateIndex(paths.index, readVault(vaultDir));
  }
  return result('conflicts', { summary: `Conflict on ${c.path} resolved (${take}). Previous content backed up in run ${journal.runId}.`, data: { path: c.path, take, backupRun: journal.runId } });
}

// ───────────────────────── restore ─────────────────────────
export async function opRestore(opts: OpOptions): Promise<OpResult> {
  const vaultDir = vaultFor(opts);
  const paths = vgPaths(vaultDir);
  const runs = listBackups(paths);
  const runIdArg = opts.flags.run as string | undefined;
  if (!runIdArg) return result('restore', { summary: `${runs.length} backup run(s) available.`, data: { runs }, next: runs.length ? ['--mode restore --run <runId> [--path <note>] --dry-run'] : [] });
  const j = readJsonFile<{ entries: JournalEntry[] }>(path.join(paths.backups, runIdArg, 'journal.json'));
  if (!j) throw new VgError('E_ARGS', `backup run not found: ${runIdArg}`);
  const only = opts.flags.path as string | undefined;
  const w = new Writer([vaultDir], opts.dryRun);
  const journal = new RunJournal(paths, w, newRunId());
  const done: string[] = [];
  for (const e of [...j.entries].reverse()) {
    if (only && e.path !== only && e.from !== only) continue;
    if (e.action === 'move' && e.from) {
      const cur = safeJoin(vaultDir, e.path);
      if (fs.existsSync(cur) && !fs.existsSync(safeJoin(vaultDir, e.from))) {
        journal.backup(e.path);
        w.move(cur, safeJoin(vaultDir, e.from));
        journal.record({ action: 'restore', path: e.from, from: e.path });
        done.push(`${e.path} → ${e.from}`);
      }
      continue;
    }
    if (e.backup) {
      const src = path.join(paths.backups, runIdArg, 'files', e.backup);
      if (!fs.existsSync(src)) continue;
      const target = e.action === 'trash' ? e.path : e.path;
      const b = journal.backup(target);
      w.copy(src, safeJoin(vaultDir, target));
      journal.record({ action: 'restore', path: target, backup: b });
      done.push(target);
    } else if (e.action === 'create') {
      done.push(`${e.path} (created by that run; left in place — delete it manually if unwanted)`);
    }
  }
  if (!opts.dryRun) {
    journal.save('restore');
    updateIndex(paths.index, readVault(vaultDir));
  }
  return result('restore', { status: opts.dryRun ? 'dry_run' : 'done', summary: `${opts.dryRun ? 'Would restore' : 'Restored'} ${done.length} item(s) from run ${runIdArg}. The state before restoring is itself backed up (run ${journal.runId}).`, data: { restored: done }, next: ['--mode sync to bring generated notes up to date again'] });
}

// ───────────────────────── reorganize ─────────────────────────
export async function opReorganize(opts: OpOptions): Promise<OpResult> {
  const vaultDir = vaultFor(opts, false);
  if (!fs.existsSync(vaultDir)) throw new VgError('E_NO_VAULT', `vault not found: ${vaultDir}`);
  const prop = analyzeStructure(vaultDir);
  if (opts.flags.apply !== true) {
    return result('reorganize', {
      status: 'dry_run', summary: `${prop.notes} notes in ${prop.folders} folder(s): ${prop.findings.length} finding(s), ${prop.moves.length} proposed move(s), ${prop.linkUpdates} link(s) to update. Nothing was changed.`,
      data: { ...prop }, next: prop.moves.length ? ['review the moves, then --mode reorganize --apply (backups are kept; --mode restore undoes it)'] : [],
    });
  }
  const answer = opts.answers['reorganize-confirm'];
  if (!answer && prop.moves.length) {
    return needsInput('reorganize', [{ id: 'reorganize-confirm', kind: 'reorganize', blocking: true, prompt: `Apply ${prop.moves.length} move(s) and update links in affected notes?`, why: 'Moving notes changes the structure you navigate; every file is backed up first.', options: [{ value: 'yes', label: 'Apply' }, { value: 'no', label: 'Cancel' }] }], 'Confirmation required.', { moves: prop.moves });
  }
  if (answer === 'no') return result('reorganize', { summary: 'Cancelled; nothing changed.' });
  const r = applyMoves(vaultDir, prop.moves, opts.dryRun);
  return result('reorganize', { summary: `${r.moved.length} note(s) moved, ${r.rewritten.length} note(s) with updated links. Undo with --mode restore --run ${r.runId}.`, data: r });
}

// ───────────────────────── transform / export ─────────────────────────
async function allTransformers(opts: OpOptions, vaultDir?: string) {
  const loaded = loadConfig(opts.cwd, opts.config);
  const m = vaultDir && fs.existsSync(vgPaths(vaultDir).manifest) ? loadManifest(vaultDir) : undefined;
  const plugins = await loadPlugins(path.dirname(loaded.file ?? path.join(opts.cwd, 'x')), loaded.config.plugins, m?.trustedPlugins ?? {});
  return { list: [...plugins.transformers, ...BUILTIN_TRANSFORMERS], config: loaded.config, warnings: [...plugins.errors, ...(plugins.untrusted.length ? [`untrusted plugin(s) not loaded: ${plugins.untrusted.join(', ')}`] : [])] };
}
export async function opTransform(opts: OpOptions, kind: 'transform' | 'export'): Promise<OpResult> {
  const vaultDir = kind === 'export' ? vaultFor(opts) : (() => {
    try {
      return vaultFor(opts, false);
    } catch {
      return undefined;
    }
  })();
  const { list, config, warnings } = await allTransformers(opts, vaultDir);
  const input = (opts.flags.input as string | undefined) ?? (kind === 'transform' ? opts.request : undefined);
  const id = opts.flags.transformer as string | undefined;
  const to = (opts.flags.to ?? opts.flags.format) as string | undefined;
  const t = id ? findTransformer(list, id) : inferTransformer(list, kind, input && path.resolve(opts.cwd, input), to);
  if (!t) {
    return needsInput(kind, [{ id: 'transformer', kind: 'transform', blocking: true, prompt: `Which ${kind === 'export' ? 'export format' : 'transformation'}?`, why: 'The input/output formats did not identify a single transformer.', options: list.filter((x) => x.kind === kind).map((x) => ({ value: x.id, label: `${x.id} — ${x.description}` })) }], 'Choose a transformer.', {}, ['--transformer <id>']);
  }
  if (t.kind !== kind) throw new VgError('E_ARGS', `${t.id} is a ${t.kind} transformer; use --mode ${t.kind}`);
  const vaultOk = vaultDir && fs.existsSync(vaultDir) ? vaultDir : undefined;
  if (input && vaultOk && !isInside(opts.cwd, path.resolve(opts.cwd, input)) && !isInside(vaultOk, path.resolve(opts.cwd, input))) throw new VgError('E_PATH', 'input must be inside the working directory or the vault');
  const ctx: TransformContext = { cwd: opts.cwd, vaultDir: vaultOk, config, includeRestricted: opts.flags['include-restricted'] === true, args: { ...opts.flags, 'dry-run': opts.dryRun, request: opts.request ?? '' } };
  const r = await t.run(ctx, input, opts.flags.output as string | undefined);
  const failed = r.validations.filter((v) => !v.passed);
  return result(kind, {
    status: r.ok && !failed.length ? (opts.dryRun ? 'dry_run' : 'done') : 'error',
    summary: `${t.id}: ${r.outputs.length} output(s)${r.lossy.length ? `, ${r.lossy.length} limitation(s) recorded` : ''}${failed.length ? `, ${failed.length} validation(s) FAILED` : ', validations passed'}.`,
    data: { transformer: t.id, outputs: r.outputs.map((o) => rel(opts.cwd, o)), validations: r.validations, lossy: r.lossy, details: r.details },
    warnings: [...warnings, ...r.warnings], exitCode: failed.length ? 2 : 0,
  });
}

// ───────────────────────── examples ─────────────────────────
export async function opExamples(opts: OpOptions): Promise<OpResult> {
  const vaultDir = vaultFor(opts);
  const r = generateExample({
    vaultDir, cwd: opts.cwd, project: opts.flags.project as string | undefined, goal: (opts.flags.goal as string | undefined) ?? opts.request, kind: opts.flags.kind as 'snippet' | 'app' | undefined,
    output: opts.flags.output as string | undefined, answers: opts.answers, validate: opts.flags.validate === true, dryRun: opts.dryRun, force: opts.flags.force === true,
  });
  if (r.status === 'needs_input') return needsInput('examples', r.questions, 'Example requirements needed.');
  const passed = r.validation.filter((v) => v.ran && v.passed).map((v) => v.step);
  const failedCheck = r.validation.some((v) => v.ran && !v.passed);
  return result('examples', {
    summary: `Example written to ${rel(opts.cwd, r.outDir!)} using ${r.usedSymbols.length} documented symbol(s). ${r.validated ? `Validated: ${passed.join(', ')}.` : `NOT validated${failedCheck ? ' (a check failed)' : passed.length ? ` (only ${passed.join(', ')} ran)` : ''}.`}`,
    data: { ...r, outDir: rel(opts.cwd, r.outDir!) }, warnings: r.notes, exitCode: r.validation.some((v) => v.ran && v.passed === false) ? 2 : 0,
  });
}

// ───────────────────────── capabilities ─────────────────────────
export async function opCapabilities(opts: OpOptions): Promise<OpResult> {
  const loaded = loadConfig(opts.cwd, opts.config);
  let vaultDir: string | undefined;
  try {
    vaultDir = vaultFor(opts, false);
  } catch {
    vaultDir = undefined;
  }
  const m = vaultDir && fs.existsSync(vgPaths(vaultDir).manifest) ? loadManifest(vaultDir) : undefined;
  const plugins = await loadPlugins(path.dirname(loaded.file ?? path.join(opts.cwd, 'x')), loaded.config.plugins, m?.trustedPlugins ?? {});
  let sqliteOk = false;
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61 remove_diacritics 2')");
    db.close();
    sqliteOk = true;
  } catch {
    sqliteOk = false;
  }
  const vendor = readJsonFile<unknown[]>(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'vendor', 'vendor.json')) ?? [];
  return result('capabilities', {
    summary: `vault-generator ${TOOL_VERSION} on Node ${process.versions.node}: ${BUILTIN_ANALYZERS.length + plugins.analyzers.length} analyzer(s), ${BUILTIN_TRANSFORMERS.length + plugins.transformers.length} transformer(s), search index ${sqliteOk ? 'available (SQLite FTS5)' : 'UNAVAILABLE'}.`,
    data: {
      version: TOOL_VERSION, node: process.versions.node, platform: process.platform, sqliteFts5: sqliteOk, vendored: vendor,
      analyzers: [...plugins.analyzers.map((a) => ({ ...pick(a), plugin: true })), ...BUILTIN_ANALYZERS.map((a) => pick(a))],
      transformers: [...plugins.transformers, ...BUILTIN_TRANSFORMERS].map((t) => ({ id: t.id, version: t.version, kind: t.kind, description: t.description, inputs: t.inputs, outputs: t.outputs, requires: t.requires, dependencies: t.dependencies, capabilities: t.capabilities, validations: t.validations, limitations: t.limitations, updatePolicy: t.updatePolicy })),
      plugins: { configured: loaded.config.plugins, untrusted: plugins.untrusted, errors: plugins.errors },
      notImplemented: [
        'PDF / DOCX / PPTX extraction (files are listed as unsupported, never silently dropped)',
        'Semantic retrieval with embeddings (lexical BM25 + symbols + relations only)',
        'Compiler-grade code analysis (TypeScript compiler API, Roslyn, etc.)',
        'Fetching remote sources or external $ref files',
        'Example scaffolding for ecosystems other than Node.js and Python',
      ],
    },
  });
}
const pick = (a: { id: string; version: string; description: string; handles: string[]; limitations: string[] }) => ({ id: a.id, version: a.version, description: a.description, handles: a.handles, limitations: a.limitations });

// ───────────────────────── validate-skill ─────────────────────────
export async function opValidateSkill(opts: OpOptions): Promise<OpResult> {
  const dir = path.resolve(opts.cwd, String(opts.flags['skill-dir'] ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')));
  const r = validateSkillDir(dir);
  return result('validate-skill', { status: r.ok ? 'done' : 'error', summary: `${r.ok ? 'Valid' : 'Invalid'} Agent Skill at ${rel(opts.cwd, dir)}: ${r.errors.length} error(s), ${r.warnings.length} warning(s).`, data: { ...r }, exitCode: r.ok ? 0 : 2 });
}

// ───────────────────────── help / intent ─────────────────────────
export function resolveMode(opts: OpOptions): { mode: string; note?: string } {
  if (opts.mode) return { mode: opts.mode };
  let hasManifest = false;
  try {
    hasManifest = fs.existsSync(vgPaths(vaultFor(opts, false)).manifest);
  } catch {
    hasManifest = false;
  }
  const intent = detectIntent(opts.request, hasManifest);
  if (intent.text && intent.text !== opts.request) opts.request = intent.text;
  return { mode: intent.mode, note: intent.confidence === 'explicit' ? undefined : `mode "${intent.mode}" inferred from the request${intent.alternatives.length ? ` (other candidates: ${intent.alternatives.join(', ')})` : ''}` };
}
