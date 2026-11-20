import fs from 'node:fs';
import path from 'node:path';
import { assertWritable } from './safety.ts';
import { normalizeText, stableStringify, VgError } from './util.ts';

/** Writes are always routed through a Writer bound to explicit, user-authorized roots. */
export class Writer {
  roots: string[];
  dryRun: boolean;
  /** relative-to-first-root list of everything that was (or would be) written */
  log: { action: 'write' | 'mkdir' | 'copy' | 'delete' | 'move'; path: string }[] = [];
  constructor(roots: string[], dryRun = false) {
    this.roots = roots.map((r) => path.resolve(r));
    this.dryRun = dryRun;
  }
  private check(p: string): string {
    return assertWritable(p, this.roots);
  }
  mkdir(dir: string): void {
    const abs = this.check(dir);
    this.log.push({ action: 'mkdir', path: abs });
    if (!this.dryRun) fs.mkdirSync(abs, { recursive: true });
  }
  /** Atomic write: temp file in the same dir, then rename. Never leaves partial files. */
  write(file: string, content: string | Uint8Array): void {
    const abs = this.check(file);
    this.log.push({ action: 'write', path: abs });
    if (this.dryRun) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content);
    try {
      fs.renameSync(tmp, abs);
    } catch {
      // Windows can refuse rename over a file held open by another process: fall back to copy.
      fs.copyFileSync(tmp, abs);
      fs.rmSync(tmp, { force: true });
    }
  }
  writeJson(file: string, data: unknown): void {
    this.write(file, `${stableStringify(data)}\n`);
  }
  copy(from: string, to: string): void {
    const dst = this.check(to);
    this.log.push({ action: 'copy', path: dst });
    if (this.dryRun) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(from, dst);
  }
  move(from: string, to: string): void {
    const a = this.check(from);
    const b = this.check(to);
    this.log.push({ action: 'move', path: `${a} -> ${b}` });
    if (this.dryRun) return;
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
  }
  /** Deletion is only allowed for vg-owned scratch locations (index, temp, pruned backups). */
  deleteOwned(target: string, ownedRoot: string): void {
    const abs = this.check(target);
    if (!path.resolve(abs).startsWith(path.resolve(ownedRoot) + path.sep) && path.resolve(abs) !== path.resolve(ownedRoot)) {
      throw new VgError('E_WRITE_DENIED', `Refusing to delete outside vg-owned area: ${abs}`);
    }
    this.log.push({ action: 'delete', path: abs });
    if (!this.dryRun) fs.rmSync(abs, { recursive: true, force: true });
  }
}

export function readText(abs: string): string {
  return normalizeText(fs.readFileSync(abs, 'utf8'));
}
export function readJsonFile<T>(abs: string): T | undefined {
  try {
    return JSON.parse(readText(abs)) as T;
  } catch {
    return undefined;
  }
}
export function exists(abs: string): boolean {
  return fs.existsSync(abs);
}
export function isDir(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}
export function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}
