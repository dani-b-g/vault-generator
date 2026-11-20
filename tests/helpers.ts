import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, runOp } from '../skills/vault-generator/scripts/lib/cli.ts';
import type { OpResult } from '../skills/vault-generator/scripts/lib/types.ts';
import { readVault } from '../skills/vault-generator/scripts/lib/vault.ts';

/** Run the engine in-process exactly like the CLI does (argument parsing included). */
export async function vg(cwd: string, ...args: string[]): Promise<OpResult> {
  const { opts, errors } = parseArgs([...args, '--json'], cwd);
  if (errors.length) throw new Error(errors.join('; '));
  return runOp(opts);
}
/** generate with the destination question pre-answered (the common case in tests) */
export const generate = (cwd: string, ...args: string[]) => vg(cwd, '--mode', 'generate', '--answer', 'destination=default', ...args);

export function notes(vaultDir: string) {
  return readVault(vaultDir);
}
export function noteByTitle(vaultDir: string, title: string) {
  const n = readVault(vaultDir).find((x) => x.title === title);
  if (!n) throw new Error(`note "${title}" not found; have: ${readVault(vaultDir).map((x) => x.title).join(', ')}`);
  return n;
}
export function read(vaultDir: string, rel: string): string {
  return fs.readFileSync(path.join(vaultDir, rel), 'utf8');
}
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'backups' || e.name === 'index.sqlite') continue;
        walk(p, r);
      } else if (!r.endsWith('index.sqlite') && !r.includes('/backups/')) out[r] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}
export const vaultOf = (dir: string) => path.join(dir, 'knowledge-vault');
