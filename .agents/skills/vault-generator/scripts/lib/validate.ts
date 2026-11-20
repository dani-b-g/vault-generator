// Vault validation: structure, metadata, ids, links, provenance, index coherence, Obsidian
// compatibility, privacy. Pure read-only.
import fs from 'node:fs';
import path from 'node:path';
import type { VaultNote } from './types.ts';
import { indexInfo } from './index-db.ts';
import { codeMask } from './markdown.ts';
import { hasPrivateAbsolutePath, redactSecrets } from './safety.ts';
import { loadManifest, loadState, vgPaths } from './state.ts';
import { BEGIN, END, indexNotes, parseNote, readVault, regionHash, resolveWikilink, wikilinks, RELATION_PROPS } from './vault.ts';
import { normalizeText, sha256 } from './util.ts';
import { splitFrontmatter } from './markdown.ts';

export interface Issue {
  level: 'error' | 'warning' | 'info';
  code: string;
  path?: string;
  message: string;
}
export interface ValidationReport {
  ok: boolean;
  notes: number;
  managed: number;
  manual: number;
  issues: Issue[];
  counts: Record<string, number>;
}

const REQUIRED_VG = ['id', 'key', 'origin', 'status', 'access', 'sources'];

export function validateVault(vaultDir: string, opts: { checkSources?: boolean } = {}): ValidationReport {
  const issues: Issue[] = [];
  const add = (level: Issue['level'], code: string, message: string, p?: string) => issues.push({ level, code, message, path: p });
  if (!fs.existsSync(vaultDir)) return { ok: false, notes: 0, managed: 0, manual: 0, issues: [{ level: 'error', code: 'no-vault', message: `vault not found: ${vaultDir}` }], counts: {} };
  const paths = vgPaths(vaultDir);
  const manifest = fs.existsSync(paths.manifest) ? safeManifest(vaultDir, add) : undefined;
  const state = manifest ? loadState(vaultDir) : undefined;
  const notes = readVault(vaultDir);
  const { byPath, byBase } = indexNotes(notes);
  const managed = notes.filter((n) => n.hasVg);

  // ids & keys
  const ids = new Map<string, VaultNote[]>();
  for (const n of managed) ids.set(n.id, [...(ids.get(n.id) ?? []), n]);
  for (const [id, list] of ids) if (list.length > 1) add('error', 'duplicate-id', `id ${id} used by ${list.map((n) => n.path).join(', ')} (a note was copied?)`);
  const keys = new Map<string, VaultNote[]>();
  for (const n of managed) if (n.key) keys.set(n.key, [...(keys.get(n.key) ?? []), n]);
  for (const [k, list] of keys) if (list.length > 1) add('error', 'duplicate-key', `knowledge unit ${k} appears in ${list.length} notes`);
  const titles = new Map<string, VaultNote[]>();
  for (const n of managed) titles.set(n.title.toLowerCase(), [...(titles.get(n.title.toLowerCase()) ?? []), n]);
  for (const [tt, list] of titles) if (list.length > 1 && list.every((n) => n.type === list[0].type)) add('warning', 'duplicate-title', `${list.length} notes share the title "${tt}" (${list.map((n) => n.path).join(', ')})`);

  for (const n of notes) {
    const raw = normalizeText(fs.readFileSync(path.join(vaultDir, n.path), 'utf8'));
    const { fm } = splitFrontmatter(raw);
    if (fm?.error) add('error', 'frontmatter', `invalid YAML frontmatter: ${fm.error}`, n.path);
    if (n.hasVg) {
      const vg = n.fm.vg as Record<string, unknown>;
      for (const k of REQUIRED_VG) if (vg[k] === undefined) add('error', 'missing-metadata', `vg.${k} missing`, n.path);
      if (!Array.isArray(vg.sources)) add('error', 'missing-metadata', 'vg.sources must be a list', n.path);
      else if (vg.origin !== 'derived' && (vg.sources as unknown[]).length === 0 && !String(n.key).startsWith('hub:')) add('warning', 'no-provenance', 'generated note without source references', n.path);
      const parts = parseNote(raw);
      const begins = raw.split(BEGIN).length - 1;
      const ends = raw.split(END).length - 1;
      if (begins !== 1 || ends !== 1) add('error', 'markers', `expected exactly one ${BEGIN} / ${END} pair (found ${begins}/${ends})`, n.path);
      else if (!parts.hasMarkers) add('error', 'markers', 'vg markers out of order', n.path);
      if (vg.status === 'conflict') add('warning', 'conflict', 'note has an unresolved sync conflict (see --mode conflicts)', n.path);
      if (vg.status === 'stale') add('info', 'stale', 'source no longer exists; note kept', n.path);
      if (state && n.id && state.notes[n.id] && parts.region !== undefined && regionHash(parts.region) !== state.notes[n.id].genHash && vg.status !== 'conflict') add('info', 'edited', 'generated region edited by hand (preserved on sync)', n.path);
      if (opts.checkSources && manifest) {
        for (const s of (vg.sources as string[]) ?? []) {
          const m = /^([^:]+):(.+?)(?:@([0-9a-f]+))?$/.exec(s);
          const src = m && manifest.sources.find((x) => x.id === m[1]);
          if (src && src.path !== null && !fs.existsSync(path.resolve(vaultDir, src.path, m![2]))) add('warning', 'missing-source', `source file no longer exists: ${s}`, n.path);
        }
      }
    }
    // links
    const lines = n.body.split('\n');
    const { mask } = codeMask(lines);
    const bodyNoCode = lines.filter((_, i) => !mask[i]).join('\n').replace(/`[^`\n]*`/g, '');
    const linkTexts = [bodyNoCode, ...RELATION_PROPS.flatMap((p) => (Array.isArray(n.fm[p]) ? (n.fm[p] as unknown[]).map(String) : [])), typeof n.fm.project === 'string' ? n.fm.project : ''];
    for (const text of linkTexts) {
      for (const l of wikilinks(text)) {
        if (l.embed && /\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(l.target)) {
          if (!fs.existsSync(path.join(vaultDir, l.target)) && !(byBase.get(l.target.toLowerCase())?.length)) add('warning', 'broken-embed', `embedded file not found: ${l.target}`, n.path);
          continue;
        }
        const target = resolveWikilink(l.target, byPath, byBase, n.path);
        if (!target) {
          add(n.hasVg ? 'error' : 'warning', 'broken-link', `[[${l.target}]] does not resolve to a note`, n.path);
          continue;
        }
        if (l.heading) {
          const tparts = parseNote(normalizeText(fs.readFileSync(path.join(vaultDir, target.path), 'utf8')));
          const heads = `${tparts.region ?? ''}\n${tparts.post}`.split('\n').filter((x) => /^#{1,6}\s/.test(x)).map((x) => x.replace(/^#+\s+/, '').trim().toLowerCase());
          const want = l.heading.toLowerCase();
          if (!heads.some((h) => h === want || h.replace(/[#|^[\]:]/g, ' ').replace(/\s+/g, ' ').trim() === want)) add('warning', 'broken-heading', `heading "#${l.heading}" not found in ${target.path}`, n.path);
        }
      }
    }
    for (const m of bodyNoCode.matchAll(/!?\[[^\]]*\]\((?!https?:|mailto:|#|<?[a-z][a-z0-9+.-]*:)<?([^)>]+?)>?\)/gi)) {
      const target = decodeURIComponent(m[1].split('#')[0]);
      if (!target) continue;
      const abs = path.resolve(path.dirname(path.join(vaultDir, n.path)), target);
      if (!fs.existsSync(abs)) add('warning', 'broken-relative-link', `relative link target not found: ${m[1]}`, n.path);
    }
    // privacy & secrets
    if (n.hasVg && hasPrivateAbsolutePath(raw)) add('error', 'private-path', 'absolute private path found in a generated note', n.path);
    if (n.hasVg && redactSecrets(raw).count > 0 && n.access !== 'restricted') add('error', 'secret', 'secret-like value found in a generated note', n.path);
    // obsidian compatibility
    if (/[\\:*?"<>|#^[\]]/.test(path.posix.basename(n.path, '.md'))) add('warning', 'filename', 'file name contains characters Obsidian cannot link reliably', n.path);
    if (Array.isArray(n.fm.tags)) for (const tg of n.fm.tags as unknown[]) if (typeof tg !== 'string' || /\s/.test(tg) || /^\d+$/.test(tg)) add('warning', 'tag', `invalid Obsidian tag "${String(tg)}"`, n.path);
    if (n.fm.aliases !== undefined && !Array.isArray(n.fm.aliases)) add('warning', 'aliases', 'aliases should be a list', n.path);
  }

  // manifest ↔ vault ↔ index coherence
  if (manifest && state) {
    for (const [id, s] of Object.entries(state.notes)) if (!ids.has(id)) add('warning', 'missing-note', `managed note ${s.path} (${id}) was deleted or its vg block removed`);
    const info = indexInfo(paths.index);
    if (!info) add('warning', 'index-missing', 'search index missing: run --mode index');
    else {
      if (info.notes !== notes.length) add('warning', 'index-stale', `index has ${info.notes} notes, vault has ${notes.length}: run --mode index`);
      const hashes = notes.map((n) => `${n.id}:${sha256(`${JSON.stringify(n.fm)}\n${n.body}\n${n.path}`).slice(0, 16)}`);
      const ch = sha256(hashes.sort().join('\n')).slice(0, 16);
      if (info.contentHash && info.contentHash !== ch) add('warning', 'index-stale', 'index content hash differs from the vault: run --mode index');
    }
    for (const c of manifest.conflicts) if (!fs.existsSync(path.join(vaultDir, c.incoming ?? ''))) add('warning', 'conflict-file', `conflict ${c.id} references a missing incoming file`);
    if (hasPrivateAbsolutePath(JSON.stringify(manifest))) add('error', 'private-path', 'manifest contains an absolute private path');
  } else if (!manifest) add('info', 'unmanaged', 'no vault-generator manifest: validated as a plain Obsidian vault');

  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.level] = (counts[i.level] ?? 0) + 1;
  return { ok: !issues.some((i) => i.level === 'error'), notes: notes.length, managed: managed.length, manual: notes.length - managed.length, issues, counts };
}

function safeManifest(vaultDir: string, add: (l: Issue['level'], c: string, m: string) => void) {
  try {
    return loadManifest(vaultDir);
  } catch (e) {
    add('error', 'manifest', (e as Error).message);
    return undefined;
  }
}
