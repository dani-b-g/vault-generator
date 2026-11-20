// Installer: copies this skill into the skill directories that Claude Code and/or Codex scan.
//   project scope: <target>/.claude/skills/vault-generator  and  <target>/.agents/skills/vault-generator
//   user scope:    ~/.claude/skills/vault-generator         and  ~/.agents/skills/vault-generator
// Non-destructive: a copy modified by hand (or a foreign skill with the same name) is only replaced with
// --force, and it is backed up first to <root>/.vault-generator-install-backups/. Usage:
//   node scripts/install.ts [--target <dir>] [--global] [--agent claude|codex|both] [--force] [--dry-run] [--uninstall]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateSkillDir } from './lib/skillcheck.ts';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'vault-generator';
const BACKUP_DIR = '.vault-generator-install-backups';
const SKIP = new Set(['node_modules', '.git', '.DS_Store', '.vg-install.json']);

function parse(argv: string[]) {
  const o = { target: process.cwd(), global: false, agent: 'both', force: false, dryRun: false, uninstall: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') o.target = path.resolve(argv[++i] ?? '.');
    else if (a === '--global') o.global = true;
    else if (a === '--agent') o.agent = argv[++i] ?? 'both';
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('node scripts/install.ts [--target <dir>] [--global] [--agent claude|codex|both] [--force] [--dry-run] [--uninstall]\n');
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!['claude', 'codex', 'both'].includes(o.agent)) throw new Error('--agent must be claude, codex or both');
  return o;
}

function files(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p, base));
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out.sort();
}
function treeHash(dir: string): string {
  const h = createHash('sha256');
  for (const f of files(dir)) {
    h.update(f.replace(/\\/g, '/'));
    h.update(fs.readFileSync(path.join(dir, f)));
  }
  return h.digest('hex').slice(0, 16);
}

function main() {
  const o = parse(process.argv.slice(2));
  const root = o.global ? os.homedir() : o.target;
  const targets: { agent: string; dir: string }[] = [];
  if (o.agent !== 'codex') targets.push({ agent: 'claude-code', dir: path.join(root, '.claude', 'skills', NAME) });
  if (o.agent !== 'claude') targets.push({ agent: 'codex', dir: path.join(root, '.agents', 'skills', NAME) });
  const srcHash = treeHash(SKILL_DIR);
  const report: Record<string, unknown>[] = [];
  let failed = false;
  for (const t of targets) {
    if (path.resolve(t.dir) === SKILL_DIR) {
      report.push({ ...t, action: 'skipped', reason: 'target is the source directory' });
      continue;
    }
    const exists = fs.existsSync(t.dir);
    if (o.uninstall) {
      if (!exists) {
        report.push({ ...t, action: 'not-installed' });
        continue;
      }
      const marker = path.join(t.dir, '.vg-install.json');
      if (!fs.existsSync(marker) && !o.force) {
        report.push({ ...t, action: 'refused', reason: 'directory was not created by this installer (use --force)' });
        failed = true;
        continue;
      }
      if (!o.dryRun) fs.rmSync(t.dir, { recursive: true, force: true });
      report.push({ ...t, action: o.dryRun ? 'would-uninstall' : 'uninstalled' });
      continue;
    }
    if (exists) {
      const current = treeHash(t.dir);
      if (current === srcHash) {
        report.push({ ...t, action: 'up-to-date' });
        continue;
      }
      let installed: { hash?: string } = {};
      try {
        installed = JSON.parse(fs.readFileSync(path.join(t.dir, '.vg-install.json'), 'utf8'));
      } catch {
        installed = {};
      }
      const locallyModified = installed.hash && installed.hash !== current;
      if (!o.force && (locallyModified || !installed.hash)) {
        report.push({ ...t, action: 'refused', reason: locallyModified ? 'installed copy was modified locally; re-run with --force (a backup is kept)' : 'a different skill with this name exists; re-run with --force (a backup is kept)' });
        failed = true;
        continue;
      }
      if (!o.dryRun) {
        if (locallyModified || !installed.hash) {
          // keep what --force replaces, outside the skills directories so agents do not load it as a skill
          const backup = path.join(root, BACKUP_DIR, `${t.agent}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.cpSync(t.dir, backup, { recursive: true });
          report.push({ ...t, backup });
        }
        // an untouched copy from an earlier installer run carries nothing worth keeping
        fs.rmSync(t.dir, { recursive: true, force: true });
      }
    }
    if (!o.dryRun) {
      for (const f of files(SKILL_DIR)) {
        const dst = path.join(t.dir, f);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(SKILL_DIR, f), dst);
      }
      fs.writeFileSync(path.join(t.dir, '.vg-install.json'), `${JSON.stringify({ name: NAME, hash: srcHash, from: 'vault-generator installer', at: new Date().toISOString() }, null, 2)}\n`);
      const check = validateSkillDir(t.dir);
      if (!check.ok) failed = true;
      report.push({ ...t, action: exists ? 'updated' : 'installed', valid: check.ok, errors: check.errors });
    } else report.push({ ...t, action: exists ? 'would-update' : 'would-install' });
  }
  const res = { ok: !failed, skill: NAME, source: SKILL_DIR, scope: o.global ? 'user' : 'project', results: report };
  if (o.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  else {
    for (const r of report) process.stdout.write(`${r.action === 'refused' ? '✖' : '✔'} ${r.agent}: ${r.action} ${r.dir}${r.reason ? ` — ${r.reason}` : ''}${r.backup ? ` (backup: ${r.backup})` : ''}\n`);
    if (!o.uninstall && !failed) process.stdout.write(`\nInvoke with /${NAME} in Claude Code and $${NAME} in Codex (restart the agent if the skill does not appear).\n`);
  }
  process.exitCode = failed ? 1 : 0;
}
main();
