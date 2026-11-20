// Aggregate knowledge model: joins context detection with per-file analyses into projects, modules,
// documents, APIs, configuration, relations (with evidence and status), contradictions and versions.
import fs from 'node:fs';
import path from 'node:path';
import type {
  AnalysisResult, CodeFileInfo, CodeSymbol, Config, ContextKind, ContextReport, Decision, DocumentUnit, Entity, Evidence, Fact, FileInfo,
  ProjectInfo, Relation, SkipRecord, SourceInfo, SourceRef,
} from './types.ts';
import { isTestFile } from './analyzers/code.ts';
import { compareVersions, posixDir, posixJoin, sha256, slugify, uniq } from './util.ts';

export interface ModelProject extends ProjectInfo {
  key: string;
  source: string;
  /** fully generated */
  selected: boolean;
  /** outside the selected scope but referenced by it (overview only) */
  partial: boolean;
  implicit?: boolean;
  readme?: string;
}
export interface ModuleSymbol {
  sym: CodeSymbol;
  file: string;
}
export interface ModelModule {
  key: string;
  project: string;
  source: string;
  /** posix dir relative to the source root */
  dir: string;
  /** dir relative to the project root ('' for project root) */
  rel: string;
  files: CodeFileInfo[];
  tests: string[];
  symbols: ModuleSymbol[];
  routes: ModuleSymbol[];
  languages: string[];
  moduleDoc?: string;
}
export interface ModelDoc {
  unit: DocumentUnit;
  entity: Entity;
  source: string;
  project?: string;
  access: 'public' | 'restricted';
  duplicates: SourceRef[];
  analyzer: string;
  flags: string[];
}
export interface Contradiction {
  id: string;
  subject: string;
  scope: string;
  claims: Fact[];
  detail: string;
  suggested?: string;
}
export interface Model {
  name: string;
  kind: ContextKind;
  sources: SourceInfo[];
  reports: Record<string, ContextReport>;
  projects: ModelProject[];
  modules: ModelModule[];
  docs: ModelDoc[];
  apis: ModelDoc[];
  configs: ModelDoc[];
  relations: Relation[];
  contradictions: Contradiction[];
  docVersions: string[];
  defaultVersion?: string;
  technologies: Record<string, { projects: string[]; versions: string[]; evidence: string[] }>;
  files: FileInfo[];
  skipped: SkipRecord[];
  warnings: string[];
  limitations: { ref: SourceRef; items: string[] }[];
  unsupported: { source: string; path: string; ext: string }[];
  brokenLinks: { doc: string; target: string; line: number }[];
  redactions: number;
  rootScripts: Record<string, Record<string, string>>;
  excludedRestricted: string[];
  injectionFlags: string[];
  scopeMode: 'all' | 'projects';
}

export interface Analysis {
  file: FileInfo;
  analyzer: string;
  result: AnalysisResult;
}

export interface BuildInput {
  config: Config;
  sources: SourceInfo[];
  reports: Record<string, ContextReport>;
  /** selected project keys; empty = all */
  selected: Set<string>;
  scopeMode: 'all' | 'projects';
  files: FileInfo[];
  skipped: SkipRecord[];
  analyses: Analysis[];
  decisions: Record<string, Decision>;
  includeRestricted: 'exclude' | 'restricted' | 'public';
  rootScripts: Record<string, Record<string, string>>;
}

export const projectKey = (source: string, p: { path: string }) => `project:${source}:${p.path}`;
export const moduleKey = (source: string, dir: string) => `module:${source}:${dir || '.'}`;

/** Deepest project owning a source-relative path. */
export function ownerOf(projects: ModelProject[], source: string, p: string): ModelProject | undefined {
  let best: ModelProject | undefined;
  let bestDepth = -2;
  for (const pr of projects) {
    if (pr.source !== source) continue;
    if (pr.path === '.' || p === pr.path || p.startsWith(`${pr.path}/`)) {
      const depth = pr.path === '.' ? -1 : pr.path.length;
      if (depth > bestDepth) {
        best = pr;
        bestDepth = depth;
      }
    }
  }
  return best;
}

const RESOLVE_EXT = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '.py', '/__init__.py', '.go'];

export function buildModel(input: BuildInput): Model {
  const { config, sources, reports } = input;
  const warnings: string[] = [];
  const kinds = sources.map((s) => reports[s.id]?.kind ?? 'unknown');
  let kind: ContextKind = kinds[0] ?? 'unknown';
  if (sources.length > 1) kind = kinds.every((k) => k === 'docs-only') ? 'docs-only' : 'multi-repo-workspace';

  // ── projects ──
  const projects: ModelProject[] = [];
  for (const s of sources) {
    for (const p of reports[s.id]?.projects ?? []) {
      const key = projectKey(s.id, p);
      projects.push({ ...p, key, source: s.id, selected: input.selected.size === 0 || input.selected.has(key), partial: false });
    }
  }
  // dependency closure of a partial selection: referenced projects get overview notes
  if (input.selected.size) {
    const byId = new Map(projects.map((p) => [`${p.source}:${p.id}`, p]));
    for (const s of sources)
      for (const e of reports[s.id]?.graph ?? []) {
        const from = byId.get(`${s.id}:${e.from}`);
        const to = byId.get(`${s.id}:${e.to}`);
        if (from?.selected && to && !to.selected) to.partial = true;
      }
  }
  const files = input.files;
  const analyses = new Map(input.analyses.map((a) => [`${a.file.source}:${a.file.path}`, a]));
  // implicit project for loose code outside any manifest
  for (const s of sources) {
    const loose = files.filter((f) => f.source === s.id && f.format.startsWith('code:') && !ownerOf(projects, s.id, f.path));
    if (loose.length >= 1 && input.selected.size === 0) {
      const langs = uniq(loose.map((f) => f.format.slice(5)));
      const p: ModelProject = {
        id: slugify(s.label), name: s.label, path: '.', ecosystem: langs[0] ?? 'unknown', kind: 'unknown',
        kindEvidence: ['no build manifest found; source files grouped under the source root'], frameworks: [], languages: langs, dependencies: [], scripts: {},
        entryPoints: [], manifests: [], key: projectKey(s.id, { path: '.' }), source: s.id, selected: true, partial: false, implicit: true,
      };
      if (projects.some((x) => x.id === p.id)) p.id = `${p.id}-root`;
      projects.push(p);
    }
  }
  const inScope = (p?: ModelProject) => !p || p.selected || p.partial;
  const fullScope = (p?: ModelProject) => (p ? p.selected : input.scopeMode === 'all');

  const docs: ModelDoc[] = [];
  const apis: ModelDoc[] = [];
  const configs: ModelDoc[] = [];
  const limitations: Model['limitations'] = [];
  const brokenLinks: Model['brokenLinks'] = [];
  const excludedRestricted: string[] = [];
  const injectionFlags: string[] = [];
  let redactions = 0;
  const bodyHash = new Map<string, ModelDoc>();

  for (const a of input.analyses) {
    const f = a.file;
    const owner = ownerOf(projects, f.source, f.path);
    redactions += a.result.redactions ?? 0;
    if (a.result.limitations.length) limitations.push({ ref: { source: f.source, path: f.path }, items: uniq(a.result.limitations) });
    for (const w of a.result.warnings) if (w.code !== 'secret-redacted' && w.code !== 'untrusted-instructions') warnings.push(`${f.source}:${f.path}: ${w.message}`);
    if (a.result.warnings.some((w) => w.code === 'untrusted-instructions')) injectionFlags.push(`${f.source}:${f.path}`);
    let access: 'public' | 'restricted' = 'public';
    if (f.restricted) {
      if (f.restrictedBy === 'policy') access = 'restricted';
      else if (input.includeRestricted === 'exclude') {
        excludedRestricted.push(`${f.source}:${f.path}`);
        continue;
      } else access = input.includeRestricted === 'public' ? 'public' : 'restricted';
    }
    for (const unit of a.result.documents) {
      const entity = a.result.entities.find((e) => e.key === unit.key) ?? { key: unit.key, type: 'document', name: unit.title, scope: '', attrs: {}, refs: [unit.file], confidence: 'verified' as const };
      const md: ModelDoc = { unit, entity, source: f.source, project: owner?.key, access, duplicates: [], analyzer: a.analyzer, flags: injectionFlags.includes(`${f.source}:${f.path}`) ? ['untrusted-instructions'] : [] };
      // scope filter
      if (owner && !inScope(owner)) continue;
      if (owner && owner.partial && !/readme/i.test(path.posix.basename(f.path))) continue;
      if (!owner && !fullScope(undefined) && !(/^readme(\.|$)/i.test(f.path) && !f.path.includes('/'))) continue;
      if (unit.kind === 'api-spec') {
        apis.push(md);
        continue;
      }
      if (unit.kind === 'config') {
        if (owner?.partial) continue;
        configs.push(md);
        continue;
      }
      // de-duplicate identical documents (same normalized body) → one note, several sources
      const h = sha256(unit.body.replace(/\s+/g, ' ').trim());
      const prev = bodyHash.get(h);
      if (prev && unit.body.trim().length > 40) {
        prev.duplicates.push(unit.file);
        continue;
      }
      bodyHash.set(h, md);
      docs.push(md);
      if (owner && /^readme(\.[a-z]+)?$/i.test(path.posix.basename(f.path)) && posixDir(f.path) === (owner.path === '.' ? '' : owner.path)) owner.readme = unit.key;
    }
  }
  docs.sort((a, b) => a.unit.key.localeCompare(b.unit.key));
  apis.sort((a, b) => a.unit.key.localeCompare(b.unit.key));
  configs.sort((a, b) => a.unit.key.localeCompare(b.unit.key));

  // broken links inside documents (relative targets that do not exist in the source)
  const fileSet = new Set(files.map((f) => `${f.source}:${f.path}`));
  const allPaths = new Set(input.analyses.map((a) => `${a.file.source}:${a.file.path}`));
  const skippedSet = new Set(input.skipped.map((s) => `${s.source}:${s.path}`));
  for (const d of docs) {
    for (const l of d.unit.links) {
      const target = linkTarget(l.target);
      if (!target) continue;
      const resolved = posixJoin(posixDir(d.unit.file.path), target);
      const k = `${d.source}:${resolved}`;
      if (l.kind === 'wikilink' || l.kind === 'embed') continue;
      if (!fileSet.has(k) && !allPaths.has(k) && !skippedSet.has(k) && !resolved.startsWith('..')) brokenLinks.push({ doc: d.unit.key, target: l.target, line: l.line });
    }
  }

  // ── modules ──
  const modules: ModelModule[] = [];
  const modByKey = new Map<string, ModelModule>();
  const fileToModule = new Map<string, ModelModule>();
  for (const a of input.analyses) {
    const code = a.result.code;
    if (!code) continue;
    const f = a.file;
    const owner = ownerOf(projects, f.source, f.path);
    if (!owner || !owner.selected) continue;
    const dir = posixDir(f.path);
    const key = moduleKey(f.source, dir);
    let m = modByKey.get(key);
    if (!m) {
      const rel = owner.path === '.' ? dir : dir === owner.path ? '' : dir.slice(owner.path.length + 1);
      m = { key, project: owner.key, source: f.source, dir, rel, files: [], tests: [], symbols: [], routes: [], languages: [] };
      modByKey.set(key, m);
      modules.push(m);
    }
    fileToModule.set(`${f.source}:${f.path}`, m);
    if (isTestFile(f.path)) {
      m.tests.push(f.path);
      continue;
    }
    m.files.push(code);
    if (!m.languages.includes(code.language)) m.languages.push(code.language);
    if (code.moduleDoc && !m.moduleDoc) m.moduleDoc = code.moduleDoc;
    for (const s of code.symbols) {
      if (s.kind === 'route') m.routes.push({ sym: s, file: f.path });
      else if (s.exported || config.depth === 'deep') m.symbols.push({ sym: s, file: f.path });
    }
  }
  // modules that only contain tests are folded into their parent's test list
  for (const m of [...modules]) {
    if (m.files.length === 0) {
      const parent = modules.find((x) => x !== m && x.project === m.project && m.dir.startsWith(`${x.dir}/`) && x.files.length);
      if (parent) parent.tests.push(...m.tests);
      modules.splice(modules.indexOf(m), 1);
      modByKey.delete(m.key);
    }
  }
  modules.sort((a, b) => a.key.localeCompare(b.key));

  // ── relations ──
  const relations: Relation[] = [];
  const addRel = (type: string, from: string, to: string, status: Relation['status'], ev: Evidence) => {
    const ex = relations.find((r) => r.type === type && r.from === from && r.to === to);
    if (ex) {
      if (ex.evidence.length < 5) ex.evidence.push(ev);
      if (status === 'verified') ex.status = 'verified';
      return;
    }
    relations.push({ type, from, to, status, evidence: [ev] });
  };
  const projByKey = new Map(projects.map((p) => [p.key, p]));
  const projById = (source: string, id: string) => projects.find((p) => p.source === source && p.id === id);
  for (const s of sources) {
    const rep = reports[s.id];
    if (!rep) continue;
    for (const p of projects.filter((x) => x.source === s.id && (x.selected || x.partial))) {
      const ws = rep.workspaces.find((w) => w.tool !== 'git-submodules' && (w.path === '.' || p.path.startsWith(`${w.path}/`)));
      if (ws) addRel('belongs-to', p.key, 'workspace', 'verified', { ref: { source: s.id, path: ws.path === '.' ? ws.evidence.split(' ')[0] : ws.path }, note: `${ws.tool}: ${ws.evidence}` });
      else if (kind === 'monorepo' || kind === 'multi-repo-workspace' || kind === 'mixed') addRel('belongs-to', p.key, 'workspace', 'verified', { ref: { source: s.id, path: p.path }, note: 'located inside the analysed workspace directory' });
    }
    for (const e of rep.graph) {
      const a = projById(s.id, e.from);
      const b = projById(s.id, e.to);
      if (!a || !b || !(a.selected || a.partial)) continue;
      addRel('depends-on', a.key, b.key, 'verified', { ref: { source: s.id, path: e.evidence.split(' ')[0] }, note: `${e.evidence} [${e.kind}]` });
    }
  }
  const internalNames = new Map<string, ModelProject>();
  for (const p of projects) internalNames.set(p.name, p);
  for (const m of modules) {
    addRel('belongs-to', m.key, m.project, 'verified', { ref: { source: m.source, path: m.dir || '.' }, note: 'directory inside project' });
    for (const fi of m.files) {
      for (const imp of fi.imports) {
        const ev: Evidence = { ref: { source: m.source, path: fi.file.path, lines: [imp.line, imp.line] }, note: `import "${imp.spec}"` };
        if (imp.spec.startsWith('.')) {
          const base = posixJoin(posixDir(fi.file.path), imp.spec);
          for (const ext of RESOLVE_EXT) {
            const target = fileToModule.get(`${m.source}:${base}${ext}`) ?? fileToModule.get(`${m.source}:${base.replace(/\.(js|mjs|cjs)$/, '')}${ext}`);
            if (target) {
              if (target !== m) addRel('depends-on', m.key, target.key, 'verified', ev);
              break;
            }
          }
          continue;
        }
        const pkg = imp.spec.startsWith('@') ? imp.spec.split('/').slice(0, 2).join('/') : imp.spec.split('/')[0];
        const internal = internalNames.get(pkg) ?? internalNames.get(imp.spec);
        const own = projByKey.get(m.project);
        if (internal && internal.key !== m.project) addRel('depends-on', m.key, internal.key, 'verified', ev);
        else if (own?.ecosystem === 'go' && imp.spec.startsWith(`${own.name}/`)) {
          const dir = posixJoin(own.path === '.' ? '' : own.path, imp.spec.slice(own.name.length + 1));
          const t = modByKey.get(moduleKey(m.source, dir));
          if (t && t !== m) addRel('depends-on', m.key, t.key, 'verified', ev);
        } else if (own && (own.ecosystem.includes('python') || fi.language === 'python') && !imp.spec.startsWith('.')) {
          const asPath = imp.spec.replace(/\./g, '/');
          for (const root of uniq([own.path === '.' ? '' : own.path, posixJoin(own.path === '.' ? '' : own.path, 'src')])) {
            const t = fileToModule.get(`${m.source}:${posixJoin(root, `${asPath}.py`)}`) ?? fileToModule.get(`${m.source}:${posixJoin(root, `${asPath}/__init__.py`)}`);
            if (t && t !== m) {
              addRel('depends-on', m.key, t.key, 'verified', ev);
              break;
            }
          }
        }
      }
    }
  }
  for (const d of [...docs, ...apis, ...configs]) {
    if (d.project) addRel(d.unit.kind === 'api-spec' ? 'belongs-to' : 'documents', d.unit.key, d.project, 'verified', { ref: d.unit.file, note: 'file located inside the project directory' });
  }
  for (const api of apis) if (api.project) addRel('exposes', api.project, api.unit.key, 'verified', { ref: api.unit.file, note: 'API specification shipped by the project' });
  // workspace-level docs that name a project package explicitly → inferred "documents"
  for (const d of docs.filter((x) => !x.project)) {
    for (const p of projects.filter((x) => x.selected && x.name.length >= 4 && !x.implicit)) {
      const re = new RegExp(`(^|[^\\w@/-])${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'g');
      const hits = d.unit.body.match(re)?.length ?? 0;
      const inHeading = d.unit.sections.some((s) => s.title.includes(p.name));
      if (hits >= 2 || inHeading) addRel('documents', d.unit.key, p.key, 'inferred', { ref: d.unit.file, note: `mentions "${p.name}" ${hits}×${inHeading ? ' (in a heading)' : ''}` });
    }
  }
  // docs → modules via explicit links to source files
  for (const d of docs) {
    for (const l of d.unit.links) {
      const t = linkTarget(l.target);
      if (!t) continue;
      const resolved = posixJoin(posixDir(d.unit.file.path), t);
      const mod = fileToModule.get(`${d.source}:${resolved}`) ?? modByKey.get(moduleKey(d.source, resolved));
      if (mod) addRel('documents', d.unit.key, mod.key, 'verified', { ref: { ...d.unit.file, lines: [l.line, l.line] }, note: `links to ${resolved}` });
    }
  }
  // examples exemplify what they depend on
  for (const p of projects.filter((x) => x.kind === 'example')) {
    for (const r of relations.filter((x) => x.type === 'depends-on' && x.from === p.key)) addRel('exemplifies', p.key, r.to, 'verified', { ref: r.evidence[0].ref, note: 'example project declares a dependency on it' });
  }
  for (const d of docs.filter((x) => x.unit.category === 'example' && x.project)) {
    for (const r of relations.filter((x) => x.type === 'depends-on' && x.from === d.project)) addRel('exemplifies', d.unit.key, r.to, 'inferred', { ref: d.unit.file, note: 'example document inside a project that depends on it' });
  }
  // ADR supersedes (explicit statements)
  for (const a of input.analyses)
    for (const r of a.result.relations.filter((x) => x.type === 'supersedes' && x.to.startsWith('link:'))) {
      const [, src, from, target] = /^link:([^:]+):(.+?):(.+)$/.exec(r.to) ?? [];
      if (!target) continue;
      const resolved = posixJoin(posixDir(from), linkTarget(target) ?? target);
      const to = docs.find((d) => d.source === src && d.unit.file.path === resolved);
      if (to) addRel('supersedes', r.from, to.unit.key, 'verified', r.evidence[0]);
    }
  // implements / consumes: route declarations and URL literals matched against API operations
  const opIndex: { api: ModelDoc; method: string; path: string; re: RegExp; suffix: RegExp[] }[] = [];
  const servers = new Map(apis.map((a) => [a.unit.key, ((a.entity.attrs.servers as string[]) ?? []).map((s) => s.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, ''))]));
  for (const api of apis) {
    for (const op of (api.entity.attrs.operations as { method: string; path: string }[] | undefined) ?? []) {
      const pattern = op.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}|\{[^}]+\}/g, '[^/]+');
      // clients often call through a prefix ("/api/v1/pets" for server base "/v1" + "/pets")
      const suffix = (servers.get(api.unit.key) ?? []).filter(Boolean).map((b) => new RegExp(`${b.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}${pattern}/?$`));
      opIndex.push({ api, method: op.method, path: op.path, re: new RegExp(`^${pattern}/?$`), suffix });
    }
  }
  const stripServer = (api: ModelDoc, p: string) => {
    for (const s of servers.get(api.unit.key) ?? []) if (s && p.startsWith(s)) return p.slice(s.length) || '/';
    return p;
  };
  if (opIndex.length) {
    for (const m of modules) {
      for (const r of m.routes) {
        const rp = String(r.sym.attrs?.path ?? '').replace(/:(\w+)/g, '{$1}').replace(/<(?:\w+:)?(\w+)>/g, '{$1}');
        for (const o of opIndex) {
          const norm = stripServer(o.api, rp);
          if ((o.re.test(norm) || o.re.test(rp)) && (r.sym.attrs?.method === o.method || r.sym.attrs?.method === 'ANY' || r.sym.attrs?.method === 'ALL')) {
            // a matching route path is still a pattern match, so it stays inferred until confirmed
            addRel('implements', m.key, o.api.unit.key, 'inferred', { ref: { source: m.source, path: r.file, lines: [r.sym.line, r.sym.line] }, note: `route ${r.sym.attrs?.method} ${rp} matches ${o.method} ${o.path}` });
          }
        }
      }
    }
    for (const a of input.analyses) {
      if (!a.result.code) continue;
      const owner = ownerOf(projects, a.file.source, a.file.path);
      if (!owner?.selected) continue;
      const text = safeRead(a);
      if (!text) continue;
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const lit of line.matchAll(/["'`]((?:https?:\/\/[^\s"'`/]+)?(\/[A-Za-z0-9_\-./{}$:]+))["'`]/g)) {
          const p = lit[2].replace(/\$\{[^}]+\}/g, 'x').replace(/\/$/, '');
          if (p.length < 3 || /\.(js|ts|css|png|svg|html|json|md)$/.test(p)) continue;
          for (const o of opIndex) {
            if (o.api.project === owner.key) continue;
            const cand = [p, stripServer(o.api, p)];
            if (cand.some((c) => o.re.test(c)) || o.suffix.some((s) => s.test(p))) {
              addRel('consumes', owner.key, o.api.unit.key, 'inferred', { ref: { source: a.file.source, path: a.file.path, lines: [i + 1, i + 1] }, note: `literal "${lit[1]}" matches ${o.method} ${o.path}` });
            }
          }
        }
      });
    }
  }
  // cross-project HTTP usage without a spec: URL literals in one project matching routes declared in another
  const routeIndex: { project: string; method: string; path: string; re: RegExp; file: string; line: number }[] = [];
  for (const m of modules) {
    for (const r of m.routes) {
      const rp = String(r.sym.attrs?.path ?? '');
      if (!rp || rp === '/' || rp.length < 2) continue;
      const pattern = rp.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}|\{[^}]+\}|:\w+|<(?:\w+:)?\w+>/g, '[^/]+');
      routeIndex.push({ project: m.project, method: String(r.sym.attrs?.method ?? 'ANY'), path: rp, re: new RegExp(`(?:^|/)${pattern.replace(/^\//, '')}/?$`), file: r.file, line: r.sym.line });
    }
  }
  if (routeIndex.length) {
    for (const a of input.analyses) {
      if (!a.result.code || isTestFile(a.file.path)) continue;
      const owner = ownerOf(projects, a.file.source, a.file.path);
      if (!owner?.selected) continue;
      const text = safeRead(a);
      if (!text) continue;
      text.split('\n').forEach((line, i) => {
        for (const lit of line.matchAll(/["'`]((?:https?:\/\/[^\s"'`/]+)?(\/[A-Za-z0-9_\-./{}$:]+))["'`]/g)) {
          if (!/fetch|axios|http|get|post|put|delete|request|url|endpoint|client/i.test(line)) continue;
          const p = lit[2].replace(/\$\{[^}]+\}/g, 'x').replace(/\/$/, '');
          for (const r of routeIndex) {
            if (r.project === owner.key || !r.re.test(p)) continue;
            addRel('consumes', owner.key, r.project, 'inferred', { ref: { source: a.file.source, path: a.file.path, lines: [i + 1, i + 1] }, note: `literal "${lit[1]}" matches route ${r.method} ${r.path} declared in ${r.file}:${r.line}` });
          }
        }
      });
    }
  }
  // declared contract usage: a script/config of one project points to another project's API spec
  for (const p of projects.filter((x) => x.selected)) {
    const scripts = Object.values(p.scripts).join('\n');
    for (const api of apis) {
      if (api.project === p.key || api.source !== p.source) continue;
      const rel = path.posix.relative(p.path === '.' ? '' : p.path, api.unit.file.path);
      if (scripts.includes(rel) || scripts.includes(api.unit.file.path)) addRel('consumes', p.key, api.unit.key, 'verified', { ref: { source: p.source, path: p.manifests[0] ?? p.path }, note: `a script references ${rel}` });
    }
  }
  // user decisions on inferred relations
  for (const r of relations) {
    const d = input.decisions[relationDecisionId(r)];
    if (d?.answer === 'confirm' && r.status === 'inferred') r.status = 'confirmed';
  }
  const rejected = new Set(relations.filter((r) => input.decisions[relationDecisionId(r)]?.answer === 'reject').map(relationDecisionId));
  const finalRelations = relations.filter((r) => !rejected.has(relationDecisionId(r)));

  // ── contradictions ──
  const contradictions = findContradictions(input, docs, configs, projects, files);

  // ── versions ──
  const docVersions = uniq(docs.map((d) => d.unit.version).filter((v): v is string => !!v)).sort(compareVersions);
  let defaultVersion: string | undefined;
  if (docVersions.length > 1) defaultVersion = input.decisions['default-version']?.answer ?? docVersions[docVersions.length - 1];

  // ── technologies ──
  const technologies: Model['technologies'] = {};
  for (const p of projects.filter((x) => x.selected || x.partial)) {
    for (const t of p.frameworks) {
      const e = (technologies[t.name] ??= { projects: [], versions: [], evidence: [] });
      if (!e.projects.includes(p.key)) e.projects.push(p.key);
      if (t.version && !e.versions.includes(t.version)) e.versions.push(t.version);
      if (e.evidence.length < 6) e.evidence.push(t.evidence);
    }
    for (const l of p.languages) {
      const name = langName(l);
      const e = (technologies[name] ??= { projects: [], versions: [], evidence: [] });
      if (!e.projects.includes(p.key)) e.projects.push(p.key);
      if (e.evidence.length < 6) e.evidence.push(`source files (${l}) in ${p.path}`);
    }
  }
  for (const s of sources)
    for (const ev of reports[s.id]?.evidence.filter((x) => x.kind === 'infrastructure') ?? []) {
      const e = (technologies[ev.detail] ??= { projects: [], versions: [], evidence: [] });
      if (e.evidence.length < 6) e.evidence.push(ev.path);
    }

  const unsupported = files.filter((f) => f.format === 'unsupported').map((f) => ({ source: f.source, path: f.path, ext: f.ext }));
  const visible = projects.filter((p) => p.selected || p.partial);
  const name = sources.length === 1
    ? visible.length === 1 && !visible[0].implicit ? visible[0].name : reports[sources[0].id]?.rootName ?? sources[0].label
    : sources.map((s) => reports[s.id]?.rootName ?? s.label).join(' + ');
  return {
    name, kind, sources, reports, projects: projects.filter((p) => p.selected || p.partial), modules, docs, apis, configs, relations: finalRelations, contradictions,
    docVersions, defaultVersion, technologies, files, skipped: input.skipped, warnings, limitations, unsupported, brokenLinks, redactions,
    rootScripts: input.rootScripts, excludedRestricted, injectionFlags, scopeMode: input.scopeMode,
  };
}

export const relationDecisionId = (r: { type: string; from: string; to: string }) => `relation:${sha256(`${r.type}|${r.from}|${r.to}`).slice(0, 10)}`;

function safeRead(a: Analysis): string | undefined {
  try {
    return fs.readFileSync(a.file.abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** Relative link target without anchor/query; undefined for external/anchor-only links. */
export function linkTarget(t: string): string | undefined {
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#') || t.startsWith('//') || t.startsWith('/')) return undefined;
  let s = t.split('#')[0].split('?')[0];
  try {
    s = decodeURI(s);
  } catch {
    /* keep raw */
  }
  return s || undefined;
}

const LANG_NAMES: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', csharp: 'C#', php: 'PHP', ruby: 'Ruby', swift: 'Swift', dart: 'Dart', vue: 'Vue SFC', svelte: 'Svelte', cpp: 'C++', c: 'C', scala: 'Scala', shell: 'Shell', sql: 'SQL', terraform: 'Terraform', graphql: 'GraphQL', protobuf: 'Protocol Buffers' };
export const langName = (l: string): string => LANG_NAMES[l] ?? l;

/** Major-version interval of a version claim ("16", ">=18", "^20.1", "18.x", "v20", "20+"). */
export function majorRange(v: string): [number, number] | undefined {
  const s = v.trim().replace(/^v/i, '');
  const m = /^(>=|=>|>|\^|~|=)?\s*v?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?(\+|\.x)?/.exec(s);
  if (!m) return undefined;
  const major = +m[2];
  if (m[1] === '>=' || m[1] === '=>' || m[5] === '+') return [major, Infinity];
  if (m[1] === '>') return [m[3] && m[3] !== 'x' ? major : major + 1, Infinity];
  return [major, major];
}
const intersects = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

function findContradictions(input: BuildInput, docs: ModelDoc[], configs: ModelDoc[], projects: ModelProject[], files: FileInfo[]): Contradiction[] {
  const out: Contradiction[] = [];
  const facts: (Fact & { scope: string })[] = [];
  const included = new Set([...docs, ...configs].map((d) => `${d.source}:${d.unit.file.path}`));
  for (const a of input.analyses) {
    const k = `${a.file.source}:${a.file.path}`;
    const isManifestish = a.result.facts.some((f) => f.authority === 'manifest');
    if (!included.has(k) && !isManifestish) continue;
    const owner = ownerOf(projects, a.file.source, a.file.path);
    if (owner && !owner.selected) continue;
    for (const f of a.result.facts) facts.push({ ...f, scope: owner?.key ?? '' });
  }
  // manifest-declared runtimes (engines, go directive ...) from detection
  for (const p of projects.filter((x) => x.selected)) {
    for (const t of p.frameworks) {
      const rt = t.name === 'Node.js' ? 'node' : t.name === 'Go' ? 'go' : t.name === 'Java' ? 'java' : undefined;
      if (rt && t.version) facts.push({ subject: `runtime:${rt}`, value: t.version, ref: { source: p.source, path: t.evidence.split(' ')[0] }, authority: 'manifest', scope: p.key });
    }
  }
  // runtime version claims: compare inside each project scope, and workspace-level claims with every project
  const byScope = new Map<string, (Fact & { scope: string })[]>();
  for (const f of facts.filter((x) => x.subject.startsWith('runtime:'))) {
    const k = `${f.subject}|${f.scope}`;
    byScope.set(k, [...(byScope.get(k) ?? []), f]);
  }
  for (const [k, list] of byScope) {
    const [subject, scope] = k.split('|');
    const withWs = scope ? [...list, ...(byScope.get(`${subject}|`) ?? []).filter((f) => f.authority !== 'manifest')] : list;
    const ranges = withWs.map((f) => ({ f, r: majorRange(f.value) })).filter((x) => x.r);
    const groups: { f: Fact; r: [number, number] }[][] = [];
    for (const x of ranges) {
      const g = groups.find((gr) => gr.every((y) => intersects(y.r, x.r!)));
      if (g) g.push(x as { f: Fact; r: [number, number] });
      else groups.push([x as { f: Fact; r: [number, number] }]);
    }
    if (groups.length > 1) {
      const claims = uniqFacts(withWs);
      if (claims.length < 2) continue;
      const pick = claims.slice().sort((a, b) => rank(input.config.truthPrecedence, a.authority) - rank(input.config.truthPrecedence, b.authority))[0];
      out.push({
        id: `contradiction:${sha256(`${subject}|${scope}`).slice(0, 10)}`,
        subject, scope, claims,
        detail: `${subject.replace('runtime:', '')} version is stated differently: ${claims.map((c) => `"${c.value}" (${c.ref.path})`).join(' vs ')}`,
        suggested: `${pick.value} (${pick.ref.path}, ${pick.authority})`,
      });
    }
  }
  // documented scripts that the manifest does not declare
  for (const f of facts.filter((x) => x.subject.startsWith('script:') && x.authority !== 'manifest')) {
    const name = f.subject.slice(7);
    const p = projects.find((x) => x.key === f.scope);
    const scripts = p ? p.scripts : input.rootScripts[f.ref.source] ?? {};
    const isNode = p ? p.ecosystem.includes('node') : !!input.rootScripts[f.ref.source];
    if (!isNode || !Object.keys(scripts).length || scripts[name] !== undefined) continue;
    const manifest = p ? p.manifests.find((m) => m.endsWith('package.json')) ?? p.manifests[0] : 'package.json';
    const id = `contradiction:${sha256(`script|${name}|${f.scope}`).slice(0, 10)}`;
    if (out.some((c) => c.id === id)) continue;
    out.push({
      id, subject: f.subject, scope: f.scope,
      claims: [f, { subject: f.subject, value: 'not declared', ref: { source: f.ref.source, path: manifest }, authority: 'manifest' }],
      detail: `documentation refers to script "${name}" but ${manifest} does not declare it (declared: ${Object.keys(scripts).slice(0, 8).join(', ')})`,
      suggested: `${manifest} (manifest)`,
    });
  }
  void files;
  return out;
}
const rank = (prec: string[], a: string) => {
  const i = prec.indexOf(a);
  return i < 0 ? 99 : i;
};
function uniqFacts(fs: Fact[]): Fact[] {
  const seen = new Set<string>();
  return fs.filter((f) => {
    const k = `${f.value}|${f.ref.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
