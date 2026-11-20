// Reorganize: evaluate the structure of an existing vault and propose (dry-run by default) moves,
// splits and link fixes. Applying a proposal moves files with backups and rewrites links; content
// is never deleted.
import fs from 'node:fs';
import path from 'node:path';
import type { VaultNote } from './types.ts';
import { indexNotes, linkName, noteBasename, readVault, resolveWikilink, VG_DIR } from './vault.ts';
import { codeMask } from './markdown.ts';
import { Writer } from './fsutil.ts';
import { RunJournal, loadState, vgPaths } from './state.ts';
import { safeJoin } from './safety.ts';
import { normalizeText, posixBase, posixDir, posixJoin, runId as newRunId, sanitizeFileName, uniq } from './util.ts';
import { updateIndex } from './index-db.ts';

export interface Move {
  from: string;
  to: string;
  reason: string;
}
export interface Proposal {
  notes: number;
  folders: number;
  findings: { kind: string; detail: string; paths?: string[] }[];
  moves: Move[];
  linkUpdates: number;
}

export function analyzeStructure(vaultDir: string): Proposal {
  const notes = readVault(vaultDir);
  const { byPath, byBase } = indexNotes(notes);
  const folders = uniq(notes.map((n) => posixDir(n.path)));
  const findings: Proposal['findings'] = [];
  const moves: Move[] = [];
  // orphans (no inbound links, not a hub)
  const inbound = new Map<string, number>();
  for (const n of notes) for (const l of linksIn(n)) {
    const t = resolveWikilink(l, byPath, byBase, n.path);
    if (t && t.path !== n.path) inbound.set(t.path, (inbound.get(t.path) ?? 0) + 1);
  }
  const orphans = notes.filter((n) => !inbound.get(n.path) && n.type !== 'moc' && !/^(home|index|readme|inicio)$/i.test(noteBasename(n.path)));
  if (orphans.length) findings.push({ kind: 'orphans', detail: `${orphans.length} note(s) have no incoming links`, paths: orphans.slice(0, 30).map((n) => n.path) });
  // folders with a single note
  const perFolder = new Map<string, VaultNote[]>();
  for (const n of notes) perFolder.set(posixDir(n.path), [...(perFolder.get(posixDir(n.path)) ?? []), n]);
  for (const [f, list] of perFolder) {
    if (f && list.length === 1) {
      const parent = posixDir(f);
      const to = posixJoin(parent, posixBase(list[0].path));
      if (!byPath.has(to.toLowerCase())) moves.push({ from: list[0].path, to, reason: `folder "${f}" contains a single note` });
    }
  }
  // very large flat folders
  for (const [f, list] of perFolder) {
    if (list.length > 40) {
      const byType = new Map<string, VaultNote[]>();
      for (const n of list) byType.set(n.type ?? 'note', [...(byType.get(n.type ?? 'note') ?? []), n]);
      if (byType.size > 1) {
        findings.push({ kind: 'large-folder', detail: `"${f || '/'}" holds ${list.length} notes of ${byType.size} types; grouping by type proposed` });
        for (const [type, l] of byType) {
          if (l.length < 3) continue;
          for (const n of l) {
            const to = posixJoin(f, sanitizeFileName(type.charAt(0).toUpperCase() + type.slice(1)), posixBase(n.path));
            if (!byPath.has(to.toLowerCase())) moves.push({ from: n.path, to, reason: `group ${type} notes` });
          }
        }
      }
    }
  }
  // duplicated basenames make links ambiguous
  const dup = [...byBase.entries()].filter(([, l]) => l.length > 1);
  if (dup.length) findings.push({ kind: 'ambiguous-names', detail: `${dup.length} file name(s) exist in several folders; links to them must use paths`, paths: dup.slice(0, 20).map(([b]) => b) });
  // oversized notes
  const big = notes.filter((n) => n.body.length > 40000);
  if (big.length) findings.push({ kind: 'oversized', detail: `${big.length} note(s) over 40k characters (consider splitting by heading)`, paths: big.map((n) => n.path) });
  // generated notes that the user moved: fine, reported as info
  const state = fs.existsSync(vgPaths(vaultDir).state) ? loadState(vaultDir) : undefined;
  if (state) {
    const moved = notes.filter((n) => n.hasVg && state.notes[n.id] && state.notes[n.id].path !== n.path);
    if (moved.length) findings.push({ kind: 'moved-by-user', detail: `${moved.length} generated note(s) were moved by hand; their new location is kept`, paths: moved.map((n) => n.path) });
  }
  const linkUpdates = countLinkUpdates(notes, moves);
  return { notes: notes.length, folders: folders.length, findings, moves: dedupeMoves(moves), linkUpdates };
}

function dedupeMoves(moves: Move[]): Move[] {
  const seen = new Set<string>();
  const targets = new Set<string>();
  return moves.filter((m) => {
    if (seen.has(m.from) || targets.has(m.to.toLowerCase())) return false;
    seen.add(m.from);
    targets.add(m.to.toLowerCase());
    return true;
  });
}

function linksIn(n: VaultNote): string[] {
  const out: string[] = [];
  const text = `${JSON.stringify(n.fm)}\n${n.body}`;
  for (const m of text.matchAll(/\[\[([^\]|#\n]*)/g)) out.push(m[1].trim());
  return out;
}

function countLinkUpdates(notes: VaultNote[], moves: Move[]): number {
  if (!moves.length) return 0;
  const moved = new Set(moves.map((m) => m.from.toLowerCase()));
  const { byPath, byBase } = indexNotes(notes);
  let n = 0;
  for (const note of notes) for (const l of linksIn(note)) {
    const t = resolveWikilink(l, byPath, byBase, note.path);
    if (t && moved.has(t.path.toLowerCase()) && l.includes('/')) n++;
  }
  return n;
}

/** Apply moves: backup, move, rewrite path-qualified links, update vg state paths. */
export function applyMoves(vaultDir: string, moves: Move[], dryRun = false): { moved: Move[]; rewritten: string[]; runId: string } {
  const paths = vgPaths(vaultDir);
  const writer = new Writer([vaultDir], dryRun);
  const runId = newRunId();
  const journal = new RunJournal(paths, writer, runId);
  const before = readVault(vaultDir);
  const afterPaths = new Map(moves.map((m) => [m.from.toLowerCase(), m.to]));
  const allAfter = before.map((n) => afterPaths.get(n.path.toLowerCase()) ?? n.path);
  const baseCount = new Map<string, number>();
  for (const p of allAfter) baseCount.set(noteBasename(p).toLowerCase(), (baseCount.get(noteBasename(p).toLowerCase()) ?? 0) + 1);
  const { byPath, byBase } = indexNotes(before);
  const rewritten: string[] = [];
  // 1. rewrite links in every note whose links resolve to a moved note
  for (const n of before) {
    const abs = safeJoin(vaultDir, n.path);
    const text = normalizeText(fs.readFileSync(abs, 'utf8'));
    const lines = text.split('\n');
    const { mask } = codeMask(lines);
    let changed = false;
    const out = lines.map((l, i) => {
      if (mask[i]) return l;
      return l.replace(/(!?)\[\[([^\]|#\n]*)((?:#[^\]|\n]*)?)((?:\|[^\]\n]*)?)\]\]/g, (full, e: string, tg: string, h: string, d: string) => {
        const t = resolveWikilink(tg.trim(), byPath, byBase, n.path);
        if (!t) return full;
        const newPath = afterPaths.get(t.path.toLowerCase());
        if (!newPath && !(baseCount.get(noteBasename(t.path).toLowerCase())! > 1 && !tg.includes('/'))) return full;
        const name = linkName(newPath ?? t.path, baseCount);
        if (name === tg.trim()) return full;
        changed = true;
        return `${e}[[${name}${h}${d}]]`;
      });
    });
    if (changed) {
      const b = journal.backup(n.path);
      journal.record({ action: 'update', path: n.path, backup: b });
      writer.write(abs, out.join('\n'));
      rewritten.push(n.path);
    }
  }
  // 2. move files
  const state = fs.existsSync(paths.state) ? loadState(vaultDir) : undefined;
  for (const m of moves) {
    const from = safeJoin(vaultDir, m.from);
    const to = safeJoin(vaultDir, m.to);
    if (fs.existsSync(to)) continue;
    const b = journal.backup(m.from);
    writer.move(from, to);
    journal.record({ action: 'move', path: m.to, from: m.from, backup: b });
    if (state) for (const s of Object.values(state.notes)) if (s.path.toLowerCase() === m.from.toLowerCase()) s.path = m.to;
  }
  if (!dryRun) {
    journal.save('reorganize');
    if (state) writer.writeJson(paths.state, state);
    // remove folders left empty by the moves (only empty ones, never content)
    for (const m of moves) {
      let d = path.dirname(safeJoin(vaultDir, m.from));
      while (d.startsWith(vaultDir) && d !== vaultDir && fs.existsSync(d) && fs.readdirSync(d).length === 0 && !d.includes(VG_DIR)) {
        fs.rmdirSync(d);
        d = path.dirname(d);
      }
    }
    if (fs.existsSync(paths.dir)) updateIndex(paths.index, readVault(vaultDir));
  }
  return { moved: moves, rewritten, runId };
}
