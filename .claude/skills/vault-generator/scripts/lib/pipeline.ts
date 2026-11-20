// Shared pipeline for analyze / generate / sync: resolve sources → detect context → decide scope and
// destination (asking when ambiguous) → scan → analyze → model → plan → reconcile → index.
import fs from 'node:fs';
import path from 'node:path';
import type { Analyzer, Config, ContextReport, Decision, FileInfo, Manifest, OpOptions, ProjectInfo, Question, SkipRecord, SourceInfo } from './types.ts';
import type { Analysis, Model } from './model.ts';
import { buildModel, projectKey, relationDecisionId } from './model.ts';
import { detectContext, rootManifestName, selectProjects, withInternalDeps } from './detect.ts';
import { readSourceText, scanSource } from './scan.ts';
import { BUILTIN_ANALYZERS, loadPlugins, pickAnalyzer } from './analyzers/index.ts';
import { planVault, type Plan } from './planner.ts';
import { applyPlan, type ApplyResult, type ConflictPolicy } from './apply.ts';
import { updateIndex } from './index-db.ts';
import { Writer } from './fsutil.ts';
import {
  contentHashOf, emptyState, findVault, loadLocal, loadManifest, loadState, newManifest, noteIdFor, pruneBackups, recordDecision, relFromVault, resolveSourcePath,
  RunJournal, saveAll, scopeIdFor, sourceIdFor, vgPaths, type State,
} from './state.ts';
import { loadConfig } from './config.ts';
import { isInside } from './safety.ts';
import { readVault } from './vault.ts';
import { guessLanguage, posixBase, runId as newRunId, sha256, slugify, toPosix, uniq, VgError } from './util.ts';
import { contractSignature, isOpenApi, readApiModel } from './analyzers/openapi.ts';
import { parseJson, parseYaml } from './yaml.ts';

export interface Prepared {
  cwd: string;
  config: Config;
  configFile?: string;
  sources: SourceInfo[];
  reports: Record<string, ContextReport>;
  vaultDir: string;
  vaultExists: boolean;
  manifest?: Manifest;
  decisions: Record<string, Decision>;
  questions: Question[];
  selection: { mode: 'all' | 'projects'; keys: Set<string>; added: string[] };
  language: 'en' | 'es';
  depth: Config['depth'];
  placement: 'root' | 'subfolder';
  baseFolder: string;
  notes: string[];
  /** decisions applied by default in this run (recorded as assumed) */
  assumed: Record<string, string>;
}

const DEFAULT_VAULT_DIR = 'knowledge-vault';

function labelFor(abs: string): string {
  return posixBase(toPosix(abs)) || 'root';
}

/** Resolve user-provided source paths (cwd when none) into SourceInfo records. */
export function resolveSources(cwd: string, paths: string[], manifest?: Manifest, vaultDir?: string): { sources: SourceInfo[]; errors: string[] } {
  const errors: string[] = [];
  const taken = new Set<string>();
  const out: SourceInfo[] = [];
  if (!paths.length && manifest && vaultDir) {
    const local = loadLocal(vaultDir);
    for (const s of manifest.sources) {
      const abs = resolveSourcePath(vaultDir, s.path, s.id, local);
      if (!abs || !fs.existsSync(abs)) {
        errors.push(`source "${s.label}" (${s.path ?? 'local binding'}) is not available on this machine; bind it with --source`);
        continue;
      }
      taken.add(s.id);
      out.push({ id: s.id, root: fs.realpathSync.native(abs), rel: s.path ?? '', label: s.label, kind: s.kind, projects: s.projects, only: s.only });
    }
    return { sources: out, errors };
  }
  const list = paths.length ? paths : ['.'];
  for (const p of list) {
    const abs = path.resolve(cwd, p);
    if (!fs.existsSync(abs)) {
      errors.push(`source not found: ${p}`);
      continue;
    }
    const st = fs.statSync(abs);
    const root = st.isDirectory() ? fs.realpathSync.native(abs) : fs.realpathSync.native(path.dirname(abs));
    // the declared manifest name keeps ids reproducible even if the folder is renamed or cloned elsewhere
    const label = st.isDirectory() ? rootManifestName(root) ?? labelFor(root) : posixBase(toPosix(abs)).replace(/\.[^.]+$/, '');
    const existing = manifest?.sources.find((s) => s.label === label);
    const id = existing && !taken.has(existing.id) ? (taken.add(existing.id), existing.id) : sourceIdFor(label, taken);
    out.push({ id, root, rel: '', label, kind: fs.existsSync(path.join(root, '.git')) ? 'repo' : 'dir', projects: [], only: st.isDirectory() ? undefined : [posixBase(toPosix(abs))] });
  }
  // nested duplicates (a source inside another) are ambiguous: keep the outer one and report
  for (const s of [...out]) {
    const outer = out.find((o) => o !== s && isInside(o.root, s.root));
    if (outer && !s.only) {
      errors.push(`source "${s.label}" is inside "${outer.label}"; it is analysed as part of it`);
      out.splice(out.indexOf(s), 1);
    }
  }
  return { sources: out, errors };
}

export function prepare(opts: OpOptions, mode: 'analyze' | 'generate' | 'sync'): Prepared {
  const cwd = path.resolve(opts.cwd);
  const loaded = loadConfig(cwd, opts.config);
  const config = loaded.config;
  if (loaded.errors.length) throw new VgError('E_CONFIG', `Invalid configuration (${loaded.file}): ${loaded.errors.join('; ')}`);
  if (opts.depth) config.depth = opts.depth;
  const notes: string[] = [];

  // vault location: explicit → config → manifest found in cwd / below cwd
  const explicitVault = opts.vault ?? loaded.extra.vault;
  let vaultGuess = findVault(cwd, explicitVault);
  if (!vaultGuess) {
    const rep = detectContext(cwd, config, { maxDepth: 4, checkParents: false });
    const managed = rep.vaults.filter((v) => v.hasManifest).map((v) => v.path);
    vaultGuess = findVault(cwd, undefined, managed);
    if (!vaultGuess && managed.length > 1 && mode !== 'analyze') {
      throw new VgError('E_AMBIGUOUS_VAULT', `Several generated vaults found (${managed.join(', ')}); pass --vault <dir>`);
    }
  }
  const manifest = vaultGuess?.managed ? loadManifest(vaultGuess.dir) : undefined;
  const decisions: Record<string, Decision> = { ...(manifest?.decisions ?? {}) };
  for (const [k, v] of Object.entries(opts.answers)) decisions[k] = { answer: v, answeredAt: new Date().toISOString() };

  // sources
  const srcPaths = opts.sources.length ? opts.sources : loaded.extra.sources ?? [];
  const { sources, errors } = resolveSources(cwd, srcPaths, srcPaths.length ? undefined : manifest, vaultGuess?.dir);
  if (!sources.length) throw new VgError('E_SOURCES', errors.join('; ') || 'no sources to analyse');
  notes.push(...errors);
  if (mode === 'sync' && !manifest) throw new VgError('E_NO_VAULT', 'No vault-generator manifest found. Run --mode generate first (or pass --vault).');

  const vaultDirDefault = vaultGuess?.dir ?? path.join(sources.length === 1 && !sources[0].only ? sources[0].root : cwd, DEFAULT_VAULT_DIR);
  const vaultDir = path.resolve(explicitVault ? path.resolve(cwd, explicitVault) : vaultDirDefault);
  const excludeAbs = [vaultDir];

  // context detection per source
  const reports: Record<string, ContextReport> = {};
  for (const s of sources) {
    const rep = detectContext(s.root, config, { excludeAbs });
    if (s.only) {
      rep.projects = [];
      rep.kind = 'docs-only';
    }
    reports[s.id] = rep;
    s.projects = rep.projects.map((p) => p.id);
    if (rep.kind === 'docs-only') s.kind = 'docs';
    if (rep.kind === 'existing-vault') s.kind = 'vault';
  }

  const questions: Question[] = [];
  const assumed: Record<string, string> = {};
  const answer = (id: string) => decisions[id]?.answer;

  // ── destination ──
  const isExistingUnmanaged = fs.existsSync(vaultDir) && !fs.existsSync(vgPaths(vaultDir).manifest) && fs.readdirSync(vaultDir).length > 0;
  let placement: 'root' | 'subfolder' = manifest?.vault.placement ?? 'root';
  let baseFolder = manifest?.vault.folder ?? '';
  if (!manifest && mode !== 'analyze') {
    if (!explicitVault && !answer('destination')) {
      questions.push({
        id: 'destination', kind: 'destination', blocking: true, freeText: true,
        prompt: `Where should the vault be created? Proposed: ${toPosix(path.relative(cwd, vaultDir)) || '.'}`,
        why: 'Writing a new directory is a decision only you can make. Answer "default" to accept the proposal or give a path.',
        options: [{ value: 'default', label: `${toPosix(path.relative(cwd, vaultDir)) || '.'} (proposed)` }],
        default: 'default',
      });
    }
    if (isExistingUnmanaged) {
      const v = answer('vault-placement');
      if (!v) {
        questions.push({
          id: 'vault-placement', kind: 'existing-vault', blocking: true,
          prompt: `"${toPosix(path.relative(cwd, vaultDir)) || '.'}" already contains files that were not generated by vault-generator. How should generated notes coexist with them?`,
          why: 'Your existing notes are never modified, but generated notes need a place that does not collide with them.',
          options: [
            { value: 'subfolder', label: 'Generate inside a subfolder (vault-generator/)', consequence: 'Existing notes untouched; generated notes isolated' },
            { value: 'root', label: 'Generate at the vault root next to existing notes', consequence: 'Name collisions get a numeric suffix; existing notes untouched' },
            { value: 'cancel', label: 'Cancel' },
          ],
          default: 'subfolder',
        });
      } else if (v === 'cancel') throw new VgError('E_CANCELLED', 'Cancelled by user decision (vault-placement=cancel)');
      else {
        placement = v === 'root' ? 'root' : 'subfolder';
        baseFolder = placement === 'subfolder' ? 'vault-generator' : '';
      }
    }
  }
  const dest = answer('destination');
  if (dest && dest !== 'default' && !explicitVault && !manifest) {
    const p = path.resolve(cwd, dest);
    if (p !== vaultDir) return prepare({ ...opts, vault: dest }, mode);
  }
  for (const s of sources) {
    if (!s.only && path.resolve(vaultDir) === path.resolve(s.root)) {
      throw new VgError('E_DEST', 'The vault cannot be the same directory as a source. Choose another --vault (to work on an existing vault use --mode index, validate or reorganize).');
    }
  }

  // ── scope ──
  const scopeTokens = opts.scope.length ? opts.scope : loaded.extra.scope ?? [];
  const allProjects = sources.flatMap((s) => reports[s.id].projects.map((p) => ({ s, p })));
  let selection: Prepared['selection'] = { mode: 'all', keys: new Set(), added: [] };
  const previousScope = manifest?.scopeSelection;
  if (scopeTokens.length) {
    const keys = new Set<string>();
    const unknown: string[] = [];
    for (const s of sources) {
      const { selected, unknown: u } = selectProjects(reports[s.id], scopeTokens);
      unknown.push(...u.filter((x) => !allProjects.some((ap) => ap.p.id === x || ap.p.name === x || ap.p.path === x)));
      const withDeps = answer('scope-deps') === 'exclude' ? { projects: selected, added: [] } : withInternalDeps(reports[s.id], selected);
      for (const p of withDeps.projects) keys.add(projectKey(s.id, p));
      selection.added.push(...withDeps.added);
    }
    const reallyUnknown = uniq(unknown).filter((tkn) => !sources.some((s) => reports[s.id].projects.some((p) => p.id === tkn || p.name === tkn || p.path === tkn || p.path.startsWith(`${tkn}/`))));
    if (reallyUnknown.length) throw new VgError('E_SCOPE', `Unknown project(s) in --scope: ${reallyUnknown.join(', ')}. Known: ${allProjects.map((x) => x.p.id).join(', ')}`);
    selection = { mode: 'projects', keys, added: uniq(selection.added) };
    if (selection.added.length && !answer('scope-deps')) notes.push(`internal dependencies added to the scope: ${selection.added.join(', ')} (answer scope-deps=exclude to leave them as overview only)`);
  } else if (previousScope && previousScope.mode === 'projects' && previousScope.projects.length) {
    selection = { mode: 'projects', keys: new Set(previousScope.projects), added: [] };
  } else if (mode !== 'analyze') {
    const scopeAns = answer('scope');
    const codeProjects = allProjects.filter((x) => x.p.kind !== 'docs');
    const rep0 = reports[sources[0].id];
    const ambiguousStructure = sources.length === 1 && (rep0.kind === 'mixed' || (rep0.kind === 'multi-repo-workspace' && rep0.confidence < 0.8));
    if (!manifest && !scopeAns && (codeProjects.length > 12 || ambiguousStructure)) {
      questions.push({
        id: 'scope', kind: 'scope', blocking: true, freeText: true,
        prompt: ambiguousStructure
          ? `The directory contains ${codeProjects.length} projects that do not share a workspace configuration (${rep0.ambiguities[0] ?? rep0.kind}). What should be documented?`
          : `The workspace contains ${codeProjects.length} projects. Generate all of them or a subset?`,
        why: 'Generating unrelated projects into one vault mixes knowledge bases; a subset keeps the vault focused.',
        options: [
          { value: 'all', label: `All ${codeProjects.length} projects in one vault` },
          ...codeProjects.slice(0, 6).map((x) => ({ value: x.p.id, label: `${x.p.name} (${x.p.kind}, ${x.p.path})` })),
        ],
        multi: true,
        default: 'all',
      });
    } else if (scopeAns && scopeAns !== 'all') {
      const tokens = scopeAns.split(',').map((s) => s.trim()).filter(Boolean);
      return prepare({ ...opts, scope: tokens }, mode);
    }
  }
  // parent workspace notice: running inside a package of a bigger workspace
  for (const s of sources) {
    const pw = reports[s.id].parentWorkspace;
    if (pw && !manifest && mode !== 'analyze' && !answer('parent-workspace') && !scopeTokens.length) {
      questions.push({
        id: 'parent-workspace', kind: 'scope', blocking: true,
        prompt: `"${s.label}" is part of a ${pw.tool} workspace rooted at ${pw.path}. Document only "${s.label}" or the whole workspace?`,
        why: 'Running inside one package of a workspace usually means a partial scope, but cross-package relations would be missing.',
        options: [
          { value: 'this', label: `Only ${s.label}` },
          { value: 'workspace', label: `The whole workspace (${pw.path})`, consequence: 're-run from the workspace root with --scope to narrow it' },
        ],
        default: 'this',
      });
    } else if (pw && answer('parent-workspace') === 'workspace' && mode !== 'analyze') {
      throw new VgError('E_RERUN', `Re-run from the workspace root: cd ${pw.path} && vg --mode ${mode}${scopeTokens.length ? ` --scope ${scopeTokens.join(',')}` : ''}`);
    }
  }

  // ── language ──
  let language: 'en' | 'es' = opts.language ?? manifest?.language ?? (loaded.file ? config.language : 'en');
  if (!opts.language && !manifest && !loaded.file) {
    const samples: string[] = [];
    for (const s of sources)
      for (const f of ['README.md', 'readme.md', 'docs/README.md', 'docs/index.md']) {
        const p = path.join(s.root, f);
        if (fs.existsSync(p)) samples.push(fs.readFileSync(p, 'utf8').slice(0, 6000));
      }
    language = guessLanguage(samples) ?? 'en';
    if (decisions.language) language = decisions.language.answer === 'es' ? 'es' : 'en';
  }
  config.language = language;

  return {
    cwd, config, configFile: loaded.file, sources, reports, vaultDir, vaultExists: fs.existsSync(vaultDir), manifest, decisions, questions, selection, language,
    depth: config.depth, placement, baseFolder, notes, assumed,
  };
}

export interface ScanAll {
  files: FileInfo[];
  skipped: SkipRecord[];
  ignoredDirs: number;
}
export function scanAll(prep: Prepared, previous?: State['files']): ScanAll {
  const files: FileInfo[] = [];
  const skipped: SkipRecord[] = [];
  let ignoredDirs = 0;
  for (const s of prep.sources) {
    const r = scanSource(s, { config: prep.config, excludeAbs: [prep.vaultDir], previous });
    files.push(...r.files);
    skipped.push(...r.skipped);
    ignoredDirs += r.ignoredDirs;
  }
  return { files, skipped, ignoredDirs };
}

export function analyzeFiles(prep: Prepared, files: FileInfo[], analyzers: Analyzer[]): { analyses: Analysis[]; errors: string[] } {
  const analyses: Analysis[] = [];
  const errors: string[] = [];
  const byId = new Map(prep.sources.map((s) => [s.id, s]));
  for (const f of files) {
    if (f.format === 'image' || f.format === 'unsupported' || f.format === 'other' || f.format === 'xml') continue;
    const source = byId.get(f.source)!;
    let head = '';
    try {
      head = readSourceText(f).slice(0, 4096);
    } catch {
      errors.push(`${f.source}:${f.path}: unreadable`);
      continue;
    }
    const a = pickAnalyzer(analyzers, f, head);
    if (!a) continue;
    try {
      const result = a.analyze(f, {
        source, config: prep.config,
        read: (file) => readSourceText(file),
        exists: (rel) => fs.existsSync(path.join(source.root, rel)),
      });
      analyses.push({ file: f, analyzer: a.id, result });
    } catch (e) {
      errors.push(`${f.source}:${f.path}: analyzer ${a.id} failed: ${(e as Error).message}`);
    }
  }
  return { analyses, errors };
}

/** Questions that depend on the analysed content (restricted docs, contradictions, versions, relations). */
export function contentQuestions(prep: Prepared, files: FileInfo[], model: Model | undefined, mode: string): Question[] {
  const qs: Question[] = [];
  const answer = (id: string) => prep.decisions[id]?.answer;
  const marked = files.filter((f) => f.restrictedBy === 'marker');
  if (marked.length && !answer('restricted-docs')) {
    qs.push({
      id: 'restricted-docs', kind: 'security', blocking: true,
      prompt: `${marked.length} document(s) look restricted (private/confidential markers), e.g. ${marked.slice(0, 3).map((f) => f.path).join(', ')}. Include them?`,
      why: 'Access metadata alone is not a security mechanism; you decide whether this content may enter the vault.',
      options: [
        { value: 'exclude', label: 'Exclude them (recommended)', consequence: 'not read into the vault; listed in Open questions' },
        { value: 'restricted', label: 'Include, marked restricted', consequence: 'hidden from search/context/export unless --include-restricted' },
        { value: 'public', label: 'Include as normal documents' },
      ],
      default: 'exclude',
    });
  }
  if (!model) return qs;
  const pending = model.contradictions.filter((c) => !answer(c.id));
  if (pending.length) {
    qs.push(
      ...pending.slice(0, 5).map((c): Question => ({
        id: c.id, kind: 'contradiction', blocking: false, group: 'contradictions',
        prompt: `Contradiction: ${c.detail}`,
        why: 'Sources disagree; the vault records both claims and flags the notes until you choose.',
        options: [
          ...uniq(c.claims.map((cl) => `${cl.value} (${cl.ref.path})`)).map((v) => ({ value: v, label: v })),
          { value: 'keep-both', label: 'Keep both, mark notes for review' },
        ],
        default: 'keep-both',
        freeText: true,
      })),
    );
  }
  if (model.docVersions.length > 1 && !answer('default-version')) {
    qs.push({
      id: 'default-version', kind: 'version', blocking: false,
      prompt: `Documentation exists for versions ${model.docVersions.join(', ')}. Which one is the default for search and context?`,
      why: 'Answers about APIs and behaviour depend on the version; other versions stay searchable with --version.',
      options: [...model.docVersions.slice().reverse().map((v, i) => ({ value: v, label: i === 0 ? `${v} (latest)` : v }))],
      default: model.docVersions[model.docVersions.length - 1],
    });
  }
  const inferredCross = model.relations.filter((r) => r.status === 'inferred' && (r.type === 'consumes' || r.type === 'implements') && !answer(relationDecisionId(r)));
  if (inferredCross.length && mode !== 'analyze') {
    for (const r of inferredCross.slice(0, 4)) {
      qs.push({
        id: relationDecisionId(r), kind: 'relation', blocking: false, group: 'relations',
        prompt: `Possible relation: ${labelOf(model, r.from)} ${r.type} ${labelOf(model, r.to)} — ${r.evidence[0].note}. Is it real?`,
        why: 'The relation is derived from a pattern match, not declared by any source. Until confirmed it is listed as "possible" and not used as a fact.',
        options: [
          { value: 'confirm', label: 'Confirm' },
          { value: 'reject', label: 'Reject' },
          { value: 'later', label: 'Decide later' },
        ],
        default: 'later',
      });
    }
  }
  return qs;
}

/** Human label for a model key (project name, API title, project/module path) used in questions. */
export function labelOf(model: Model, key: string): string {
  const p = model.projects.find((x) => x.key === key);
  if (p) return `"${p.name}"`;
  const a = model.apis.find((x) => x.unit.key === key) ?? model.docs.find((x) => x.unit.key === key);
  if (a) return `"${a.unit.title}"`;
  const m = model.modules.find((x) => x.key === key);
  if (m) return `"${model.projects.find((x) => x.key === m.project)?.name ?? m.source}/${m.rel || '.'}"`;
  return key.replace(/^\w+:[^:]+:/, '');
}

export interface RunOutcome {
  status: 'done' | 'needs_input' | 'dry_run';
  prep: Prepared;
  model?: Model;
  plan?: Plan;
  apply?: ApplyResult;
  questions: Question[];
  index?: ReturnType<typeof updateIndex>;
  runId: string;
  scan?: ScanAll;
  warnings: string[];
  contracts?: { changed: string[]; added: string[]; removed: string[] };
  structural?: string[];
  backupsPruned?: number;
  writes: number;
}

/** Full generate / sync run. */
export async function runGenerate(opts: OpOptions, mode: 'generate' | 'sync'): Promise<RunOutcome> {
  const prep = prepare(opts, mode);
  const warnings: string[] = [...prep.notes];
  const runId = newRunId();
  const blockingEarly = prep.questions.filter((q) => q.blocking);
  if (blockingEarly.length) return { status: 'needs_input', prep, questions: prep.questions, runId, warnings, writes: 0 };

  const paths = vgPaths(prep.vaultDir);
  const state = prep.manifest ? loadState(prep.vaultDir) : emptyState();
  const scan = scanAll(prep, state.files);
  const restrictedAns = prep.decisions['restricted-docs']?.answer as 'exclude' | 'restricted' | 'public' | undefined;
  const preQs = contentQuestions(prep, scan.files, undefined, mode).filter((q) => q.blocking);
  if (preQs.length) return { status: 'needs_input', prep, questions: [...prep.questions, ...preQs], runId, warnings, scan, writes: 0 };

  // plugins (only trusted ones)
  const trusted = prep.manifest?.trustedPlugins ?? {};
  const plugins = await loadPlugins(path.dirname(prep.configFile ?? path.join(prep.cwd, 'x')), prep.config.plugins, trusted, opts.flags['trust-plugins'] === true);
  warnings.push(...plugins.errors);
  if (plugins.untrusted.length) warnings.push(`untrusted plugin(s) not loaded: ${plugins.untrusted.join(', ')} (review the code, then re-run with --trust-plugins)`);
  const analyzers = [...plugins.analyzers, ...BUILTIN_ANALYZERS];
  const { analyses, errors } = analyzeFiles(prep, scan.files, analyzers);
  warnings.push(...errors);

  const rootScripts: Record<string, Record<string, string>> = {};
  for (const s of prep.sources) {
    const pj = path.join(s.root, 'package.json');
    if (fs.existsSync(pj)) {
      const j = parseJson(fs.readFileSync(pj, 'utf8')).value as { scripts?: Record<string, string> } | undefined;
      if (j?.scripts) rootScripts[s.id] = j.scripts;
    }
  }
  const model = buildModel({
    config: prep.config, sources: prep.sources, reports: prep.reports, selected: prep.selection.keys, scopeMode: prep.selection.mode, files: scan.files,
    skipped: scan.skipped, analyses, decisions: prep.decisions, includeRestricted: restrictedAns ?? 'exclude', rootScripts,
  });
  const questions = [...prep.questions, ...contentQuestions(prep, scan.files, model, mode)];

  // ids: stable per scope; renamed sources keep their id when content is identical
  const labels = prep.sources.map((s) => s.label);
  const scopeId = prep.manifest?.scopeId ?? scopeIdFor(labels);
  const renamed = detectRenames(state, scan.files);
  const idOf = (key: string) => state.keys[key] ?? (renamed[key] ? state.keys[renamed[key]] : undefined) ?? noteIdFor(scopeId, key);
  const existingHubs = new Set(Object.values(state.notes).map((n) => n.key).filter((k) => k.startsWith('hub:')));
  const plan = planVault(model, {
    language: prep.language, depth: prep.depth, maxNoteChars: prep.config.layout.maxNoteChars, folderThreshold: prep.config.layout.folderThreshold,
    idOf, decisions: prep.decisions, baseFolder: prep.baseFolder, copyAttachments: prep.config.attachments.copy, keepHubs: existingHubs,
  });
  for (const [newKey, oldKey] of Object.entries(renamed)) if (state.keys[oldKey]) state.keys[newKey] = state.keys[oldKey];

  // contract & structural changes since last run (sync report)
  const contracts = diffContracts(state, model);
  const structural = diffStructure(state, model);

  const dryRun = opts.dryRun;
  const writer = new Writer([prep.vaultDir], dryRun);
  const journal = new RunJournal(paths, writer, runId);
  const manifest = prep.manifest ?? newManifest({ name: model.name, scopeId, language: prep.language, depth: prep.depth, placement: prep.placement, folder: prep.baseFolder, workspaceRoot: relFromVault(prep.vaultDir, prep.cwd) ?? '.' });
  for (const [k, v] of Object.entries(opts.answers)) recordDecision(manifest, k, v, questions.find((q) => q.id === k)?.prompt);
  // non-blocking questions: defaults are applied and recorded as assumed (the user can change them later)
  for (const q of questions.filter((qq) => !qq.blocking && !prep.decisions[qq.id] && qq.default && qq.kind === 'version')) {
    recordDecision(manifest, q.id, q.default!, q.prompt, true);
    prep.assumed[q.id] = q.default!;
  }
  const keyIsOutOfScope = (key: string) => {
    if (prep.selection.mode === 'all') return false;
    const m = /^(?:project|module):([^:]+):(.+)$/.exec(key);
    if (!m) return false;
    return !model.projects.some((p) => p.source === m[1] && (p.path === m[2] || m[2].startsWith(`${p.path}/`) || p.path === '.'));
  };
  const fileKeys = new Set(scan.files.map((f) => `${f.source}:${f.path}`));
  const plannedKeys = new Set(plan.notes.map((n) => n.key));
  const moduleDirs = new Set(scan.files.map((f) => `${f.source}:${f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.'}`));
  /** true = the note is not planned for another reason (scope, dedupe, folding) but its source still exists: leave it untouched */
  const sourceExists = (key: string) => {
    const part = /^(doc:[^:]+:.+?)#part-\d+$/.exec(key);
    if (part) return !plannedKeys.has(part[1]) && fileKeys.has(part[1].slice(4));
    const m = /^(?:doc|api|config):([^:]+):(.+)$/.exec(key);
    if (m) return fileKeys.has(`${m[1]}:${m[2]}`);
    const mod = /^module:([^:]+):(.+)$/.exec(key);
    if (mod) return moduleDirs.has(`${mod[1]}:${mod[2]}`);
    const proj = /^project:([^:]+):(.+)$/.exec(key);
    if (proj) return prep.reports[proj[1]]?.projects.some((p) => p.path === proj[2]) ?? false;
    return false;
  };
  const policy = (opts.flags['on-conflict'] as ConflictPolicy | undefined) ?? 'save-both';
  const resolutions: Record<string, string> = {};
  for (const [k, v] of Object.entries(prep.decisions)) if (k.startsWith('conflict:')) resolutions[k.slice(9)] = v.answer;
  if (!dryRun) writer.mkdir(prep.vaultDir);
  const apply = applyPlan({
    plan, paths, manifest, state, writer, journal, runId, language: prep.language,
    sourceRoots: Object.fromEntries(prep.sources.map((s) => [s.id, s.root])), conflictPolicy: policy, resolutions,
    pruneStale: opts.flags['prune-stale'] === true, outOfScope: keyIsOutOfScope, sourceExists,
  });

  // manifest
  manifest.name = model.name;
  manifest.language = prep.language;
  manifest.depth = prep.depth;
  manifest.vault = { placement: prep.placement, folder: prep.baseFolder };
  const local = loadLocal(prep.vaultDir);
  manifest.sources = prep.sources.map((s) => {
    const rel = relFromVault(prep.vaultDir, s.root);
    if (rel === null) local.sources[s.id] = s.root;
    return { id: s.id, path: rel, label: s.label, kind: s.kind, projects: s.projects, ...(s.only ? { only: s.only } : {}) };
  });
  manifest.context = {
    kind: model.kind,
    tools: uniq(prep.sources.flatMap((s) => prep.reports[s.id].workspaces.map((w) => w.tool))),
    repositories: uniq(prep.sources.flatMap((s) => prep.reports[s.id].repositories.map((r) => `${s.id}:${r.path}`))),
    projects: model.projects.map((p) => ({ id: p.id, name: p.name, path: `${p.source}:${p.path}`, kind: p.kind, ecosystem: p.ecosystem, version: p.version, technologies: uniq(p.frameworks.map((f) => f.name)) })),
    docSources: prep.sources.flatMap((s) => prep.reports[s.id].docSources.map((d) => ({ ...d, path: `${s.id}:${d.path}` }))),
    relations: model.relations.filter((r) => r.from.startsWith('project:') && r.to.startsWith('project:')).map((r) => ({ type: r.type, from: r.from, to: r.to, status: r.status })),
    technologies: Object.fromEntries(Object.entries(model.technologies).map(([k, v]) => [k, v.versions.join(', ')])),
    versions: [...prep.sources.flatMap((s) => prep.reports[s.id].versionMismatches.map((m) => ({ subject: m.subject, values: uniq(m.values.map((v) => `${v.value} (${v.path})`)) }))), ...(model.docVersions.length ? [{ subject: 'documentation', values: model.docVersions }] : [])],
  };
  manifest.scopeSelection = { mode: prep.selection.mode, projects: [...prep.selection.keys].sort() };
  manifest.layout = plan.layout;
  manifest.transformers = uniq(['markdown', ...analyses.map((a) => a.analyzer)]).sort();
  if (opts.flags['trust-plugins'] === true) manifest.trustedPlugins = { ...manifest.trustedPlugins, ...plugins.hashes };
  manifest.sync = { strategy: 'hash+mtime', lastRunId: runId };

  // state: file hashes, contracts, projects
  state.files = Object.fromEntries(scan.files.filter((f) => f.hash).map((f) => [`${f.source}:${f.path}`, { hash: f.hash, size: f.size, mtimeMs: f.mtimeMs }]));
  state.contracts = currentContracts(model);
  state.projects = Object.fromEntries(model.projects.map((p) => [p.key, { name: p.name, kind: p.kind, deps: model.relations.filter((r) => r.type === 'depends-on' && r.from === p.key).map((r) => r.to).sort() }]));
  state.runs = [...state.runs, { id: runId, mode, at: new Date().toISOString(), summary: apply.counts }].slice(-50);

  let index: RunOutcome['index'];
  let backupsPruned = 0;
  if (!dryRun) {
    journal.save(mode);
    backupsPruned = pruneBackups(paths, writer, prep.config.retention.backupRuns);
    saveAll(writer, paths, manifest, state, local);
    index = updateIndex(paths.index, readVault(prep.vaultDir));
    manifest.indexing = { engine: 'sqlite-fts5', notes: index.notes, contentHash: index.contentHash };
    writer.writeJson(paths.manifest, manifest);
  }
  return {
    status: dryRun ? 'dry_run' : 'done', prep, model, plan, apply, questions, index, runId, scan, warnings, contracts, structural, backupsPruned,
    writes: writer.log.filter((l) => l.action === 'write' || l.action === 'copy' || l.action === 'move').length,
  };
}

/** A doc whose path changed but whose content hash is identical keeps its id (rename/move detection). */
function detectRenames(state: State, files: FileInfo[]): Record<string, string> {
  const out: Record<string, string> = {};
  const byHash = new Map<string, string[]>();
  for (const [k, v] of Object.entries(state.files)) if (v.hash) byHash.set(v.hash, [...(byHash.get(v.hash) ?? []), k]);
  const current = new Set(files.map((f) => `${f.source}:${f.path}`));
  for (const f of files) {
    const k = `${f.source}:${f.path}`;
    if (state.files[k] || !f.hash) continue;
    const olds = (byHash.get(f.hash) ?? []).filter((o) => !current.has(o));
    if (olds.length !== 1) continue;
    for (const prefix of ['doc', 'api', 'config']) out[`${prefix}:${k}`] = `${prefix}:${olds[0]}`;
  }
  return out;
}

function currentContracts(model: Model): State['contracts'] {
  const out: State['contracts'] = {};
  for (const a of model.apis) out[a.unit.key] = (a.entity.attrs.contract as Record<string, string>) ?? {};
  for (const m of model.modules) {
    const sig: Record<string, string> = {};
    for (const s of m.symbols) sig[`${s.sym.kind} ${s.sym.name}`] = sha256(`${s.sym.signature}|${(s.sym.members ?? []).map((x) => x.signature).join('|')}`).slice(0, 12);
    out[m.key] = sig;
  }
  return out;
}
function diffContracts(state: State, model: Model): { changed: string[]; added: string[]; removed: string[] } {
  const now = currentContracts(model);
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  if (!Object.keys(state.contracts).length) return { changed, added, removed };
  for (const [k, sig] of Object.entries(now)) {
    const prev = state.contracts[k];
    if (!prev) continue;
    for (const [el, h] of Object.entries(sig)) {
      if (!(el in prev)) added.push(`${k.replace(/^\w+:[^:]+:/, '')} → ${el}`);
      else if (prev[el] !== h) changed.push(`${k.replace(/^\w+:[^:]+:/, '')} → ${el}`);
    }
    for (const el of Object.keys(prev)) if (!(el in sig)) removed.push(`${k.replace(/^\w+:[^:]+:/, '')} → ${el}`);
  }
  return { changed, added, removed };
}
function diffStructure(state: State, model: Model): string[] {
  const out: string[] = [];
  if (!Object.keys(state.projects).length) return out;
  const now = new Map(model.projects.map((p) => [p.key, p]));
  for (const [k, v] of Object.entries(state.projects)) if (!now.has(k)) out.push(`project removed: ${v.name}`);
  for (const p of model.projects) {
    const prev = state.projects[p.key];
    if (!prev) {
      out.push(`project added: ${p.name} (${p.kind})`);
      continue;
    }
    const deps = model.relations.filter((r) => r.type === 'depends-on' && r.from === p.key).map((r) => r.to).sort();
    const addedD = deps.filter((d) => !prev.deps.includes(d));
    const removedD = prev.deps.filter((d) => !deps.includes(d));
    if (addedD.length || removedD.length) out.push(`dependencies of ${p.name} changed: ${[...addedD.map((d) => `+${state.projects[d]?.name ?? d.split(':').pop()}`), ...removedD.map((d) => `-${state.projects[d]?.name ?? d.split(':').pop()}`)].join(' ')}`);
    if (prev.kind !== p.kind) out.push(`${p.name}: kind ${prev.kind} → ${p.kind}`);
  }
  return out;
}

/** Fingerprint of a standalone OpenAPI file (used by transform/export without a vault). */
export function apiFingerprint(abs: string): Record<string, string> | undefined {
  const text = fs.readFileSync(abs, 'utf8');
  const parsed = /\.json$/i.test(abs) ? parseJson(text) : parseYaml(text);
  if (!isOpenApi(parsed.value)) return undefined;
  return contractSignature(readApiModel(parsed.value));
}
export { slugify, contentHashOf };
export type { ProjectInfo };
