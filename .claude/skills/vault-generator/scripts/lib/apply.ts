// Reconciler: writes a Plan into a vault without destroying user content.
// Rules (see references/sync-and-conflicts.md):
//  - content outside <!-- vg:begin/end --> is never modified
//  - existing notes are never moved or renamed by generate/sync (only by reorganize --apply)
//  - a region edited by the user is kept; if the source also changed, a 3-way merge is attempted,
//    otherwise the incoming version is saved aside and a conflict is recorded
//  - notes whose source disappeared are marked stale, never deleted (unless --prune-stale)
import fs from 'node:fs';
import path from 'node:path';
import type { ConflictRecord, Manifest, NoteAction, PlannedNote, VaultNote } from './types.ts';
import type { Plan } from './planner.ts';
import { TOKEN_RE } from './planner.ts';
import type { RunJournal, State, VgPaths } from './state.ts';
import { addConflict, baseSnapshotPath, conflictId, readBase } from './state.ts';
import type { Writer } from './fsutil.ts';
import { mergeText } from './diff3.ts';
import { safeJoin } from './safety.ts';
import { BEGIN, END, MANUAL_HINT, indexNotes, linkName, mergeFrontmatter, noteBasename, parseNote, readVault, regionHash, renderNote } from './vault.ts';
import { normalizeText, posixDir, posixJoin, sha256, t } from './util.ts';

export type ConflictPolicy = 'save-both' | 'keep-mine' | 'take-source';

export interface ApplyInput {
  plan: Plan;
  paths: VgPaths;
  manifest: Manifest;
  state: State;
  writer: Writer;
  journal: RunJournal;
  runId: string;
  language: 'en' | 'es';
  sourceRoots: Record<string, string>;
  conflictPolicy: ConflictPolicy;
  /** explicit per-note conflict resolutions: id → mine | source | merged */
  resolutions: Record<string, string>;
  pruneStale: boolean;
  /** keys of notes that are out of the current scope (left untouched) */
  outOfScope: (key: string) => boolean;
  /** keys whose sources still exist (not stale) */
  sourceExists: (key: string) => boolean;
}
export interface ApplyChange {
  id: string;
  path: string;
  action: NoteAction | 'out-of-scope' | 'detached' | 'trashed';
  detail?: string;
}
export interface ApplyResult {
  changes: ApplyChange[];
  counts: Record<string, number>;
  conflicts: ConflictRecord[];
  attachments: number;
  /** final vault path of each planned note id */
  paths: Record<string, string>;
}

export function applyPlan(inp: ApplyInput): ApplyResult {
  const { plan, paths, state, writer, journal } = inp;
  const vault = paths.vault;
  const existing = readVault(vault);
  const { byId } = indexNotes(existing);
  const existingPaths = new Set(existing.map((n) => n.path.toLowerCase()));
  const changes: ApplyChange[] = [];
  const conflicts: ConflictRecord[] = [];

  // 1. final paths: existing managed notes keep their location; new notes avoid collisions
  const finalPath = new Map<string, string>();
  const reserved = new Set(existingPaths);
  for (const n of plan.notes) {
    const ex = byId.get(n.id);
    if (ex && ex.hasVg) {
      finalPath.set(n.id, ex.path);
      continue;
    }
    let p = posixJoin(n.folder, `${n.fileName}.md`);
    for (let k = 2; reserved.has(p.toLowerCase()); k++) p = posixJoin(n.folder, `${n.fileName} ${k}.md`);
    reserved.add(p.toLowerCase());
    finalPath.set(n.id, p);
  }
  // basename counts across the whole vault after this run (decides short vs path-qualified links)
  const allPaths = new Set<string>([...existing.map((e) => e.path), ...finalPath.values()]);
  const baseCount = new Map<string, number>();
  for (const p of allPaths) baseCount.set(noteBasename(p).toLowerCase(), (baseCount.get(noteBasename(p).toLowerCase()) ?? 0) + 1);
  const linkFor = (id: string): string | undefined => {
    const p = finalPath.get(id) ?? byId.get(id)?.path;
    return p ? linkName(p, baseCount) : undefined;
  };
  const resolveTokens = (text: string, notePath: string, inProperty = false): string =>
    text.replace(TOKEN_RE, (_m, kind: string, target: string, heading: string | undefined, display: string | undefined) => {
      if (kind === 'att') {
        const rel = path.posix.relative(posixDir(notePath), target);
        return rel.split('/').map(encodeURIComponent).join('/');
      }
      const name = linkFor(target);
      if (!name) return display ?? '';
      const h = heading ? `#${heading}` : '';
      if (inProperty) return `[[${name}${h}]]`;
      return `[[${name}${h}${display && display !== name ? `|${display}` : ''}]]`;
    });
  const resolveFm = (fm: Record<string, unknown>, notePath: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (typeof v === 'string') out[k] = resolveTokens(v, notePath, true);
      else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? resolveTokens(x, notePath, true) : x)).filter((x) => x !== '');
      else out[k] = v;
    }
    return out;
  };

  // 2. write each planned note
  let attachments = 0;
  for (const n of plan.notes) {
    const notePath = finalPath.get(n.id)!;
    const abs = safeJoin(vault, notePath);
    const region = normalizeText(resolveTokens(n.body, notePath)).trim();
    const genFm = resolveFm(n.fm, notePath);
    const newHash = regionHash(region);
    const prev = state.notes[n.id];
    const ex = byId.get(n.id);
    let action: NoteAction = 'create';
    let detail: string | undefined;
    let content: string | undefined;
    let baseToWrite: string | undefined = region;
    let managedFm: Record<string, unknown> = {};

    if (!ex || !ex.hasVg) {
      const merged = mergeFrontmatter(undefined, genFm, undefined);
      managedFm = merged.managed;
      content = renderNote(merged.fm, '', region, `\n\n${MANUAL_HINT}\n`);
      action = 'create';
    } else {
      const text = normalizeText(fs.readFileSync(abs, 'utf8'));
      const parts = parseNote(text);
      if (!parts.hasMarkers) {
        changes.push({ id: n.id, path: notePath, action: 'detached', detail: 'vg markers removed by the user; note is treated as manual and left untouched' });
        continue;
      }
      const curHash = regionHash(parts.region ?? '');
      const genHash = prev?.genHash;
      const userEdited = genHash !== undefined && curHash !== genHash;
      const mergedFm = mergeFrontmatter(parts.fm, genFm, prev?.managedFm);
      managedFm = mergedFm.managed;
      let newRegion = region;
      if (curHash === newHash) {
        action = 'unchanged';
        baseToWrite = prev ? undefined : region;
      } else if (!userEdited) {
        action = 'update';
      } else if (newHash === genHash) {
        action = 'preserved-edited';
        newRegion = parts.region ?? '';
        baseToWrite = undefined;
      } else {
        const res = inp.resolutions[n.id];
        const base = readBase(paths, n.id);
        const m = base !== undefined ? mergeText(base.trim(), (parts.region ?? '').trim(), region) : undefined;
        if (res === 'mine' || (!res && inp.conflictPolicy === 'keep-mine')) {
          action = 'preserved-edited';
          newRegion = parts.region ?? '';
          detail = 'user version kept (source also changed)';
        } else if (res === 'source' || (!res && inp.conflictPolicy === 'take-source')) {
          action = 'update';
          detail = 'source version taken; previous version backed up';
        } else if (m?.clean) {
          action = 'merged';
          newRegion = m.lines.join('\n');
          detail = 'user edits and source changes merged automatically';
        } else {
          action = 'conflict';
          newRegion = parts.region ?? '';
          const cid = conflictId(n.id, inp.runId);
          const incomingRel = path.posix.join('.vault-generator', 'conflicts', `${n.id}.incoming.md`);
          const incoming = renderNote(mergedFm.fm, '', m ? m.lines.join('\n') : region, '');
          writer.write(path.join(paths.conflicts, `${n.id}.incoming.md`), incoming);
          const rec: ConflictRecord = { id: cid, noteId: n.id, path: notePath, kind: 'edited-generated-region', incoming: incomingRel, runId: inp.runId, detail: m ? `${m.conflicts} conflicting hunk(s); merge preview with markers saved` : 'no merge base available; incoming version saved' };
          conflicts.push(rec);
          addConflict(inp.manifest, rec);
          detail = rec.detail;
        }
      }
      if (action === 'conflict' || action === 'preserved-edited') {
        const vg = { ...(mergedFm.fm.vg as Record<string, unknown>), status: action === 'conflict' ? 'conflict' : (mergedFm.fm.vg as Record<string, unknown>).status };
        mergedFm.fm.vg = vg;
        if (action === 'conflict') mergedFm.fm.tags = [...new Set([...((mergedFm.fm.tags as string[]) ?? []), 'status/conflict'])];
      }
      if (action !== 'conflict' && inp.manifest.conflicts.some((c) => c.noteId === n.id)) {
        inp.manifest.conflicts = inp.manifest.conflicts.filter((c) => c.noteId !== n.id);
        detail = `${detail ? `${detail}; ` : ''}previous conflict resolved`;
      }
      content = renderNote(mergedFm.fm, parts.pre, newRegion, parts.post);
      if (content === text) {
        // nothing to write: a note that merely keeps earlier user edits is reported as unchanged
        if (action === 'update' || (action === 'preserved-edited' && !detail)) action = 'unchanged';
        content = undefined;
      } else if (action === 'unchanged') action = 'update';
      if (content !== undefined) {
        const b = journal.backup(notePath);
        journal.record({ action: 'update', path: notePath, backup: b });
      }
      if (action === 'merged') baseToWrite = region;
      if (action === 'preserved-edited' && detail?.startsWith('user version kept')) baseToWrite = region; // new merge base = latest generated
    }
    if (content !== undefined) {
      writer.write(abs, content);
      if (action === 'create') journal.record({ action: 'create', path: notePath });
    }
    if (baseToWrite !== undefined) writer.write(baseSnapshotPath(paths, n.id), `${baseToWrite}\n`);
    // attachments
    for (const att of n.attachments) {
      const root = inp.sourceRoots[att.from.source];
      if (!root) continue;
      try {
        const src = safeJoin(root, att.from.path);
        const dst = safeJoin(vault, att.to);
        if (!fs.existsSync(dst) || sha256(fs.readFileSync(dst)) !== sha256(fs.readFileSync(src))) {
          writer.copy(src, dst);
          attachments++;
        }
      } catch {
        /* missing or unsafe attachment: link stays relative to the vault path and validate reports it */
      }
    }
    state.notes[n.id] = {
      key: n.key, path: notePath,
      genHash: action === 'preserved-edited' || action === 'conflict' ? (newHash === prev?.genHash || !prev ? (prev?.genHash ?? newHash) : newHash) : newHash,
      managedFm, origin: n.origin, sources: n.sources.map((s) => `${s.source}:${s.path}`),
      createdRun: prev?.createdRun ?? inp.runId, updatedRun: action === 'unchanged' ? (prev?.updatedRun ?? inp.runId) : inp.runId,
    };
    // a conflicting note keeps the *old* genHash so the user edit is still detected next run,
    // and the merge base stays the previous generated version
    if (action === 'conflict' && prev) state.notes[n.id].genHash = prev.genHash;
    state.keys[n.key] = n.id;
    changes.push({ id: n.id, path: notePath, action, detail });
  }

  // 3. managed notes that are no longer planned
  const planned = new Set(plan.notes.map((n) => n.id));
  for (const ex of existing.filter((e) => e.hasVg && !planned.has(e.id))) {
    const key = ex.key ?? state.notes[ex.id]?.key;
    if (!key) continue;
    if (inp.outOfScope(key) || inp.sourceExists(key)) {
      changes.push({ id: ex.id, path: ex.path, action: 'out-of-scope' });
      continue;
    }
    if (inp.pruneStale) {
      const b = journal.backup(ex.path);
      const dst = path.join(paths.trash, inp.runId, ex.path);
      writer.move(safeJoin(vault, ex.path), dst);
      journal.record({ action: 'trash', path: ex.path, backup: b });
      delete state.notes[ex.id];
      changes.push({ id: ex.id, path: ex.path, action: 'trashed', detail: `moved to .vault-generator/trash/${inp.runId}` });
      continue;
    }
    const r = markStale(ex, inp, state);
    if (r) changes.push(r);
  }

  const counts: Record<string, number> = {};
  for (const c of changes) counts[c.action] = (counts[c.action] ?? 0) + 1;
  return { changes, counts, conflicts, attachments, paths: Object.fromEntries(finalPath) };
}

function markStale(ex: VaultNote, inp: ApplyInput, state: State): ApplyChange | undefined {
  const abs = safeJoin(inp.paths.vault, ex.path);
  const text = normalizeText(fs.readFileSync(abs, 'utf8'));
  const parts = parseNote(text);
  const vg = (parts.fm.vg ?? {}) as Record<string, unknown>;
  if (vg.status === 'stale') return { id: ex.id, path: ex.path, action: 'stale', detail: 'already marked stale' };
  const prev = state.notes[ex.id];
  const notice = `> [!warning] ${t(inp.language, 'staleNotice')}`;
  let region = parts.region ?? '';
  const edited = prev && regionHash(region) !== prev.genHash;
  if (parts.hasMarkers && !region.startsWith(notice)) region = `${notice}\n\n${region}`;
  const fm = { ...parts.fm, vg: { ...vg, status: 'stale' }, tags: [...new Set([...(Array.isArray(parts.fm.tags) ? (parts.fm.tags as string[]) : []), 'status/stale'])] };
  const content = parts.hasMarkers ? renderNote(fm, parts.pre, region, parts.post) : text;
  if (content === text) return undefined;
  const b = inp.journal.backup(ex.path);
  inp.journal.record({ action: 'mark-stale', path: ex.path, backup: b });
  inp.writer.write(abs, content);
  if (prev) {
    prev.genHash = edited ? prev.genHash : regionHash(region);
    prev.updatedRun = inp.runId;
  }
  return { id: ex.id, path: ex.path, action: 'stale', detail: edited ? 'source removed; note kept (it contains your edits)' : 'source removed; note kept and flagged' };
}

/** Replace the region of a note with explicit content (used by conflict resolution). */
export function setRegion(abs: string, region: string): string {
  const parts = parseNote(normalizeText(fs.readFileSync(abs, 'utf8')));
  return renderNote(parts.fm, parts.pre, region, parts.post);
}
export { BEGIN, END };
export type { PlannedNote };
