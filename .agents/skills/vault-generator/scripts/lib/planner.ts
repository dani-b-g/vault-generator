// Planner: Model → PlannedNote[]. Decides which notes exist, how they are organised (adaptive
// layout), what they contain and how they link. Bodies reference other notes through id
// placeholders (⟦vg:id|display⟧) so that final paths can be decided later by the writer
// (existing notes keep the location the user gave them).
import type { Decision, NoteStatus, PlannedNote, Relation, SourceRef } from './types.ts';
import type { Contradiction, Model, ModelDoc, ModelModule, ModelProject } from './model.ts';
import { langName, linkTarget, relationDecisionId } from './model.ts';
import { mapOutsideCode, parseMarkdown, replaceLinks, splitByHeading } from './markdown.ts';
import { isReadme } from './analyzers/common.ts';
import { byStr, escapeMdTable, fence, headingSlug, mdCode, mdTable, oneLine, posixBase, posixDir, posixJoin, sanitizeFileName, sha256, slugify, t, truncate, uniq } from './util.ts';

export const linkTok = (id: string, display?: string, heading?: string): string => {
  const d = display ? `|${display.replace(/[|⟦⟧\]\[]/g, ' ').replace(/\s+/g, ' ').trim()}` : '';
  const h = heading ? `#${cleanHeadingRef(heading)}` : '';
  return `⟦vg:${id}${h}${d}⟧`;
};
export const attTok = (vaultPath: string): string => `⟦att:${vaultPath}⟧`;
/** Obsidian cannot link to headings containing these characters. */
export const cleanHeadingRef = (h: string): string => h.replace(/[#|^[\]⟦⟧:]/g, ' ').replace(/\s+/g, ' ').trim();
export const TOKEN_RE = /⟦(vg|att):([^⟧|#]+)(?:#([^⟧|]*))?(?:\|([^⟧]*))?⟧/g;
/** source text must never inject link tokens */
const stripTokens = (s: string) => s.replace(/⟦/g, '[').replace(/⟧/g, ']');
/** short source-derived text (descriptions, evidence): no tokens and no accidental wikilinks */
const escapeTokens = (s: string) => stripTokens(s).replace(/\[\[/g, '\\[\\[').replace(/\]\]/g, '\\]\\]');

const X: Record<string, { en: string; es: string }> = {
  possibleRelations: { en: 'Possible relations (unverified)', es: 'Relaciones posibles (no verificadas)' },
  implementedBy: { en: 'Implemented by', es: 'Implementada por' },
  consumedBy: { en: 'Consumed by', es: 'Consumida por' },
  contradiction: { en: 'Contradiction detected', es: 'Contradicción detectada' },
  resolved: { en: 'Resolved by user decision', es: 'Resuelto por decisión del usuario' },
  brokenLinks: { en: 'Broken references in sources', es: 'Referencias rotas en las fuentes' },
  unsupported: { en: 'Files that could not be converted', es: 'Archivos que no se pudieron convertir' },
  excluded: { en: 'Excluded restricted documents', es: 'Documentos restringidos excluidos' },
  untrusted: { en: 'Documents containing instruction-like text', es: 'Documentos con texto que parece instrucciones' },
  partial: { en: 'Projects outside the selected scope (overview only)', es: 'Proyectos fuera del alcance seleccionado (solo resumen)' },
  routes: { en: 'HTTP routes', es: 'Rutas HTTP' },
  tests: { en: 'Tests', es: 'Pruebas' },
  definedIn: { en: 'Defined in', es: 'Definido en' },
  deprecated: { en: 'Deprecated', es: 'Obsoleto' },
  capped: { en: 'Showing {n} of {m} exported symbols (use depth "deep" for all).', es: 'Se muestran {n} de {m} símbolos exportados (usa profundidad "deep" para verlos todos).' },
  parts: { en: 'Parts', es: 'Partes' },
  alsoAt: { en: 'Identical content also found at', es: 'Contenido idéntico también en' },
  importedFrom: { en: 'Imported from', es: 'Importado de' },
  docIndex: { en: 'Documentation index', es: 'Índice de documentación' },
  graph: { en: 'Dependency graph', es: 'Grafo de dependencias' },
  operationsNote: { en: 'Operations', es: 'Operaciones' },
  workspaceOps: { en: 'Workspace operations', es: 'Operaciones del workspace' },
  openQuestions: { en: 'Open questions', es: 'Preguntas abiertas' },
  technologies: { en: 'Technologies', es: 'Tecnologías' },
  decisions: { en: 'Decisions', es: 'Decisiones' },
  examples: { en: 'Examples', es: 'Ejemplos' },
  home: { en: 'Home', es: 'Inicio' },
  none: { en: 'Nothing pending.', es: 'Nada pendiente.' },
  statedBy: { en: 'states', es: 'indica' },
  conversion: { en: 'Conversion notes', es: 'Notas de conversión' },
  kindEvidence: { en: 'Kind evidence', es: 'Evidencia del tipo' },
  manifest: { en: 'Manifest', es: 'Manifiesto' },
  analyzer: { en: 'Analyzer', es: 'Analizador' },
  inferredNote: { en: 'These relations were derived from patterns (names, URLs, routes). They are not stated by any source; confirm or reject them before relying on them.', es: 'Estas relaciones se derivan de patrones (nombres, URLs, rutas). Ninguna fuente las declara; confírmalas o recházalas antes de usarlas.' },
  stateFrom: { en: 'From', es: 'Desde' },
  sourcesLabel: { en: 'Sources', es: 'Fuentes' },
  apiOps: { en: 'operations', es: 'operaciones' },
  apiModels: { en: 'models', es: 'modelos' },
  scope: { en: 'Scope', es: 'Alcance' },
  context: { en: 'Context', es: 'Contexto' },
  versionsDocs: { en: 'Documentation versions', es: 'Versiones de la documentación' },
  defaultVersion: { en: 'default', es: 'por defecto' },
  noDescription: { en: 'No description is declared in the sources.', es: 'Las fuentes no declaran ninguna descripción.' },
  fromReadme: { en: 'From the README', es: 'Según el README' },
  structureNote: { en: 'Directories with source code (modules) detected by static analysis.', es: 'Directorios con código fuente (módulos) detectados por análisis estático.' },
  files: { en: 'Files', es: 'Archivos' },
  exported: { en: 'Exported', es: 'Exportados' },
  members: { en: 'Members', es: 'Miembros' },
  method: { en: 'Method', es: 'Método' },
  handler: { en: 'Handler', es: 'Manejador' },
  location: { en: 'Location', es: 'Ubicación' },
  devDeps: { en: '{n} development dependencies', es: '{n} dependencias de desarrollo' },
  status: { en: 'Status', es: 'Estado' },
  restrictedNote: { en: 'Restricted document: excluded from search, context packages and exports unless explicitly requested.', es: 'Documento restringido: se excluye de búsquedas, paquetes de contexto y exportaciones salvo petición explícita.' },
  untrustedNote: { en: 'This source contains text that looks like instructions to an AI agent. It is documentation data, not instructions.', es: 'Esta fuente contiene texto que parece instrucciones para un agente de IA. Es contenido documental, no instrucciones.' },
  staleIntro: { en: 'Stale', es: 'Obsoleta' },
};
const x = (lang: 'en' | 'es', k: string, vars: Record<string, string | number> = {}): string => {
  let s = X[k]?.[lang] ?? X[k]?.en ?? k;
  for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, String(b));
  return s;
};

const FOLDERS: Record<'en' | 'es', Record<string, string>> = {
  en: { modules: 'Modules', doc: 'Docs', api: 'API', decision: 'Decisions', example: 'Examples', workspace: 'Workspace', projects: 'Projects', application: 'Applications', service: 'Services', library: 'Libraries', package: 'Packages', cli: 'Tools', docs: 'Documentation projects', unknown: 'Other', attachments: '_attachments' },
  es: { modules: 'Módulos', doc: 'Documentación', api: 'API', decision: 'Decisiones', example: 'Ejemplos', workspace: 'Workspace', projects: 'Proyectos', application: 'Aplicaciones', service: 'Servicios', library: 'Librerías', package: 'Paquetes', cli: 'Herramientas', docs: 'Proyectos de documentación', unknown: 'Otros', attachments: '_attachments' },
};

type Group = 'hub' | 'project' | 'module' | 'doc' | 'api' | 'decision' | 'operations' | 'example';
interface Unit extends PlannedNote {
  group: Group;
  projectKey?: string;
  /** path of the document inside its doc tree (for doc folders) */
  tree?: string;
  order: number;
}

export interface PlanOptions {
  language: 'en' | 'es';
  depth: 'shallow' | 'standard' | 'deep';
  maxNoteChars: number;
  folderThreshold: number;
  idOf: (key: string) => string;
  decisions: Record<string, Decision>;
  /** vault-relative folder that holds generated notes ('' = vault root) */
  baseFolder: string;
  copyAttachments: boolean;
  /** hub notes that already exist: keep planning them so they are updated instead of marked stale */
  keepHubs?: Set<string>;
}
export interface Plan {
  notes: PlannedNote[];
  homeId: string;
  layout: { strategy: string; folders: Record<string, string> };
  /** note keys a relation endpoint resolves to (module keys may resolve to their project note) */
  keyToNote: Record<string, string>;
}

const projectFile = (p: ModelProject) => sanitizeFileName(p.name.replace(/^@/, '').replace(/\//g, '-'));
const srcStr = (r: SourceRef) => `${r.source}:${r.path}${r.hash ? `@${r.hash.slice(0, 12)}` : ''}`;

export function planVault(model: Model, opts: PlanOptions): Plan {
  const lang = opts.language;
  const units: Unit[] = [];
  const byKey = new Map<string, Unit>();
  const keyToNote = new Map<string, string>(); // relation endpoint key → unit key
  const add = (u: Unit) => {
    units.push(u);
    byKey.set(u.key, u);
    keyToNote.set(u.key, u.key);
    return u;
  };
  const mk = (p: Partial<Unit> & Pick<Unit, 'key' | 'type' | 'group' | 'title'>): Unit => ({
    category: p.category ?? p.type, scope: p.scope ?? '', folder: '', fileName: '', body: '', fm: {}, origin: 'generated', status: 'current', access: 'public',
    confidence: 'verified', sources: [], linkKeys: [], attachments: [], order: 50, ...p, id: '',
  });
  const idOf = (key: string) => opts.idOf(key);

  const selected = model.projects.filter((p) => p.selected);
  const realProjects = selected.filter((p) => !p.implicit);
  const singleProject = model.sources.length === 1 && selected.length === 1;
  const limitSymbols = opts.depth === 'deep' ? 400 : opts.depth === 'shallow' ? 25 : 80;

  // ── projects ──
  for (const p of model.projects) {
    add(mk({ key: p.key, type: p.kind === 'example' ? 'example' : 'project', category: p.kind, group: 'project', title: p.name, scope: p.key, projectKey: p.key, order: 10, analyzer: 'detect' }));
  }
  // ── modules (fold small projects into their project note) ──
  const moduleNoteFor = new Map<string, ModelModule[]>(); // projectKey → modules rendered inside the project note
  for (const p of selected) {
    const mods = model.modules.filter((m) => m.project === p.key && (m.symbols.length || m.routes.length));
    const totalSymbols = mods.reduce((n, m) => n + m.symbols.length + m.routes.length, 0);
    if (mods.length <= 1 || totalSymbols <= 12) {
      moduleNoteFor.set(p.key, mods);
      for (const m of model.modules.filter((mm) => mm.project === p.key)) keyToNote.set(m.key, p.key);
      continue;
    }
    const strip = commonPrefix(mods.map((m) => m.rel));
    for (const m of mods) {
      const shown = displayRel(m.rel, strip);
      const u = add(mk({ key: m.key, type: 'module', group: 'module', title: `${p.name} › ${shown}`, scope: p.key, projectKey: p.key, order: 30, analyzer: 'code' }));
      u.fileName = sanitizeFileName(`${projectFile(p)} › ${shown.replace(/\//g, ' › ')}`);
      u.fm.aliases = uniq([`${p.name}/${m.rel || '.'}`, m.rel].filter(Boolean));
    }
    for (const m of model.modules.filter((mm) => mm.project === p.key && !byKey.has(mm.key))) keyToNote.set(m.key, p.key);
  }
  // ── APIs ──
  for (const a of model.apis) {
    add(mk({ key: a.unit.key, type: 'api', group: 'api', title: a.unit.title, scope: a.project ?? '', projectKey: a.project, order: 20, access: a.access, analyzer: 'openapi', category: 'api' }));
  }
  // ── documents (split oversized ones) ──
  const docParts = new Map<string, { key: string; title: string; body: string }[]>();
  const homeTitle = singleProject ? selected[0].name : model.name;
  for (const d of model.docs) {
    const isDecision = d.unit.category === 'decision';
    const isExample = d.unit.category === 'example';
    const group: Group = isDecision ? 'decision' : isExample ? 'example' : 'doc';
    // a README titled like its project (or the vault) would collide with the project/home note
    const owner = model.projects.find((p) => p.key === d.project);
    const clash = isReadme(d.unit.file.path) && [owner?.name, homeTitle].some((n) => n && n.toLowerCase() === d.unit.title.toLowerCase());
    const title = clash && !/readme/i.test(d.unit.title) ? `${d.unit.title} README` : d.unit.title;
    const base = mk({
      key: d.unit.key, type: isDecision ? 'decision' : isExample ? 'example' : 'document', category: d.unit.category ?? 'document', group, title,
      scope: d.project ?? '', projectKey: d.project, order: isReadme(d.unit.file.path) ? 25 : 40, access: d.access, origin: 'imported', analyzer: d.analyzer,
    });
    base.tree = docTreePath(d, model);
    add(base);
    const parts = splitByHeading(d.unit.body, opts.maxNoteChars);
    if (parts && parts.length > 1) {
      const list = parts.map((pt, i) => ({ key: `${d.unit.key}#part-${i + 1}`, title: `${d.unit.title} — ${pt.title || `${i + 1}`}`, body: pt.body }));
      docParts.set(d.unit.key, list);
      for (const pt of list) {
        const u = add(mk({ ...base, key: pt.key, title: pt.title, order: base.order + 1, fm: {}, attachments: [], sources: [] }));
        u.tree = base.tree ? `${posixDir(base.tree) ? `${posixDir(base.tree)}/` : ''}${sanitizeFileName(d.unit.title)}/${posixBase(base.tree)}` : undefined;
      }
    }
  }
  // ── configuration / operations ──
  const configsBy = new Map<string, ModelDoc[]>();
  for (const c of model.configs) configsBy.set(c.project ?? '', [...(configsBy.get(c.project ?? '') ?? []), c]);
  const opsNoteFor = new Map<string, string>(); // scope → unit key holding the operations sections
  for (const [scope, list] of configsBy) {
    const p = model.projects.find((pp) => pp.key === scope);
    if (scope && p && list.length < 2) {
      opsNoteFor.set(scope, p.key);
      continue;
    }
    if (!scope && list.length < 2 && !singleProject) {
      opsNoteFor.set(scope, 'hub:home');
      continue;
    }
    if (!scope && singleProject && list.length < 2) {
      opsNoteFor.set(scope, selected[0].key);
      continue;
    }
    const key = `hub:operations:${scope || 'workspace'}`;
    const title = scope ? `${p?.name ?? scope} — ${x(lang, 'operationsNote')}` : x(lang, 'workspaceOps');
    add(mk({ key, type: 'operations', group: 'operations', title, scope, projectKey: scope || undefined, order: 22, analyzer: 'config', category: 'operations' }));
    opsNoteFor.set(scope, key);
  }
  for (const c of model.configs) keyToNote.set(c.unit.key, opsNoteFor.get(c.project ?? '') ?? 'hub:home');

  // ── hubs ──
  const homeKey = singleProject ? selected[0].key : 'hub:home';
  if (!singleProject) add(mk({ key: 'hub:home', type: 'moc', group: 'hub', title: model.name, order: 0, analyzer: 'planner', category: 'home' }));
  keyToNote.set('workspace', homeKey);
  const keep = opts.keepHubs ?? new Set<string>();
  const techCount = Object.keys(model.technologies).length;
  const hasTechNote = techCount >= 4 || realProjects.length >= 2 || keep.has('hub:technologies');
  if (hasTechNote) add(mk({ key: 'hub:technologies', type: 'moc', group: 'hub', title: x(lang, 'technologies'), order: 2, analyzer: 'planner', category: 'technologies' }));
  const decisions = model.docs.filter((d) => d.unit.category === 'decision');
  if (decisions.length >= 3 || (decisions.length && keep.has('hub:decisions'))) add(mk({ key: 'hub:decisions', type: 'moc', group: 'hub', title: x(lang, 'decisions'), order: 3, analyzer: 'planner', category: 'decisions' }));
  const exampleDocs = model.docs.filter((d) => d.unit.category === 'example');
  const exampleProjects = model.projects.filter((p) => p.kind === 'example');
  if (exampleDocs.length + exampleProjects.length >= 3 || (exampleDocs.length + exampleProjects.length && keep.has('hub:examples'))) add(mk({ key: 'hub:examples', type: 'moc', group: 'hub', title: x(lang, 'examples'), order: 4, analyzer: 'planner', category: 'examples' }));
  const inferred = model.relations.filter((r) => r.status === 'inferred');
  const hasOpen = !!(model.contradictions.length || inferred.length || model.brokenLinks.length || model.unsupported.length || model.limitations.length || model.excludedRestricted.length || model.injectionFlags.length || model.projects.some((p) => p.partial)) || keep.has('hub:open-questions');
  if (hasOpen) add(mk({ key: 'hub:open-questions', type: 'moc', group: 'hub', title: x(lang, 'openQuestions'), order: 5, analyzer: 'planner', category: 'open-questions' }));

  // ids
  for (const u of units) u.id = idOf(u.key);
  const idByKey = (key: string | undefined) => {
    if (!key) return undefined;
    const nk = keyToNote.get(key) ?? (byKey.has(key) ? key : undefined);
    return nk ? byKey.get(nk)?.id : undefined;
  };
  const lnk = (key: string | undefined, display?: string, heading?: string) => {
    const id = idByKey(key);
    const u = key ? byKey.get(keyToNote.get(key) ?? key) : undefined;
    if (!id || !u) return display ?? key ?? '';
    return linkTok(id, display ?? (u.title !== posixBase(u.title) ? undefined : undefined), heading);
  };
  const projOf = (key?: string) => model.projects.find((p) => p.key === key);

  // ── relation properties ──
  const relProps = buildRelationProps(model.relations, keyToNote, byKey);

  // ── contradictions per document ──
  const contraByDoc = new Map<string, Contradiction[]>();
  for (const c of model.contradictions) for (const cl of c.claims) {
    const docKey = `doc:${cl.ref.source}:${cl.ref.path}`;
    if (byKey.has(docKey)) contraByDoc.set(docKey, uniq([...(contraByDoc.get(docKey) ?? []), c]));
  }

  // ── link rewriting for imported documents ──
  const docByFile = new Map<string, ModelDoc>();
  for (const d of [...model.docs, ...model.apis]) {
    docByFile.set(`${d.source}:${d.unit.file.path}`, d);
    for (const dup of d.duplicates) docByFile.set(`${dup.source}:${dup.path}`, d);
  }
  const moduleByFile = new Map<string, string>();
  for (const m of model.modules) for (const f of m.files) moduleByFile.set(`${m.source}:${f.file.path}`, m.key);
  const fileIndex = new Map(model.files.map((f) => [`${f.source}:${f.path}`, f]));
  const sourceLabel = new Map(model.sources.map((s) => [s.id, s.label]));
  const attachmentsDir = posixJoin(opts.baseFolder, FOLDERS[lang].attachments);
  const headingIn = (docKey: string, anchor: string): { key: string; title: string } | undefined => {
    const d = model.docs.find((dd) => dd.unit.key === docKey);
    if (!d) return undefined;
    const sec = d.unit.sections.find((s) => s.slug === anchor.toLowerCase() || headingSlug(s.title) === headingSlug(anchor));
    if (!sec) return undefined;
    const parts = docParts.get(docKey);
    if (parts) {
      const part = parts.find((pt) => pt.body.split('\n').some((l) => new RegExp(`^#{1,6}\\s+${sec.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l)));
      if (part) return { key: part.key, title: sec.title };
    }
    return { key: docKey, title: sec.title };
  };
  // wikilinks already present in source documents (Obsidian-flavoured sources): resolve by file stem or title
  const docByStem = new Map<string, ModelDoc>();
  for (const d of model.docs) {
    const stem = posixBase(d.unit.file.path).replace(/\.[^.]+$/, '').toLowerCase();
    if (!docByStem.has(stem)) docByStem.set(stem, d);
    if (!docByStem.has(d.unit.title.toLowerCase())) docByStem.set(d.unit.title.toLowerCase(), d);
  }
  const rewriteWikilinks = (d: ModelDoc, body: string): string =>
    mapOutsideCode(body, (seg) =>
      seg.replace(/(!?)\[\[([^\]|#\n]*)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/g, (_m, embed: string, target: string, heading: string | undefined, display: string | undefined) => {
        const t = target.trim();
        const dir = posixDir(d.unit.file.path);
        const byPath = docByFile.get(`${d.source}:${posixJoin(dir, t)}`) ?? docByFile.get(`${d.source}:${posixJoin(dir, `${t}.md`)}`) ?? docByFile.get(`${d.source}:${t}.md`);
        const hit = t ? byPath ?? docByStem.get(posixBase(t).toLowerCase()) : d;
        if (hit && byKey.has(hit.unit.key) && !embed) {
          const h = heading ? headingIn(hit.unit.key, heading) : undefined;
          return lnk(h?.key ?? hit.unit.key, display, h?.title ?? heading);
        }
        if (embed && /\.(png|jpe?g|gif|svg|webp)$/i.test(t)) return `![${display ?? ''}](${t})`;
        return `${display ?? t}${heading ? ` › ${heading}` : ''} ⚠️\`[[${t}]]\``;
      }),
    );
  const rewriteDoc = (d: ModelDoc, body: string, unit: Unit): string => {
    const dir = posixDir(d.unit.file.path);
    return replaceLinks(rewriteWikilinks(d, stripTokens(body)), ({ image, text, target }) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return undefined;
      if (target.startsWith('#')) {
        const h = headingIn(d.unit.key, target.slice(1));
        return h ? lnk(h.key, text || h.title, h.title) : undefined;
      }
      const rel = linkTarget(target);
      if (!rel) return undefined;
      const resolved = posixJoin(dir, rel);
      const anchor = target.includes('#') ? target.split('#')[1] : undefined;
      const k = `${d.source}:${resolved}`;
      if (image) {
        const f = fileIndex.get(k);
        if (f && f.format === 'image' && opts.copyAttachments && !f.restricted) {
          const to = posixJoin(attachmentsDir, slugify(sourceLabel.get(d.source) ?? d.source), resolved);
          unit.attachments.push({ from: { source: d.source, path: resolved }, to });
          return `![${text}](${attTok(to)})`;
        }
        return undefined;
      }
      const targetDoc = docByFile.get(k) ?? docByFile.get(`${k}.md`) ?? docByFile.get(`${k}/README.md`) ?? docByFile.get(`${k}/index.md`) ?? docByFile.get(`${k.replace(/\.html?$/, '')}.md`);
      if (targetDoc && byKey.has(targetDoc.unit.key)) {
        if (anchor) {
          const h = headingIn(targetDoc.unit.key, anchor);
          if (h) return lnk(h.key, text, h.title);
        }
        return lnk(targetDoc.unit.key, text);
      }
      const mod = moduleByFile.get(k);
      if (mod && idByKey(mod)) return `${lnk(mod, text)} (${mdCode(resolved)})`;
      if (fileIndex.has(k)) return `${text} (${mdCode(`${sourceLabel.get(d.source) ?? d.source}:${resolved}`)})`;
      return `${text} ⚠️${mdCode(target)}`;
    });
  };

  // ── render bodies ──
  const technologiesOf = (p: ModelProject) => uniq([...p.frameworks.map((f) => f.name), ...p.languages.map(langName)]).sort();
  for (const u of units) {
    const p = projOf(u.projectKey);
    const tags: string[] = [`type/${slugify(u.type)}`];
    if (p && !p.implicit) tags.push(`project/${slugify(p.name.replace(/^@/, ''))}`);
    if (u.status !== 'current') tags.push(`status/${u.status}`);
    u.fm.title = u.title;
    u.fm.type = u.type;
    if (p && u.key !== p.key) u.fm.project = lnk(p.key);

    if (u.group === 'project') {
      const pp = p!;
      u.body = renderProject(pp);
      u.sources = pp.manifests.map((m) => ({ source: pp.source, path: m, hash: fileIndex.get(`${pp.source}:${m}`)?.hash.slice(0, 16) }));
      u.fm.aliases = uniq([pp.name !== projectFile(pp) ? pp.name : '', pp.id !== slugify(pp.name) ? pp.id : '', singleProject ? x(lang, 'home') : ''].filter(Boolean));
      if (pp.version) u.fm.version = pp.version;
      u.fm.technologies = technologiesOf(pp);
      for (const tch of u.fm.technologies as string[]) tags.push(`tech/${slugify(tch)}`);
      tags.push(`kind/${pp.kind}`);
      if (singleProject) tags.push('moc');
      if (pp.partial) u.status = 'current';
      u.confidence = pp.implicit ? 'inferred' : 'verified';
      u.fm.symbols = (moduleNoteFor.get(pp.key) ?? []).flatMap((m) => m.symbols.map((s) => s.sym.name)).slice(0, 100);
    } else if (u.group === 'module') {
      const m = model.modules.find((mm) => mm.key === u.key)!;
      u.body = renderModule(m, p!, false);
      u.sources = m.files.map((f) => ({ source: m.source, path: f.file.path, hash: f.file.hash }));
      u.fm.symbols = m.symbols.map((s) => s.sym.name).slice(0, 100);
      u.fm.technologies = m.languages.map(langName);
      for (const l of m.languages) tags.push(`lang/${slugify(l)}`);
    } else if (u.group === 'api') {
      const a = model.apis.find((aa) => aa.unit.key === u.key)!;
      u.body = renderApi(a, u);
      u.sources = [a.unit.file];
      if (a.unit.version) u.fm.version = a.unit.version;
      u.fm.operations = ((a.entity.attrs.operations as { method: string; path: string }[]) ?? []).map((o) => `${o.method} ${o.path}`).slice(0, 150);
      tags.push('api');
    } else if (u.group === 'doc' || u.group === 'decision' || u.group === 'example') {
      const baseKey = u.key.includes('#part-') ? u.key.split('#part-')[0] : u.key;
      const d = model.docs.find((dd) => dd.unit.key === baseKey)!;
      const parts = docParts.get(baseKey);
      const partBody = u.key.includes('#part-') ? parts!.find((pt) => pt.key === u.key)!.body : parts ? parts[0].body : d.unit.body;
      u.body = renderDoc(d, u, partBody, parts && !u.key.includes('#part-') ? parts : undefined);
      u.sources = [d.unit.file, ...d.duplicates];
      u.fm.source = `${sourceLabel.get(d.source) ?? d.source}:${d.unit.file.path}`;
      if (d.unit.version) {
        u.fm.version = d.unit.version;
        tags.push(`version/${slugify(d.unit.version)}`);
      }
      if (u.group === 'decision' && d.entity.attrs.decisionStatus) u.fm.decision_status = String(d.entity.attrs.decisionStatus);
      if (u.group === 'decision' && /superseded|deprecated|sustituid/i.test(String(d.entity.attrs.decisionStatus ?? ''))) u.status = 'deprecated';
      tags.push(`category/${slugify(d.unit.category ?? 'document')}`);
      if (d.entity.attrs.generator) tags.push(`generated-docs/${slugify(String(d.entity.attrs.generator))}`);
      if (d.flags.includes('untrusted-instructions')) u.status = 'needs-review';
      if (contraByDoc.has(baseKey) && contraByDoc.get(baseKey)!.some((c) => !opts.decisions[c.id])) u.status = 'needs-review';
      if (d.unit.frontmatter && Array.isArray(d.unit.frontmatter.tags)) for (const tg of d.unit.frontmatter.tags) tags.push(slugify(String(tg)));
      if (d.unit.frontmatter && Array.isArray(d.unit.frontmatter.aliases)) u.fm.aliases = (d.unit.frontmatter.aliases as unknown[]).map(String);
    } else if (u.group === 'operations') {
      const list = model.configs.filter((c) => (c.project ?? '') === (u.scope ?? '') && keyToNote.get(c.unit.key) === u.key);
      u.body = renderOperations(list, u.title);
      u.sources = list.map((c) => c.unit.file);
      tags.push('operations');
    } else if (u.key === 'hub:home') {
      u.body = renderHome();
      u.sources = [];
      tags.push('moc');
    } else if (u.key === 'hub:technologies') {
      u.body = renderTechnologies();
      tags.push('moc');
    } else if (u.key === 'hub:decisions') {
      u.body = renderDecisionsIndex();
      tags.push('moc');
    } else if (u.key === 'hub:examples') {
      u.body = renderExamplesIndex();
      tags.push('moc');
    } else if (u.key === 'hub:open-questions') {
      u.body = renderOpenQuestions();
      tags.push('moc');
      u.status = model.contradictions.some((c) => !opts.decisions[c.id]) ? 'needs-review' : 'current';
    }
    // operations folded into this note
    const folded = model.configs.filter((c) => keyToNote.get(c.unit.key) === u.key && u.group !== 'operations');
    if (folded.length) {
      u.body += `\n\n## ${t(lang, 'configuration')}\n\n${folded.map((c) => renderConfigSection(c, 3)).join('\n\n')}`;
      u.sources.push(...folded.map((c) => c.unit.file));
    }
    // verified relations as properties; inferred ones listed in the body only
    const props = relProps.get(u.key);
    if (props) for (const [k, ids] of Object.entries(props)) u.fm[k] = ids.map((id) => linkTok(id)).sort();
    const inf = inferred.filter((r) => keyToNote.get(r.from) === u.key || keyToNote.get(r.to) === u.key);
    if (inf.length && u.group !== 'hub') u.body += `\n\n## ${x(lang, 'possibleRelations')}\n\n> [!question] ${x(lang, 'inferredNote')}\n\n${inf.slice(0, 20).map((r) => `- ${relLine(r)}`).join('\n')}`;
    if (u.status !== 'current' && !tags.includes(`status/${u.status}`)) tags.push(`status/${u.status}`);
    if (u.access === 'restricted') tags.push('access/restricted');
    u.fm.tags = uniq(tags.map((tg) => tg.replace(/[^\p{L}\p{N}_\-/]/gu, '-'))).sort();
    u.fm.vg = {
      id: u.id, key: u.key, origin: u.origin, status: u.status, access: u.access, confidence: u.confidence,
      sources: u.sources.map(srcStr), analyzer: u.analyzer,
    };
  }

  // ── layout & names ──
  const layout = assignLayout(units, model, opts);
  assignNames(units, model);

  return {
    notes: units.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)).map(({ group: _g, projectKey: _p, tree: _t, order: _o, ...n }) => n),
    homeId: byKey.get(homeKey)!.id,
    layout,
    keyToNote: Object.fromEntries(keyToNote),
  };

  // ───────────────────────── renderers ─────────────────────────
  function relLine(r: Relation): string {
    const from = byKey.get(keyToNote.get(r.from) ?? '') ? lnk(r.from) : mdCode(r.from);
    const to = byKey.get(keyToNote.get(r.to) ?? '') ? lnk(r.to) : mdCode(r.to);
    const ev = r.evidence[0];
    return `${from} **${r.type}** ${to} — ${escapeTokens(ev.note ?? '')} (${mdCode(`${ev.ref.path}${ev.ref.lines ? `:${ev.ref.lines[0]}` : ''}`)}) · \`${relationDecisionId(r)}\``;
  }

  function provenance(items: string[]): string {
    return `> [!info]- ${t(lang, 'provenance')}\n${items.map((i) => `> - ${i}`).join('\n')}`;
  }

  function renderProject(pp: ModelProject): string {
    const out: string[] = [`# ${pp.name}`];
    const facts = [`**${t(lang, 'kind')}:** ${pp.kind}`, `**Ecosystem:** ${pp.ecosystem}`];
    if (pp.version) facts.push(`**${t(lang, 'version')}:** \`${pp.version}\``);
    if (pp.path !== '.') facts.push(`**${t(lang, 'path')}:** \`${pp.path}\``);
    if (model.sources.length > 1) facts.push(`**Source:** ${sourceLabel.get(pp.source)}`);
    out.push(facts.join(' · '));
    if (pp.partial) out.push(`> [!note] ${x(lang, 'partial')}`);
    // purpose: declared description and README paragraph, both cited
    const purpose: string[] = [];
    if (pp.description) purpose.push(`${escapeTokens(pp.description)} — ${mdCode(pp.manifests[0] ?? '')}`);
    const readme = pp.readme ? model.docs.find((d) => d.unit.key === pp.readme) : undefined;
    const para = readme ? parseMarkdown(readme.unit.body).firstParagraph : undefined;
    if (para && para !== pp.description) purpose.push(`> ${escapeTokens(truncate(para, 600))}\n> — ${x(lang, 'fromReadme')}: ${lnk(readme!.unit.key)}`);
    out.push(`## ${t(lang, 'purpose')}\n\n${purpose.length ? purpose.join('\n\n') : `*${x(lang, 'noDescription')}*`}`);
    if (singleProject && model.docVersions.length > 1) out.push(`**${x(lang, 'versionsDocs')}:** ${model.docVersions.map((v) => (v === model.defaultVersion ? `\`${v}\` (${x(lang, 'defaultVersion')})` : `\`${v}\``)).join(', ')}`);
    if (pp.frameworks.length || pp.languages.length) {
      const rows = [...pp.frameworks.map((f) => [f.name, f.version ? `\`${f.version}\`` : '', mdCode(f.evidence)]), ...pp.languages.map((l) => [langName(l), '', t(lang, 'evidence') === 'Evidencia' ? 'archivos fuente' : 'source files'])];
      out.push(`## ${t(lang, 'technologies')}\n\n${mdTable([t(lang, 'name'), t(lang, 'version'), t(lang, 'evidence')], rows)}`);
    }
    const deps = model.relations.filter((r) => r.type === 'depends-on' && r.from === pp.key && r.to.startsWith('project:'));
    const usedBy = model.relations.filter((r) => r.type === 'depends-on' && r.to === pp.key && r.from.startsWith('project:'));
    if (deps.length) out.push(`## ${t(lang, 'internalDeps')}\n\n${deps.map((r) => `- ${lnk(r.to)} — ${escapeTokens(r.evidence[0].note ?? '')}`).join('\n')}`);
    if (usedBy.length) out.push(`## ${t(lang, 'usedBy')}\n\n${usedBy.map((r) => `- ${lnk(r.from)} — ${escapeTokens(r.evidence[0].note ?? '')}`).join('\n')}`);
    const ext = pp.dependencies.filter((d) => !d.internal);
    const prod = ext.filter((d) => d.kind === 'prod' || d.kind === 'peer');
    const dev = ext.filter((d) => d.kind === 'dev' || d.kind === 'build');
    if (ext.length && !pp.partial) {
      const shown = opts.depth === 'shallow' ? prod.slice(0, 15) : prod;
      out.push(`## ${t(lang, 'externalDeps')}\n\n${mdTable([t(lang, 'name'), t(lang, 'version'), t(lang, 'kind')], shown.map((d) => [mdCode(d.name), d.range ? mdCode(d.range) : '', d.kind]))}${dev.length ? `\n\n<details><summary>${x(lang, 'devDeps', { n: dev.length })}</summary>\n\n${dev.map((d) => `\`${d.name}\`${d.range ? ` ${d.range}` : ''}`).join(', ')}\n\n</details>` : ''}`.replace('\n\n\n\n', '\n\n'));
    }
    if (Object.keys(pp.scripts).length && !pp.partial) out.push(`## ${t(lang, 'scripts')}\n\n${mdTable([t(lang, 'name'), 'Command'], Object.entries(pp.scripts).sort(byStr((e) => e[0])).map(([k, v]) => [mdCode(k), mdCode(truncate(v, 160))]))}`);
    if (pp.entryPoints.length && !pp.partial) out.push(`## ${t(lang, 'entryPoints')}\n\n${uniq(pp.entryPoints).map((e) => `- ${mdCode(e)}`).join('\n')}`);
    // modules / API
    const mods = model.modules.filter((m) => m.project === pp.key);
    if (mods.length && !pp.partial) {
      const folded = moduleNoteFor.get(pp.key);
      if (folded) {
        if (folded.length) out.push(`## ${t(lang, 'symbols')}\n\n${folded.map((m) => renderModule(m, pp, true)).join('\n\n')}`);
        const others = mods.filter((m) => !folded.includes(m));
        if (others.length) out.push(`## ${t(lang, 'structure')}\n\n${others.map((m) => `- ${mdCode(m.dir || '.')} — ${m.files.length} ${x(lang, 'files').toLowerCase()}${m.tests.length ? `, ${m.tests.length} ${x(lang, 'tests').toLowerCase()}` : ''}`).join('\n')}`);
      } else {
        out.push(`## ${t(lang, 'modules')}\n\n*${x(lang, 'structureNote')}*\n\n${mdTable([t(lang, 'name'), x(lang, 'files'), x(lang, 'exported'), t(lang, 'description')], mods.map((m) => [byKey.has(m.key) ? lnk(m.key, m.rel || '.') : mdCode(m.rel || '.'), String(m.files.length), String(m.symbols.length + m.routes.length), escapeTokens(truncate(m.moduleDoc ?? '', 120))]))}`);
      }
    }
    const apis = model.apis.filter((a) => a.project === pp.key);
    if (apis.length) out.push(`## ${t(lang, 'apis')}\n\n${apis.map((a) => `- ${lnk(a.unit.key)} — ${escapeTokens(a.entity.summary ?? '')}`).join('\n')}`);
    const docs = model.docs.filter((d) => d.project === pp.key && d.unit.category !== 'decision' && d.unit.category !== 'example');
    if (docs.length) out.push(`## ${t(lang, 'documents')}\n\n${docs.slice(0, 60).map((d) => `- ${lnk(d.unit.key)}${d.unit.version ? ` (\`${d.unit.version}\`)` : ''}`).join('\n')}${docs.length > 60 ? `\n- … ${docs.length - 60}` : ''}`);
    const decs = model.docs.filter((d) => d.project === pp.key && d.unit.category === 'decision');
    if (decs.length) out.push(`## ${t(lang, 'decisions')}\n\n${decs.map((d) => `- ${lnk(d.unit.key)}${d.entity.attrs.decisionStatus ? ` — *${d.entity.attrs.decisionStatus}*` : ''}`).join('\n')}`);
    const exs = [...model.docs.filter((d) => d.project === pp.key && d.unit.category === 'example').map((d) => d.unit.key), ...model.relations.filter((r) => r.type === 'exemplifies' && r.to === pp.key && r.status !== 'inferred').map((r) => r.from)];
    if (exs.length) out.push(`## ${t(lang, 'examples')}\n\n${uniq(exs).map((k) => `- ${lnk(k)}`).join('\n')}`);
    const ops = opsNoteFor.get(pp.key);
    if (ops && ops !== pp.key) out.push(`## ${t(lang, 'configuration')}\n\n- ${lnk(ops)}`);
    if (!singleProject) out.push(`${t(lang, 'workspace')}: ${lnk('hub:home')}`);
    else if (hasTechNote || hasOpen) out.push([hasTechNote ? lnk('hub:technologies') : '', hasOpen ? lnk('hub:open-questions') : ''].filter(Boolean).join(' · '));
    out.push(provenance([...pp.manifests.map((m) => `${x(lang, 'manifest')}: ${mdCode(`${sourceLabel.get(pp.source)}:${m}`)}`), `${x(lang, 'kindEvidence')}: ${pp.kindEvidence.map(escapeTokens).join('; ') || '—'}`]));
    return out.join('\n\n');
  }

  function renderSymbol(s: ModelModule['symbols'][number], lvl: number): string {
    const sym = s.sym;
    const lang2 = /\.py$/.test(s.file) ? 'python' : /\.go$/.test(s.file) ? 'go' : /\.rs$/.test(s.file) ? 'rust' : /\.(java)$/.test(s.file) ? 'java' : /\.kts?$/.test(s.file) ? 'kotlin' : /\.cs$/.test(s.file) ? 'csharp' : /\.(php)$/.test(s.file) ? 'php' : /\.swift$/.test(s.file) ? 'swift' : 'ts';
    const head = `${'#'.repeat(lvl)} ${sym.name} · ${sym.kind}`;
    const parts = [head, fence(sym.signature, lang2)];
    if (sym.doc) parts.push(escapeTokens(sym.doc));
    const meta = [`*${x(lang, 'definedIn')}* ${mdCode(`${s.file}:${sym.line}`)}`];
    if (sym.attrs?.deprecated) meta.push(`**${x(lang, 'deprecated')}**${typeof sym.attrs.deprecated === 'string' ? `: ${escapeTokens(sym.attrs.deprecated)}` : ''}`);
    if (sym.attrs?.since) meta.push(`since \`${sym.attrs.since}\``);
    if (sym.attrs?.selector) meta.push(`selector \`${sym.attrs.selector}\``);
    if (sym.decorators?.length) meta.push(sym.decorators.map((d) => mdCode(truncate(d, 80))).join(' '));
    parts.push(meta.join(' · '));
    if (sym.members?.length) parts.push(mdTable([x(lang, 'members'), t(lang, 'kind'), 'Signature'], sym.members.slice(0, 60).map((m) => [mdCode(m.name), m.kind, mdCode(truncate(m.signature, 140))])));
    if (sym.attrs?.example) parts.push(fence(String(sym.attrs.example), lang2));
    return parts.join('\n\n');
  }

  function renderModule(m: ModelModule, pp: ModelProject, inline: boolean): string {
    const lvl = inline ? 4 : 3;
    const out: string[] = [];
    if (inline) out.push(`### ${mdCode(m.rel || '.')}`);
    else {
      out.push(`# ${pp.name} › ${m.rel || '.'}`);
      out.push(`**Project:** ${lnk(pp.key)} · **${t(lang, 'path')}:** ${mdCode(m.dir || '.')} · ${m.languages.map(langName).join(', ')}`);
    }
    if (m.moduleDoc) out.push(escapeTokens(m.moduleDoc));
    const syms = m.symbols.slice().sort((a, b) => a.file.localeCompare(b.file) || a.sym.line - b.sym.line);
    const shown = syms.slice(0, limitSymbols);
    if (shown.length) {
      if (!inline) out.push(`## ${t(lang, 'symbols')}`);
      out.push(shown.map((s) => renderSymbol(s, lvl)).join('\n\n'));
      if (syms.length > shown.length) out.push(`*${x(lang, 'capped', { n: shown.length, m: syms.length })}*`);
    }
    if (m.routes.length) out.push(`${'#'.repeat(inline ? 4 : 2)} ${x(lang, 'routes')}\n\n${mdTable([x(lang, 'method'), t(lang, 'path'), x(lang, 'handler'), x(lang, 'location')], m.routes.map((r) => [String(r.sym.attrs?.method ?? ''), mdCode(String(r.sym.attrs?.path ?? '')), r.sym.attrs?.handler ? mdCode(String(r.sym.attrs.handler)) : '', mdCode(`${r.file}:${r.sym.line}`)]))}`);
    if (!inline) {
      const deps = model.relations.filter((r) => r.type === 'depends-on' && r.from === m.key && r.status === 'verified');
      const used = model.relations.filter((r) => r.type === 'depends-on' && r.to === m.key && r.status === 'verified');
      if (deps.length) out.push(`## ${t(lang, 'dependencies')}\n\n${deps.map((r) => `- ${lnk(r.to)} — ${escapeTokens(r.evidence[0].note ?? '')} (${mdCode(`${r.evidence[0].ref.path}:${r.evidence[0].ref.lines?.[0] ?? ''}`)})`).join('\n')}`);
      if (used.length) out.push(`## ${t(lang, 'usedBy')}\n\n${uniq(used.map((r) => keyToNote.get(r.from) ?? r.from)).map((k) => `- ${lnk(k)}`).join('\n')}`);
      const docsFor = model.relations.filter((r) => r.type === 'documents' && r.to === m.key && r.status !== 'inferred');
      if (docsFor.length) out.push(`## ${t(lang, 'documents')}\n\n${docsFor.map((r) => `- ${lnk(r.from)}`).join('\n')}`);
      if (m.tests.length) out.push(`## ${x(lang, 'tests')}\n\n${m.tests.slice(0, 15).map((tt) => `- ${mdCode(tt)}`).join('\n')}${m.tests.length > 15 ? `\n- … ${m.tests.length - 15}` : ''}`);
      out.push(provenance([`${x(lang, 'analyzer')}: \`code@1\` (static, declarations only)`, ...m.files.slice(0, 20).map((f) => mdCode(`${sourceLabel.get(m.source)}:${f.file.path}`)), ...(m.files.length > 20 ? [`… ${m.files.length - 20}`] : [])]));
    } else if (m.tests.length) out.push(`*${x(lang, 'tests')}: ${m.tests.length}*`);
    return out.join('\n\n');
  }

  function renderApi(a: ModelDoc, u: Unit): string {
    const out = [`# ${a.unit.title}`, escapeTokens(a.unit.body)];
    const impl = model.relations.filter((r) => r.type === 'implements' && r.to === a.unit.key && r.status !== 'inferred');
    const cons = model.relations.filter((r) => r.type === 'consumes' && r.to === a.unit.key && r.status !== 'inferred');
    if (impl.length) out.push(`## ${x(lang, 'implementedBy')}\n\n${impl.map((r) => `- ${lnk(r.from)} — ${escapeTokens(r.evidence[0].note ?? '')}`).join('\n')}`);
    if (cons.length) out.push(`## ${x(lang, 'consumedBy')}\n\n${cons.map((r) => `- ${lnk(r.from)} — ${escapeTokens(r.evidence[0].note ?? '')}`).join('\n')}`);
    if (a.project) out.push(`Project: ${lnk(a.project)}`);
    if (u.access === 'restricted') out.unshift(`> [!warning] ${x(lang, 'restrictedNote')}`);
    out.push(provenance([`${x(lang, 'importedFrom')} ${mdCode(`${sourceLabel.get(a.source)}:${a.unit.file.path}`)}`, `${x(lang, 'analyzer')}: \`openapi@1\``, ...a.unit.lossy.map((l) => `${x(lang, 'conversion')}: ${escapeTokens(l)}`)]));
    return out.join('\n\n');
  }

  function renderDoc(d: ModelDoc, u: Unit, body: string, parts?: { key: string; title: string }[]): string {
    const out: string[] = [];
    const contras = contraByDoc.get(d.unit.key) ?? [];
    for (const c of contras) {
      const dec = opts.decisions[c.id];
      if (dec && dec.answer !== 'keep-both') out.push(`> [!check] ${x(lang, 'resolved')}\n> ${escapeTokens(c.detail)}\n> → ${escapeTokens(dec.answer)}`);
      else out.push(`> [!warning] ${x(lang, 'contradiction')}\n> ${escapeTokens(c.detail)}${c.suggested ? `\n> Suggested authority: ${escapeTokens(c.suggested)}` : ''}\n> ${hasOpen ? lnk('hub:open-questions') : ''}`);
    }
    if (d.flags.includes('untrusted-instructions')) out.push(`> [!danger] ${x(lang, 'untrustedNote')}`);
    if (u.access === 'restricted') out.push(`> [!warning] ${x(lang, 'restrictedNote')}`);
    let content = rewriteDoc(d, body, u);
    if (!/^#\s+\S/m.test(content.split('\n').slice(0, 5).join('\n'))) content = `# ${u.title}\n\n${content}`;
    out.push(content);
    if (parts) out.push(`## ${x(lang, 'parts')}\n\n${parts.map((pt) => `- ${lnk(pt.key, pt.title)}`).join('\n')}`);
    if (u.key.includes('#part-')) out.push(`↑ ${lnk(d.unit.key)}`);
    const prov = [`${x(lang, 'importedFrom')} ${mdCode(`${sourceLabel.get(d.source) ?? d.source}:${d.unit.file.path}`)} (${d.analyzer})`];
    if (d.project) prov.push(`Project: ${lnk(d.project)}`);
    if (d.duplicates.length) prov.push(`${x(lang, 'alsoAt')}: ${d.duplicates.map((r) => mdCode(`${sourceLabel.get(r.source)}:${r.path}`)).join(', ')}`);
    if (d.entity.attrs.generator) prov.push(`Generator: \`${d.entity.attrs.generator}\` (${escapeTokens(String(d.entity.attrs.region ?? ''))})`);
    for (const l of d.unit.lossy) prov.push(`${x(lang, 'conversion')}: ${escapeTokens(l)}`);
    out.push(provenance(prov));
    return out.join('\n\n');
  }

  function renderConfigSection(c: ModelDoc, lvl: number): string {
    return `${'#'.repeat(lvl)} ${c.unit.title}\n\n${escapeTokens(c.entity.summary ?? '')}\n\n${escapeTokens(c.unit.body)}\n\n*${t(lang, 'sources')}:* ${mdCode(`${sourceLabel.get(c.source) ?? c.source}:${c.unit.file.path}`)}`;
  }
  function renderOperations(list: ModelDoc[], title: string): string {
    const scopeKey = list[0]?.project;
    const head = [`# ${title}`];
    if (scopeKey) head.push(`Project: ${lnk(scopeKey)}`);
    const groups = new Map<string, ModelDoc[]>();
    for (const c of list) groups.set(c.unit.category ?? 'configuration', [...(groups.get(c.unit.category ?? 'configuration') ?? []), c]);
    const label: Record<string, string> = { infrastructure: t(lang, 'infrastructure'), ci: 'CI/CD', configuration: t(lang, 'configuration') };
    for (const [g, l] of [...groups.entries()].sort(byStr((e) => e[0]))) head.push(`## ${label[g] ?? g}\n\n${l.map((c) => renderConfigSection(c, 3)).join('\n\n')}`);
    return head.join('\n\n');
  }

  function renderHome(): string {
    const out = [`# ${model.name}`];
    const kindLabel: Record<string, string> = { 'single-project': 'single project', monorepo: 'monorepo', 'multi-repo-workspace': 'multi-repository workspace', 'docs-only': 'documentation', 'existing-vault': 'existing vault', mixed: 'mixed workspace', unknown: 'unknown structure' };
    out.push(`> [!abstract] ${x(lang, 'context')}\n> ${kindLabel[model.kind] ?? model.kind} · ${realProjects.length} ${t(lang, 'projects').toLowerCase()} · ${model.docs.length} ${t(lang, 'documents').toLowerCase()} · ${model.apis.length} API\n> ${t(lang, 'sources')}: ${model.sources.map((s) => `${s.label} (${s.kind})`).join(', ')}${model.scopeMode === 'projects' ? `\n> ${x(lang, 'scope')}: ${selected.map((p) => p.name).join(', ')}` : ''}`);
    const projs = model.projects.filter((p) => !p.implicit || model.projects.length === 1);
    if (projs.length) out.push(`## ${t(lang, 'projects')}\n\n${mdTable([t(lang, 'name'), t(lang, 'kind'), 'Ecosystem', t(lang, 'version'), t(lang, 'description')], projs.map((p) => [lnk(p.key), p.kind + (p.partial ? ' *(overview)*' : ''), p.ecosystem, p.version ? mdCode(p.version) : '', escapeTokens(truncate(oneLine(p.description ?? ''), 120))]))}`);
    const edges = model.relations.filter((r) => r.type === 'depends-on' && r.from.startsWith('project:') && r.to.startsWith('project:') && r.status !== 'inferred');
    const crossInferred = model.relations.filter((r) => r.type === 'consumes' && r.status === 'confirmed');
    if (edges.length && model.projects.length <= 40) {
      const nid = (k: string) => `p${sha256(k).slice(0, 6)}`;
      const nodes = uniq(edges.flatMap((e) => [e.from, e.to]));
      const lines = ['graph LR', ...nodes.map((k) => `  ${nid(k)}["${(projOf(k)?.name ?? k).replace(/"/g, "'")}"]`), ...edges.map((e) => `  ${nid(e.from)} --> ${nid(e.to)}`), ...crossInferred.map((e) => `  ${nid(e.from)} -. consumes .-> ${nid(keyToNote.get(e.to) ?? e.to)}`)];
      out.push(`## ${x(lang, 'graph')}\n\n${fence(lines.join('\n'), 'mermaid')}`);
    }
    const wsDocs = model.docs.filter((d) => !d.project && d.unit.category !== 'decision' && d.unit.category !== 'example');
    if (wsDocs.length) out.push(`## ${t(lang, 'documents')}\n\n${wsDocs.slice(0, 60).map((d) => `- ${lnk(d.unit.key)}${d.unit.version ? ` (\`${d.unit.version}\`)` : ''}`).join('\n')}${wsDocs.length > 60 ? `\n- … ${wsDocs.length - 60}` : ''}`);
    if (model.docVersions.length > 1) out.push(`**${x(lang, 'versionsDocs')}:** ${model.docVersions.map((v) => (v === model.defaultVersion ? `\`${v}\` (${x(lang, 'defaultVersion')})` : `\`${v}\``)).join(', ')}`);
    if (model.apis.length) out.push(`## ${t(lang, 'apis')}\n\n${model.apis.map((a) => `- ${lnk(a.unit.key)} — ${escapeTokens(a.entity.summary ?? '')}`).join('\n')}`);
    if (decisions.length) out.push(`## ${t(lang, 'decisions')}\n\n${decisions.length >= 3 ? `- ${lnk('hub:decisions')}` : decisions.map((d) => `- ${lnk(d.unit.key)}`).join('\n')}`);
    if (exampleDocs.length + exampleProjects.length) out.push(`## ${t(lang, 'examples')}\n\n${exampleDocs.length + exampleProjects.length >= 3 ? `- ${lnk('hub:examples')}` : [...exampleDocs.map((d) => d.unit.key), ...exampleProjects.map((p) => p.key)].map((k) => `- ${lnk(k)}`).join('\n')}`);
    const wsOps = opsNoteFor.get('');
    if (wsOps && wsOps !== 'hub:home') out.push(`## ${t(lang, 'configuration')}\n\n- ${lnk(wsOps)}`);
    const see = [hasTechNote ? lnk('hub:technologies') : '', hasOpen ? lnk('hub:open-questions') : ''].filter(Boolean);
    if (see.length) out.push(`## ${t(lang, 'related')}\n\n${see.map((s) => `- ${s}`).join('\n')}`);
    return out.join('\n\n');
  }

  function renderTechnologies(): string {
    const rows = Object.entries(model.technologies).sort(byStr((e) => e[0])).map(([name, info]) => [name, info.versions.map((v) => mdCode(v)).join(', '), info.projects.map((k) => lnk(k)).join(', '), escapeTokens(info.evidence.slice(0, 2).map((e) => mdCode(e)).join('; '))]);
    return `# ${x(lang, 'technologies')}\n\n${mdTable([t(lang, 'name'), t(lang, 'versions'), t(lang, 'projects'), t(lang, 'evidence')], rows)}\n\n${lnk(homeKey)}`;
  }
  function renderDecisionsIndex(): string {
    return `# ${x(lang, 'decisions')}\n\n${mdTable(['ADR', x(lang, 'status'), 'Project'], decisions.map((d) => [lnk(d.unit.key), String(d.entity.attrs.decisionStatus ?? ''), d.project ? lnk(d.project) : '']))}\n\n${lnk(homeKey)}`;
  }
  function renderExamplesIndex(): string {
    const lines = [...exampleProjects.map((p) => `- ${lnk(p.key)} — ${p.kind}${p.description ? `: ${escapeTokens(p.description)}` : ''}`), ...exampleDocs.map((d) => `- ${lnk(d.unit.key)}${d.project ? ` (${lnk(d.project)})` : ''}`)];
    return `# ${x(lang, 'examples')}\n\n${lines.join('\n')}\n\n${lnk(homeKey)}`;
  }
  function renderOpenQuestions(): string {
    const out = [`# ${x(lang, 'openQuestions')}`];
    if (model.contradictions.length) {
      out.push(`## ${t(lang, 'openQuestions')}\n\n${model.contradictions.map((c) => {
        const dec = opts.decisions[c.id];
        const claims = c.claims.map((cl) => {
          const dk = `doc:${cl.ref.source}:${cl.ref.path}`;
          return `  - "${escapeTokens(cl.value)}" — ${byKey.has(dk) ? lnk(dk) : mdCode(cl.ref.path)}${cl.ref.lines ? ` (line ${cl.ref.lines[0]})` : ''} · ${cl.authority}`;
        });
        return `### ${escapeTokens(c.subject)}${c.scope ? ` · ${projOf(c.scope)?.name ?? ''}` : ''}\n\n- ${escapeTokens(c.detail)}\n${claims.join('\n')}\n- ${dec ? `**${x(lang, 'resolved')}:** ${escapeTokens(dec.answer)}` : `Decision id: \`${c.id}\`${c.suggested ? ` · suggested: ${escapeTokens(c.suggested)}` : ''}`}`;
      }).join('\n\n')}`);
    }
    if (inferred.length) out.push(`## ${x(lang, 'possibleRelations')}\n\n> [!question] ${x(lang, 'inferredNote')}\n\n${inferred.slice(0, 50).map((r) => `- ${relLine(r)}`).join('\n')}`);
    const partial = model.projects.filter((p) => p.partial);
    if (partial.length) out.push(`## ${x(lang, 'partial')}\n\n${partial.map((p) => `- ${lnk(p.key)}`).join('\n')}`);
    if (model.brokenLinks.length) out.push(`## ${x(lang, 'brokenLinks')}\n\n${model.brokenLinks.slice(0, 80).map((b) => `- ${byKey.has(b.doc) ? lnk(b.doc) : mdCode(b.doc)} line ${b.line}: ${mdCode(b.target)}`).join('\n')}`);
    if (model.unsupported.length) out.push(`## ${x(lang, 'unsupported')}\n\n${model.unsupported.slice(0, 80).map((u) => `- ${mdCode(`${sourceLabel.get(u.source)}:${u.path}`)} (${u.ext} — no reliable converter installed)`).join('\n')}`);
    if (model.excludedRestricted.length) out.push(`## ${x(lang, 'excluded')}\n\n${model.excludedRestricted.length} document(s) were detected as restricted and excluded by decision.`);
    if (model.injectionFlags.length) out.push(`## ${x(lang, 'untrusted')}\n\n${model.injectionFlags.map((f) => { const k = `doc:${f}`; return `- ${byKey.has(k) ? lnk(k) : mdCode(f)}`; }).join('\n')}`);
    const lim = model.limitations.filter((l) => byKey.has(`doc:${l.ref.source}:${l.ref.path}`) || byKey.has(`api:${l.ref.source}:${l.ref.path}`));
    if (lim.length) out.push(`## ${t(lang, 'limitations')}\n\n${lim.slice(0, 80).map((l) => { const k = byKey.has(`doc:${l.ref.source}:${l.ref.path}`) ? `doc:${l.ref.source}:${l.ref.path}` : `api:${l.ref.source}:${l.ref.path}`; return `- ${lnk(k)}: ${l.items.map(escapeTokens).join('; ')}`; }).join('\n')}`);
    if (out.length === 1) out.push(x(lang, 'none'));
    out.push(lnk(homeKey));
    return out.join('\n\n');
  }
}

function buildRelationProps(relations: Relation[], keyToNote: Map<string, string>, byKey: Map<string, Unit>): Map<string, Record<string, string[]>> {
  const out = new Map<string, Record<string, string[]>>();
  const FWD: Record<string, [string, string]> = {
    'depends-on': ['depends_on', 'used_by'], 'belongs-to': ['belongs_to', ''], implements: ['implements', 'implemented_by'], exposes: ['exposes', 'exposed_by'],
    consumes: ['consumes', 'consumed_by'], documents: ['documents', 'documented_by'], exemplifies: ['exemplifies', 'exemplified_by'], supersedes: ['supersedes', 'superseded_by'],
    'derives-from': ['derives_from', ''], 'relates-to': ['relates_to', 'relates_to'],
  };
  const push = (noteKey: string, prop: string, targetKey: string) => {
    const target = byKey.get(targetKey);
    if (!prop || !target || noteKey === targetKey) return;
    const rec = out.get(noteKey) ?? {};
    rec[prop] = uniq([...(rec[prop] ?? []), target.id]);
    out.set(noteKey, rec);
  };
  for (const r of relations) {
    if (r.status === 'inferred') continue;
    const props = FWD[r.type] ?? ['relates_to', 'relates_to'];
    const a = keyToNote.get(r.from);
    const b = keyToNote.get(r.to);
    if (!a || !b || a === b) continue;
    // module → module dependencies are shown in the body; properties keep project-level edges and module → project edges
    push(a, props[0], b);
    push(b, props[1], a);
  }
  return out;
}

function commonPrefix(rels: string[]): string {
  if (rels.length < 2) return rels[0]?.split('/')[0] === 'src' ? 'src' : '';
  const parts = rels.map((r) => r.split('/'));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const seg = parts[0][i];
    if (seg === undefined || !parts.every((p) => p[i] === seg && p.length > i + 1)) break;
    out.push(seg);
  }
  return out.join('/');
}
function displayRel(rel: string, strip: string): string {
  if (!rel) return '.';
  if (strip && rel.startsWith(`${strip}/`)) return rel.slice(strip.length + 1);
  if (strip && rel === strip) return posixBase(rel);
  return rel;
}

/** Path of a document inside its documentation tree (doc root and the project path stripped). */
function docTreePath(d: ModelDoc, model: Model): string {
  const proj = model.projects.find((p) => p.key === d.project);
  let rel = d.unit.file.path;
  if (proj && proj.path !== '.' && rel.startsWith(`${proj.path}/`)) rel = rel.slice(proj.path.length + 1);
  const segs = rel.split('/');
  while (segs.length > 1 && /^(docs?|documentation|doc-site|website|site|content|pages|src)$/i.test(segs[0])) segs.shift();
  return segs.join('/');
}

function assignLayout(units: Unit[], model: Model, opts: PlanOptions): Plan['layout'] {
  const F = FOLDERS[opts.language];
  const base = opts.baseFolder;
  const minGroup = Math.max(2, Math.min(opts.folderThreshold, 3));
  const projects = model.projects.filter((p) => !p.implicit);
  const multi = projects.length >= 2 || model.sources.length >= 2;
  let strategy: string;
  const folders: Record<string, string> = {};
  const docFolder = (u: Unit, prefix: string) => {
    const dir = posixDir(u.tree ?? '');
    return posixJoin(prefix, dir.split('/').filter(Boolean).map((s) => sanitizeFileName(s)).join('/'));
  };
  const placeGroupInside = (list: Unit[], root: string) => {
    const counts = new Map<Group, number>();
    for (const u of list) counts.set(u.group, (counts.get(u.group) ?? 0) + 1);
    for (const u of list) {
      if (u.group === 'project' || u.group === 'hub' || u.group === 'operations') u.folder = root;
      else {
        const n = counts.get(u.group) ?? 0;
        const own = n >= minGroup;
        const gf = u.group === 'module' ? F.modules : u.group === 'doc' ? F.doc : u.group === 'api' ? F.api : u.group === 'decision' ? F.decision : F.example;
        const groupRoot = own ? posixJoin(root, gf) : root;
        if (own) folders[u.group] = gf;
        u.folder = u.group === 'doc' || u.group === 'example' || u.group === 'decision' ? (own ? docFolder(u, groupRoot) : groupRoot) : groupRoot;
      }
    }
  };
  if (units.length <= 12) {
    strategy = 'flat';
    for (const u of units) u.folder = base;
  } else if (!multi) {
    strategy = 'by-category';
    placeGroupInside(units, base);
  } else {
    strategy = projects.length > 8 ? 'by-project-kind' : 'by-project';
    const bySource = new Map<string, number>();
    for (const p of projects) bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
    const kindCounts = new Map<string, number>();
    for (const p of projects) kindCounts.set(p.kind, (kindCounts.get(p.kind) ?? 0) + 1);
    const projectRoot = (key: string | undefined): string | undefined => {
      const p = model.projects.find((pp) => pp.key === key);
      if (!p || p.implicit) return undefined;
      let root = base;
      if (model.sources.length > 1 && (bySource.get(p.source) ?? 0) > 1) root = posixJoin(root, sanitizeFileName(model.sources.find((s) => s.id === p.source)?.label ?? p.source));
      if (projects.length > 8) root = posixJoin(root, (kindCounts.get(p.kind) ?? 0) >= 2 ? F[p.kind] ?? F.unknown : F.projects);
      return posixJoin(root, projectFile(p));
    };
    const byProject = new Map<string, Unit[]>();
    const workspace: Unit[] = [];
    for (const u of units) {
      const r = u.group === 'hub' ? undefined : projectRoot(u.projectKey);
      if (r) byProject.set(r, [...(byProject.get(r) ?? []), u]);
      else workspace.push(u);
    }
    for (const [root, list] of byProject) placeGroupInside(list, root);
    const wsDocs = workspace.filter((u) => u.group !== 'hub' && u.group !== 'operations' && u.group !== 'project');
    for (const u of workspace) u.folder = base;
    if (wsDocs.length >= minGroup) {
      folders.workspace = F.workspace;
      placeGroupInside(wsDocs, posixJoin(base, F.workspace));
    }
  }
  // collapse folders holding fewer than 2 notes (no near-empty folders)
  for (let pass = 0; pass < 8; pass++) {
    const counts = new Map<string, number>();
    for (const u of units) {
      let f = u.folder;
      while (f && f !== base) {
        counts.set(f, (counts.get(f) ?? 0) + 1);
        f = posixDir(f);
      }
    }
    let changed = false;
    for (const u of units) {
      if (u.folder && u.folder !== base && (counts.get(u.folder) ?? 0) < 2) {
        u.folder = posixDir(u.folder) || base;
        if (base && !u.folder.startsWith(base)) u.folder = base;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { strategy, folders };
}

function assignNames(units: Unit[], model: Model): void {
  const taken = new Set<string>(); // lowercase basenames (global uniqueness keeps wikilinks short and unambiguous)
  const ordered = units.slice().sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  for (const u of ordered) {
    const p = model.projects.find((pp) => pp.key === u.projectKey);
    let base = u.fileName || (u.group === 'project' && p ? projectFile(p) : sanitizeFileName(u.title));
    const cands = [base];
    if (p && u.group !== 'project') cands.push(sanitizeFileName(`${base} (${projectFile(p)})`));
    const dirName = posixBase(posixDir(u.tree ?? '')) || posixBase(u.folder);
    if (dirName) cands.push(sanitizeFileName(`${base} (${dirName})`));
    let chosen = cands.find((c) => !taken.has(c.toLowerCase()));
    for (let n = 2; !chosen; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) chosen = `${base} ${n}`;
    base = chosen;
    taken.add(base.toLowerCase());
    u.fileName = base;
  }
}
