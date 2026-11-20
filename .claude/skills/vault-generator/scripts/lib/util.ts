import { createHash } from 'node:crypto';
import path from 'node:path';

export const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
export const shortHash = (s: string, n = 10): string => sha256(s).slice(0, n);

export const toPosix = (p: string): string => p.replace(/\\/g, '/');
export const posixJoin = (...parts: string[]): string =>
  path.posix.normalize(parts.filter((p) => p !== '').join('/')).replace(/^\.\/?$/, '').replace(/^\.\//, '');
export const posixDir = (p: string): string => {
  const d = path.posix.dirname(p);
  return d === '.' ? '' : d;
};
export const posixBase = (p: string): string => path.posix.basename(p);
export const extOf = (p: string): string => path.posix.extname(p).toLowerCase();

export function normalizeText(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Stable, readable slug (unicode-aware, accents stripped). */
export function slugify(s: string, max = 80): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return out || 'x';
}
/** Heading anchor compatible with Obsidian ([[Note#Heading]] keeps the heading text itself). */
export function headingSlug(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** File-system and Obsidian safe note name (without extension). */
export function sanitizeFileName(s: string, max = 100): string {
  let out = s
    .normalize('NFC')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (out.length > max) out = out.slice(0, max).trim();
  if (!out) out = 'Untitled';
  if (RESERVED.test(out)) out = `${out}_`;
  return out;
}

/** gitignore-like glob → RegExp. Patterns without '/' match at any depth. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\/+$/, '');
  // gitignore semantics: a pattern is anchored when it has a slash other than a trailing one
  const anchored = g.startsWith('/') || (g.includes('/') && !g.startsWith('**/'));
  g = g.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        re += `(?:${g
          .slice(i + 1, end)
          .split(',')
          .map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`;
        i = end;
      } else re += '\\{';
    } else if ('.+^$()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`, 'i');
}
const globCache = new Map<string, RegExp>();
export function matchGlob(glob: string, rel: string): boolean {
  let re = globCache.get(glob);
  if (!re) globCache.set(glob, (re = globToRegExp(glob)));
  return re.test(rel);
}
export const matchAny = (globs: string[], rel: string): boolean => globs.some((g) => matchGlob(g, rel));

export function stableStringify(v: unknown, indent = 2): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as object).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val !== undefined) o[k] = norm(val);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(v), null, indent);
}

export const uniq = <T>(a: T[]): T[] => [...new Set(a)];
export function groupBy<T>(a: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of a) {
    const k = f(x);
    const l = m.get(k);
    if (l) l.push(x);
    else m.set(k, [x]);
  }
  return m;
}
export const byStr = <T>(f: (x: T) => string) => (a: T, b: T): number => f(a).localeCompare(f(b), 'en');
export const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Split camelCase / snake_case / kebab-case identifiers into words for text search. */
export function splitIdent(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./:]+/g, ' ')
    .toLowerCase();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function escapeMdTable(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
export function mdCode(s: string): string {
  const t = s.replace(/\n/g, ' ');
  return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
}
export function fence(code: string, lang = ''): string {
  let ticks = '```';
  while (code.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${code.replace(/\n+$/, '')}\n${ticks}`;
}
export function mdTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return '';
  const h = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [h, sep, ...rows.map((r) => `| ${r.map((c) => escapeMdTable(c ?? '')).join(' | ')} |`)].join('\n');
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^[^\d]*/, '').split(/[.\-+]/);
  const pb = b.replace(/^[^\d]*/, '').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (+x !== +y) return +x - +y;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}
export function runId(): string {
  return nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

export class VgError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const STOP_ES = new Set('de la el que y en los se del las por un para con una es no su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros'.split(' '));
const STOP_EN = new Set('the of and to in is you that it he was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part'.split(' '));
/** Cheap, dependency-free language guess. Returns undefined when not clear. */
export function guessLanguage(texts: string[]): 'en' | 'es' | undefined {
  let es = 0;
  let en = 0;
  for (const t of texts) {
    for (const w of t.toLowerCase().split(/[^\p{L}]+/u)) {
      if (STOP_ES.has(w) && !STOP_EN.has(w)) es++;
      else if (STOP_EN.has(w) && !STOP_ES.has(w)) en++;
    }
  }
  if (es + en < 12) return undefined;
  if (es > en * 1.5) return 'es';
  if (en > es * 1.5) return 'en';
  return undefined;
}

const LABELS: Record<string, Record<'en' | 'es', string>> = {
  overview: { en: 'Overview', es: 'Resumen' },
  purpose: { en: 'Purpose', es: 'Propósito' },
  technologies: { en: 'Technologies', es: 'Tecnologías' },
  dependencies: { en: 'Dependencies', es: 'Dependencias' },
  internalDeps: { en: 'Workspace dependencies', es: 'Dependencias del workspace' },
  externalDeps: { en: 'External dependencies', es: 'Dependencias externas' },
  usedBy: { en: 'Used by', es: 'Usado por' },
  scripts: { en: 'Scripts', es: 'Scripts' },
  entryPoints: { en: 'Entry points', es: 'Puntos de entrada' },
  structure: { en: 'Structure', es: 'Estructura' },
  notes: { en: 'Notes', es: 'Notas' },
  sources: { en: 'Sources', es: 'Fuentes' },
  projects: { en: 'Projects', es: 'Proyectos' },
  apis: { en: 'APIs', es: 'APIs' },
  documents: { en: 'Documents', es: 'Documentos' },
  examples: { en: 'Examples', es: 'Ejemplos' },
  decisions: { en: 'Decisions', es: 'Decisiones' },
  configuration: { en: 'Configuration', es: 'Configuración' },
  infrastructure: { en: 'Infrastructure', es: 'Infraestructura' },
  reference: { en: 'Reference', es: 'Referencia' },
  components: { en: 'Components', es: 'Componentes' },
  openQuestions: { en: 'Open questions and conflicts', es: 'Preguntas abiertas y conflictos' },
  limitations: { en: 'Conversion limitations', es: 'Limitaciones de conversión' },
  provenance: { en: 'Provenance', es: 'Procedencia' },
  home: { en: 'Home', es: 'Inicio' },
  related: { en: 'Related', es: 'Relacionado' },
  manualNotes: { en: 'Manual notes', es: 'Notas manuales' },
  staleNotice: { en: 'The source of this note no longer exists. Kept for reference; review before relying on it.', es: 'La fuente de esta nota ya no existe. Se conserva como referencia; revísala antes de usarla.' },
  needsReview: { en: 'Needs review', es: 'Pendiente de revisión' },
  versions: { en: 'Versions', es: 'Versiones' },
  kind: { en: 'Kind', es: 'Tipo' },
  path: { en: 'Path', es: 'Ruta' },
  description: { en: 'Description', es: 'Descripción' },
  name: { en: 'Name', es: 'Nombre' },
  version: { en: 'Version', es: 'Versión' },
  evidence: { en: 'Evidence', es: 'Evidencia' },
  modules: { en: 'Modules', es: 'Módulos' },
  symbols: { en: 'Public API', es: 'API pública' },
  models: { en: 'Data models', es: 'Modelos de datos' },
  workspace: { en: 'Workspace', es: 'Workspace' },
  verified: { en: 'verified', es: 'verificado' },
  inferred: { en: 'inferred', es: 'inferido' },
};
export function t(lang: 'en' | 'es', key: string): string {
  return LABELS[key]?.[lang] ?? LABELS[key]?.en ?? key;
}
