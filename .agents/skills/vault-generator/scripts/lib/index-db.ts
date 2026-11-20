// Local search index: SQLite (node:sqlite) with FTS5 over heading-aware chunks, plus tables for
// notes metadata, symbols, API operations, tags and relations. The index is derived data: it can be
// deleted and rebuilt at any time from the vault (`--mode index --rebuild`).
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DB } from 'node:sqlite';
import type { VaultNote } from './types.ts';
import { chunkMarkdown, plainText } from './markdown.ts';
import { indexNotes, resolveWikilink, wikilinks } from './vault.ts';
import { sha256, splitIdent, uniq } from './util.ts';
import { RELATION_PROPS } from './vault.ts';

let sqliteMod: typeof import('node:sqlite') | undefined;
export function sqlite(): typeof import('node:sqlite') {
  if (sqliteMod) return sqliteMod;
  const emit = process.emitWarning;
  // node:sqlite prints an ExperimentalWarning on older Node versions; keep CLI JSON output clean
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String(typeof w === 'string' ? w : w.message).includes('SQLite')) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqliteMod = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
  if (!sqliteMod) throw new Error('node:sqlite is not available: Node >= 22.18 is required');
  return sqliteMod;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, path TEXT, title TEXT, type TEXT, project TEXT, version TEXT, status TEXT, access TEXT,
  origin TEXT, tags TEXT, technologies TEXT, sources TEXT, hash TEXT, chars INTEGER);
CREATE TABLE IF NOT EXISTS chunks(rowid INTEGER PRIMARY KEY, note_id TEXT, ord INTEGER, heading TEXT, anchor TEXT, hpath TEXT, start_line INTEGER, end_line INTEGER, text TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title, heading, body, symbols, tags, tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');
CREATE TABLE IF NOT EXISTS symbols(note_id TEXT, name TEXT, lname TEXT, kind TEXT, signature TEXT);
CREATE TABLE IF NOT EXISTS operations(note_id TEXT, method TEXT, path TEXT);
CREATE TABLE IF NOT EXISTS relations(src TEXT, type TEXT, dst TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS links(src TEXT, dst TEXT, heading TEXT);
CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks(note_id);
CREATE INDEX IF NOT EXISTS idx_sym ON symbols(lname);
CREATE INDEX IF NOT EXISTS idx_rel_src ON relations(src);
CREATE INDEX IF NOT EXISTS idx_rel_dst ON relations(dst);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst);
`;
const SCHEMA_VERSION = '4';

export function openIndex(file: string, readonly = false): DB {
  const { DatabaseSync } = sqlite();
  if (!readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, readonly ? { readOnly: true } : {});
  if (!readonly) {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;');
    db.exec(SCHEMA);
    const v = db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value?: string } | undefined;
    if (v?.value && v.value !== SCHEMA_VERSION) {
      db.close();
      fs.rmSync(file, { force: true });
      return openIndex(file, false);
    }
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
  }
  return db;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)]);

export interface IndexStats {
  notes: number;
  chunks: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  contentHash: string;
}

/** Incremental: only notes whose content hash changed are re-chunked. */
export function updateIndex(file: string, notes: VaultNote[], opts: { rebuild?: boolean } = {}): IndexStats {
  if (opts.rebuild && fs.existsSync(file)) fs.rmSync(file, { force: true });
  const db = openIndex(file);
  const { byPath, byBase } = indexNotes(notes);
  const prev = new Map((db.prepare('SELECT id, hash FROM notes').all() as { id: string; hash: string }[]).map((r) => [r.id, r.hash]));
  const stats: IndexStats = { notes: notes.length, chunks: 0, added: 0, updated: 0, removed: 0, unchanged: 0, contentHash: '' };
  const insNote = db.prepare('INSERT OR REPLACE INTO notes(id,path,title,type,project,version,status,access,origin,tags,technologies,sources,hash,chars) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insChunk = db.prepare('INSERT INTO chunks(note_id,ord,heading,anchor,hpath,start_line,end_line,text) VALUES(?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO chunks_fts(rowid,title,heading,body,symbols,tags) VALUES(?,?,?,?,?,?)');
  const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE note_id = ?)');
  const insSym = db.prepare('INSERT INTO symbols(note_id,name,lname,kind,signature) VALUES(?,?,?,?,?)');
  const insOp = db.prepare('INSERT INTO operations(note_id,method,path) VALUES(?,?,?)');
  const insRel = db.prepare('INSERT INTO relations(src,type,dst,status) VALUES(?,?,?,?)');
  const insLink = db.prepare('INSERT INTO links(src,dst,heading) VALUES(?,?,?)');
  const removeNote = (id: string) => {
    delFts.run(id);
    for (const tbl of ['chunks', 'symbols', 'operations']) db.prepare(`DELETE FROM ${tbl} WHERE note_id = ?`).run(id);
    db.prepare('DELETE FROM links WHERE src = ?').run(id);
    db.prepare('DELETE FROM relations WHERE src = ?').run(id);
    db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  };
  db.exec('BEGIN');
  try {
    const current = new Set<string>();
    const hashes: string[] = [];
    for (const n of notes) {
      const vg = (n.fm.vg ?? {}) as Record<string, unknown>;
      const hash = sha256(`${JSON.stringify(n.fm)}\n${n.body}\n${n.path}`).slice(0, 16);
      hashes.push(`${n.id}:${hash}`);
      if (current.has(n.id)) continue; // duplicate ids: first wins (validate reports duplicates)
      current.add(n.id);
      if (prev.get(n.id) === hash) {
        stats.unchanged++;
        continue;
      }
      if (prev.has(n.id)) {
        removeNote(n.id);
        stats.updated++;
      } else stats.added++;
      const tags = asList(n.fm.tags).join(' ');
      const tech = asList(n.fm.technologies).join(', ');
      const project = typeof n.fm.project === 'string' ? n.fm.project.replace(/^\[\[|\]\]$/g, '').split('|')[0] : n.type === 'project' ? n.title : '';
      insNote.run(n.id, n.path, n.title, n.type ?? (n.hasVg ? '' : 'manual'), project, n.fm.version !== undefined ? String(n.fm.version) : '', String(vg.status ?? (n.hasVg ? 'current' : 'manual')), n.access, String(vg.origin ?? (n.hasVg ? 'generated' : 'manual')), tags, tech, asList(vg.sources).join('\n'), hash, n.body.length);
      // symbols: from frontmatter list and "### name · kind" headings with a following signature fence
      const symRows: { name: string; kind: string; sig: string }[] = [];
      const lines = n.body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = /^#{3,4}\s+(.+?)\s+·\s+([\w-]+)\s*$/.exec(lines[i]);
        if (!m) continue;
        let sig = '';
        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
          if (/^```/.test(lines[j])) {
            sig = lines[j + 1] ?? '';
            break;
          }
        }
        symRows.push({ name: m[1].replace(/`/g, ''), kind: m[2], sig });
      }
      for (const s of asList(n.fm.symbols)) if (!symRows.some((r) => r.name === s)) symRows.push({ name: s, kind: '', sig: '' });
      for (const s of symRows) insSym.run(n.id, s.name, s.name.toLowerCase(), s.kind, s.sig);
      for (const op of asList(n.fm.operations)) {
        const [method, ...rest] = op.split(' ');
        insOp.run(n.id, method, rest.join(' '));
      }
      const symText = uniq(symRows.flatMap((s) => [s.name, splitIdent(s.name)])).join(' ');
      // relations from properties (verified/confirmed only are stored as properties)
      for (const prop of RELATION_PROPS) {
        for (const v of asList(n.fm[prop])) {
          for (const l of wikilinks(v)) {
            const target = resolveWikilink(l.target, byPath, byBase);
            if (target) insRel.run(n.id, prop, target.id, 'verified');
          }
        }
      }
      for (const l of wikilinks(n.body)) {
        const target = resolveWikilink(l.target, byPath, byBase, n.path);
        if (target && target.id !== n.id) insLink.run(n.id, target.id, l.heading ?? '');
      }
      const chunks = chunkMarkdown(n.body, 2000);
      chunks.forEach((c, ord) => {
        // store real file line numbers so "lines 31-46" can be opened directly in an editor
        const r = insChunk.run(n.id, ord, c.heading, c.anchor, c.path, c.start + n.lineOffset, c.end + n.lineOffset, c.text);
        const rowid = Number(r.lastInsertRowid);
        insFts.run(rowid, n.title, c.heading, ftsBody(c.text), ord === 0 ? symText : '', ord === 0 ? `${tags} ${tech}` : '');
        stats.chunks++;
      });
    }
    for (const id of prev.keys()) if (!current.has(id)) {
      removeNote(id);
      stats.removed++;
    }
    stats.contentHash = sha256(hashes.sort().join('\n')).slice(0, 16);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('contentHash',?)").run(stats.contentHash);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.close();
    throw e;
  }
  stats.chunks = (db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n;
  db.close();
  return stats;
}
// identifiers in code are split too so "getUserById" matches "user id"
const ftsBody = (text: string) => {
  const plain = plainText(text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[`]/g, ' ')));
  const idents = uniq((plain.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).filter((w) => /[a-z][A-Z]|_/.test(w)).map(splitIdent)).join(' ');
  return idents ? `${plain}\n${idents}` : plain;
};

// ───────────────────────── search ─────────────────────────
export interface SearchFilters {
  project?: string;
  type?: string;
  tech?: string;
  version?: string;
  tag?: string;
  status?: string;
  includeRestricted?: boolean;
  includeStale?: boolean;
}
export interface SearchHit {
  id: string;
  path: string;
  title: string;
  type: string;
  project: string;
  version: string;
  status: string;
  heading: string;
  anchor: string;
  lines: [number, number];
  score: number;
  snippet: string;
  sources: string[];
  confidence: 'high' | 'medium' | 'low';
  matched: string[];
  via?: string;
}

const STOP = new Set('a an and are as at be by for from how i in is it of on or the to what where which who why with de del el la las los un una y o que en para por con como donde cual cuales qué cómo dónde es son se lo al'.split(' '));
export function queryTerms(q: string): string[] {
  const words = q
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}_]+/u)
    .flatMap((w) => [w, ...(/[a-z][A-Z]|_/.test(w) ? splitIdent(w).split(' ') : [])])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !STOP.has(w));
  return uniq(words).slice(0, 16);
}
const ftsQuery = (terms: string[], mode: 'and' | 'or') => terms.map((t) => `"${t.replace(/"/g, '')}"${t.length >= 3 ? '*' : ''}`).join(mode === 'and' ? ' AND ' : ' OR ');

export function search(file: string, query: string, filters: SearchFilters = {}, limit = 8): { hits: SearchHit[]; terms: string[]; mode: string; restrictedHidden: number } {
  if (!fs.existsSync(file)) throw new Error('index not found: run `--mode index` (or generate/sync) first');
  const db = openIndex(file, true);
  const terms = queryTerms(query);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (!filters.includeRestricted) where.push("n.access != 'restricted'");
  if (!filters.includeStale) where.push("n.status NOT IN ('stale')");
  if (filters.project) {
    where.push('(lower(n.project) = lower(?) OR lower(n.title) = lower(?) OR lower(n.path) LIKE lower(?))');
    params.push(filters.project, filters.project, `%${filters.project}%`);
  }
  if (filters.type) {
    where.push('n.type = ?');
    params.push(filters.type);
  }
  if (filters.version) {
    where.push("(n.version = ? OR n.version = '' OR n.version IS NULL)");
    params.push(filters.version);
  }
  if (filters.tech) {
    where.push("(lower(n.technologies) LIKE lower(?) OR lower(n.tags) LIKE lower(?))");
    params.push(`%${filters.tech}%`, `%tech/${filters.tech.toLowerCase()}%`);
  }
  if (filters.tag) {
    where.push("(' ' || n.tags || ' ') LIKE ?");
    params.push(`% ${filters.tag}%`);
  }
  if (filters.status) {
    where.push('n.status = ?');
    params.push(filters.status);
  }
  const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';
  const restrictedHidden = filters.includeRestricted ? 0 : ((db.prepare("SELECT count(*) AS n FROM notes WHERE access = 'restricted'").get() as { n: number }).n);
  const collected = new Map<string, SearchHit>();
  let mode = 'none';
  if (terms.length) {
    const sql = `SELECT c.note_id AS id, n.path, n.title, n.type, n.project, n.version, n.status, n.sources, c.heading, c.anchor, c.start_line, c.end_line, c.text,
      bm25(chunks_fts, 8.0, 4.0, 1.0, 6.0, 2.0) AS score
      FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid JOIN notes n ON n.id = c.note_id
      WHERE chunks_fts MATCH ? ${whereSql} ORDER BY score LIMIT ?`;
    for (const m of ['and', 'or'] as const) {
      if (m === 'or' && collected.size >= limit) break;
      if (m === 'or' && terms.length < 2) break;
      const rows = db.prepare(sql).all(ftsQuery(terms, m), ...params, limit * 6) as Record<string, unknown>[];
      if (rows.length && mode === 'none') mode = m;
      for (const r of rows) {
        const id = String(r.id);
        const ex = collected.get(id);
        const s = -Number(r.score) * (m === 'and' ? 1.5 : 1);
        if (ex && ex.score >= s) continue;
        const text = String(r.text);
        const matched = terms.filter((t) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').includes(t) || String(r.title).toLowerCase().includes(t));
        collected.set(id, {
          id, path: String(r.path), title: String(r.title), type: String(r.type), project: String(r.project), version: String(r.version), status: String(r.status),
          heading: String(r.heading ?? ''), anchor: String(r.anchor ?? ''), lines: [Number(r.start_line), Number(r.end_line)], score: s, snippet: snippet(text, terms),
          sources: String(r.sources ?? '').split('\n').filter(Boolean), confidence: 'low', matched,
        });
      }
    }
    // symbol and operation exact/prefix matches are strong signals
    for (const t of terms) {
      const sy = db.prepare(`SELECT s.note_id AS id, s.name, s.kind FROM symbols s JOIN notes n ON n.id = s.note_id WHERE s.lname = ? ${whereSql} LIMIT 20`).all(t, ...params) as { id: string; name: string; kind: string }[];
      for (const r of sy) boost(collected, r.id, 6, `symbol ${r.name}`, db, terms);
    }
    const rawIdents = (query.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).map((s) => s.toLowerCase());
    for (const t of uniq(rawIdents)) {
      const sy = db.prepare(`SELECT s.note_id AS id, s.name FROM symbols s JOIN notes n ON n.id = s.note_id WHERE s.lname = ? ${whereSql} LIMIT 20`).all(t, ...params) as { id: string; name: string }[];
      for (const r of sy) boost(collected, r.id, 8, `symbol ${r.name}`, db, terms);
    }
    const opMatch = /\b(GET|POST|PUT|PATCH|DELETE)\b\s+(\/\S*)|(\/[\w\-./{}]+)/i.exec(query);
    if (opMatch) {
      const p = (opMatch[2] ?? opMatch[3]).replace(/\/$/, '');
      const ops = db.prepare(`SELECT o.note_id AS id, o.method, o.path FROM operations o JOIN notes n ON n.id = o.note_id WHERE o.path LIKE ? ${whereSql} LIMIT 20`).all(`%${p}%`, ...params) as { id: string; method: string; path: string }[];
      for (const r of ops) boost(collected, r.id, opMatch[1] && r.method.toUpperCase() === opMatch[1].toUpperCase() ? 8 : 5, `operation ${r.method} ${r.path}`, db, terms);
    }
  }
  let hits = [...collected.values()].sort((a, b) => b.score - a.score);
  const top = hits[0]?.score ?? 0;
  for (const h of hits) {
    const coverage = terms.length ? h.matched.length / terms.length : 0;
    h.confidence = h.via?.startsWith('symbol') || h.via?.startsWith('operation') ? 'high' : coverage >= 0.8 && h.score >= top * 0.5 ? 'high' : coverage >= 0.5 ? 'medium' : 'low';
  }
  hits = hits.slice(0, limit);
  db.close();
  return { hits, terms, mode, restrictedHidden };
}
function boost(collected: Map<string, SearchHit>, id: string, by: number, via: string, db: DB, terms: string[]) {
  const ex = collected.get(id);
  if (ex) {
    ex.score += by;
    ex.via = ex.via ?? via;
    return;
  }
  const n = db.prepare('SELECT id, path, title, type, project, version, status, sources FROM notes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!n) return;
  const name = via.split(' ').slice(1).join(' ');
  const c = (db.prepare('SELECT heading, anchor, start_line, end_line, text FROM chunks WHERE note_id = ? AND (heading LIKE ? OR text LIKE ?) ORDER BY ord LIMIT 1').get(id, `%${name.split(' ')[0]}%`, `%${name}%`) ??
    db.prepare('SELECT heading, anchor, start_line, end_line, text FROM chunks WHERE note_id = ? ORDER BY ord LIMIT 1').get(id)) as Record<string, unknown> | undefined;
  collected.set(id, {
    id, path: String(n.path), title: String(n.title), type: String(n.type), project: String(n.project), version: String(n.version), status: String(n.status),
    heading: String(c?.heading ?? ''), anchor: String(c?.anchor ?? ''), lines: [Number(c?.start_line ?? 1), Number(c?.end_line ?? 1)], score: by,
    snippet: snippet(String(c?.text ?? ''), terms), sources: String(n.sources ?? '').split('\n').filter(Boolean), confidence: 'high', matched: [], via,
  });
}

export function snippet(text: string, terms: string[], width = 260): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let pos = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  const start = Math.max(0, (pos < 0 ? 0 : pos) - 60);
  const s = flat.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${s}${start + width < flat.length ? '…' : ''}`;
}

/** Notes related to `id` (relations + links, both directions), for context expansion. */
export function neighbours(file: string, id: string, opts: { includeRestricted?: boolean } = {}): { id: string; path: string; title: string; type: string; rel: string; dir: 'out' | 'in' }[] {
  const db = openIndex(file, true);
  const acc = opts.includeRestricted ? '' : "AND n.access != 'restricted'";
  const rows = [
    ...(db.prepare(`SELECT n.id, n.path, n.title, n.type, r.type AS rel, 'out' AS dir FROM relations r JOIN notes n ON n.id = r.dst WHERE r.src = ? ${acc}`).all(id) as Record<string, string>[]),
    ...(db.prepare(`SELECT n.id, n.path, n.title, n.type, r.type AS rel, 'in' AS dir FROM relations r JOIN notes n ON n.id = r.src WHERE r.dst = ? ${acc}`).all(id) as Record<string, string>[]),
    ...(db.prepare(`SELECT n.id, n.path, n.title, n.type, 'links-to' AS rel, 'out' AS dir FROM links l JOIN notes n ON n.id = l.dst WHERE l.src = ? ${acc}`).all(id) as Record<string, string>[]),
  ];
  db.close();
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(`${r.id}|${r.rel}`) ? false : (seen.add(`${r.id}|${r.rel}`), true))) as never;
}

export function getChunks(file: string, id: string): { heading: string; anchor: string; hpath: string; start: number; end: number; text: string }[] {
  const db = openIndex(file, true);
  const rows = db.prepare('SELECT heading, anchor, hpath, start_line AS start, end_line AS end, text FROM chunks WHERE note_id = ? ORDER BY ord').all(id) as never;
  db.close();
  return rows;
}
export function getNoteMeta(file: string, idOrPath: string): Record<string, string> | undefined {
  const db = openIndex(file, true);
  const r = (db.prepare('SELECT * FROM notes WHERE id = ? OR lower(path) = lower(?) OR lower(title) = lower(?) LIMIT 1').get(idOrPath, idOrPath, idOrPath) ?? undefined) as Record<string, string> | undefined;
  db.close();
  return r;
}
export function indexInfo(file: string): { notes: number; chunks: number; symbols: number; operations: number; relations: number; contentHash: string } | undefined {
  if (!fs.existsSync(file)) return undefined;
  const db = openIndex(file, true);
  const n = (q: string) => (db.prepare(q).get() as { n: number }).n;
  const info = {
    notes: n('SELECT count(*) AS n FROM notes'), chunks: n('SELECT count(*) AS n FROM chunks'), symbols: n('SELECT count(*) AS n FROM symbols'),
    operations: n('SELECT count(*) AS n FROM operations'), relations: n('SELECT count(*) AS n FROM relations'),
    contentHash: String((db.prepare("SELECT value FROM meta WHERE key='contentHash'").get() as { value?: string } | undefined)?.value ?? ''),
  };
  db.close();
  return info;
}
