// Vault note file format: frontmatter + managed region (between markers) + manual content.
// Everything outside the markers belongs to the user and is never rewritten.
import fs from 'node:fs';
import path from 'node:path';
import type { AccessLevel, VaultNote } from './types.ts';
import { serializeFrontmatter, splitFrontmatter } from './markdown.ts';
// (splitFrontmatter is also used by readVault to map body lines back to file lines)
import { normalizeText, posixBase, sha256, stableStringify, toPosix } from './util.ts';

export const BEGIN = '<!-- vg:begin -->';
export const END = '<!-- vg:end -->';
export const MANUAL_HINT = '<!-- Add your own notes below this line. vault-generator never modifies content outside the vg:begin / vg:end block. -->';
export const VG_DIR = '.vault-generator';
const SKIP_DIRS = new Set(['.vault-generator', '.obsidian', '.trash', '.git', 'node_modules']);

export interface NoteParts {
  fm: Record<string, unknown>;
  hasFm: boolean;
  fmError?: string;
  /** text between frontmatter and BEGIN */
  pre: string;
  region?: string;
  /** text after END (or the whole body when there are no markers) */
  post: string;
  hasMarkers: boolean;
}

export function parseNote(text: string): NoteParts {
  const { fm, body } = splitFrontmatter(text);
  const b = body.indexOf(BEGIN);
  const e = body.indexOf(END);
  if (b >= 0 && e > b && body.indexOf(BEGIN, b + 1) < 0) {
    return {
      fm: fm?.data ?? {}, hasFm: !!fm, fmError: fm?.error,
      pre: body.slice(0, b),
      region: body.slice(b + BEGIN.length, e).replace(/^\n/, '').replace(/\n$/, ''),
      post: body.slice(e + END.length),
      hasMarkers: true,
    };
  }
  return { fm: fm?.data ?? {}, hasFm: !!fm, fmError: fm?.error, pre: '', post: body, hasMarkers: false };
}

export function renderNote(fm: Record<string, unknown>, pre: string, region: string, post: string): string {
  return `${serializeFrontmatter(fm)}${pre}${BEGIN}\n${region.replace(/\n+$/, '')}\n${END}${post}`.replace(/\n*$/, '\n');
}

export const normalizeRegion = (s: string): string => normalizeText(s).split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();
export const regionHash = (s: string): string => sha256(normalizeRegion(s)).slice(0, 16);
export const valueHash = (v: unknown): string => sha256(stableStringify(v ?? null)).slice(0, 12);

/** Order of managed top-level properties (user properties keep their own order after these). */
export const RELATION_PROPS = [
  'belongs_to', 'depends_on', 'used_by', 'implements', 'implemented_by', 'exposes', 'exposed_by', 'consumes', 'consumed_by',
  'documents', 'documented_by', 'exemplifies', 'exemplified_by', 'supersedes', 'superseded_by', 'derives_from', 'relates_to',
];
export const MANAGED_ORDER = [
  'title', 'type', 'project', 'source', 'version', 'decision_status', 'tags', 'aliases', 'technologies', ...RELATION_PROPS, 'symbols', 'operations',
];
const LIST_KEYS = new Set(['tags', 'aliases', 'technologies', ...RELATION_PROPS, 'symbols', 'operations']);

export interface FmMergeResult {
  fm: Record<string, unknown>;
  /** managed values as generated now (persist in state to detect user edits next time) */
  managed: Record<string, unknown>;
  /** keys where a user edit was preserved instead of the generated value */
  preserved: string[];
}
/**
 * Merge generated properties into existing ones without losing user data:
 * - lists: generated ∪ (existing − previously generated)
 * - scalars: generated, unless the user changed the value since the last run
 * - `vg` is internal and always replaced
 */
export function mergeFrontmatter(existing: Record<string, unknown> | undefined, generated: Record<string, unknown>, prevManaged: Record<string, unknown> | undefined): FmMergeResult {
  const ex = existing ?? {};
  const prev = prevManaged ?? {};
  const out: Record<string, unknown> = {};
  const preserved: string[] = [];
  const managed: Record<string, unknown> = {};
  const keys = [...MANAGED_ORDER.filter((k) => k in generated), ...Object.keys(generated).filter((k) => !MANAGED_ORDER.includes(k) && k !== 'vg')];
  for (const k of keys) {
    const gen = generated[k];
    managed[k] = gen;
    if (gen === undefined || gen === null || (Array.isArray(gen) && gen.length === 0 && !(k in ex))) continue;
    if (LIST_KEYS.has(k) || Array.isArray(gen)) {
      const genList = (Array.isArray(gen) ? gen : [gen]).map(String);
      const exList = Array.isArray(ex[k]) ? (ex[k] as unknown[]).map(String) : ex[k] !== undefined && ex[k] !== null ? [String(ex[k])] : [];
      const prevList = Array.isArray(prev[k]) ? (prev[k] as unknown[]).map(String) : [];
      const userAdded = exList.filter((x) => !prevList.includes(x) && !genList.includes(x));
      const merged = [...genList, ...userAdded];
      if (userAdded.length) preserved.push(k);
      if (merged.length) out[k] = merged;
      continue;
    }
    if (k in ex && k in prev && valueHash(ex[k]) !== valueHash(prev[k]) && valueHash(ex[k]) !== valueHash(gen)) {
      out[k] = ex[k];
      preserved.push(k);
    } else out[k] = gen;
  }
  // keys we generated last time but not now: drop them only if the user did not change them
  for (const k of Object.keys(prev)) {
    if (k in generated || !(k in ex)) continue;
    if (valueHash(ex[k]) !== valueHash(prev[k])) {
      out[k] = ex[k];
      preserved.push(k);
    }
  }
  for (const [k, v] of Object.entries(ex)) if (!(k in out) && !(k in prev) && !(k in generated) && k !== 'vg') out[k] = v;
  out.vg = generated.vg;
  return { fm: out, managed, preserved };
}

/** Read every Markdown note in the vault (excluding vg-owned and Obsidian config dirs). */
export function readVault(vaultDir: string): VaultNote[] {
  const notes: VaultNote[] = [];
  if (!fs.existsSync(vaultDir)) return notes;
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(childAbs, childRel, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        let text: string;
        try {
          text = normalizeText(fs.readFileSync(childAbs, 'utf8'));
        } catch {
          continue;
        }
        const parts = parseNote(text);
        const fmLines = splitFrontmatter(text).fm?.bodyStart ?? 0;
        const lineOffset = fmLines + (parts.hasMarkers ? parts.pre.split('\n').length : 0);
        const vg = (parts.fm.vg && typeof parts.fm.vg === 'object' ? parts.fm.vg : undefined) as Record<string, unknown> | undefined;
        const title = typeof parts.fm.title === 'string' ? parts.fm.title : /^#\s+(.+)$/m.exec(parts.region ?? parts.post)?.[1]?.trim() ?? posixBase(childRel).replace(/\.md$/i, '');
        notes.push({
          path: toPosix(childRel),
          id: typeof vg?.id === 'string' ? vg.id : `manual-${sha256(toPosix(childRel)).slice(0, 10)}`,
          title,
          type: typeof parts.fm.type === 'string' ? parts.fm.type : undefined,
          fm: parts.fm,
          hasVg: !!vg,
          key: typeof vg?.key === 'string' ? vg.key : undefined,
          body: `${parts.pre}${parts.hasMarkers ? parts.region : ''}${parts.post}`,
          region: parts.region,
          regionHash: parts.region !== undefined ? regionHash(parts.region) : undefined,
          access: (vg?.access === 'restricted' ? 'restricted' : 'public') as AccessLevel,
          lineOffset,
        });
      }
    }
  };
  walk(vaultDir, '', 0);
  return notes;
}

export const noteBasename = (p: string): string => posixBase(p).replace(/\.md$/i, '');

/** Wikilink target string: basename when unique in the vault, else the path without extension. */
export function linkName(notePath: string, basenameCount: Map<string, number>): string {
  const base = noteBasename(notePath);
  return (basenameCount.get(base.toLowerCase()) ?? 0) > 1 ? notePath.replace(/\.md$/i, '') : base;
}

const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
/** Every wikilink target in a text (no embeds of non-markdown files). */
export function wikilinks(text: string): { target: string; heading?: string; display?: string; embed: boolean }[] {
  const out: { target: string; heading?: string; display?: string; embed: boolean }[] = [];
  for (const m of text.matchAll(WIKILINK)) {
    const inner = m[2].replace(/\\\|/g, '|');
    const [tgt, display] = inner.split('|');
    const [target, heading] = tgt.split('#');
    out.push({ target: target.trim(), heading: heading?.trim(), display: display?.trim(), embed: !!m[1] });
  }
  return out;
}

/** Resolve a wikilink target (basename or path, with or without .md) to a vault note path. */
export function resolveWikilink(target: string, byPath: Map<string, VaultNote>, byBase: Map<string, VaultNote[]>, fromPath?: string): VaultNote | undefined {
  if (!target) return fromPath ? byPath.get(fromPath.toLowerCase()) : undefined;
  const t = target.replace(/\.md$/i, '').replace(/^\/+/, '');
  const exact = byPath.get(`${t}.md`.toLowerCase());
  if (exact) return exact;
  const cands = byBase.get(posixBase(t).toLowerCase()) ?? [];
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) {
    const suffix = cands.filter((c) => c.path.toLowerCase().endsWith(`${t}.md`.toLowerCase()));
    if (suffix.length) return suffix.sort((a, b) => a.path.length - b.path.length)[0];
    return cands.sort((a, b) => a.path.length - b.path.length)[0];
  }
  return undefined;
}

export function indexNotes(notes: VaultNote[]): { byPath: Map<string, VaultNote>; byBase: Map<string, VaultNote[]>; byId: Map<string, VaultNote> } {
  const byPath = new Map<string, VaultNote>();
  const byBase = new Map<string, VaultNote[]>();
  const byId = new Map<string, VaultNote>();
  for (const n of notes) {
    byPath.set(n.path.toLowerCase(), n);
    const b = noteBasename(n.path).toLowerCase();
    byBase.set(b, [...(byBase.get(b) ?? []), n]);
    if (!byId.has(n.id)) byId.set(n.id, n);
  }
  return { byPath, byBase, byId };
}
