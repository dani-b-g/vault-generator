import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './types.ts';
import { VgError, normalizeText } from './util.ts';

export const CONFIG_NAMES = ['vault-generator.config.json', '.vault-generator.json'];

export const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', '.hg', '.svn', '.vault-generator', '.obsidian', '.trash',
  // AI agent configuration (installed skills, commands, settings): tooling, not project knowledge
  '.claude', '.agents', '.codex', '.cursor', '.windsurf', '.vault-generator-install-backups',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.angular', '.turbo', '.nx', '.parcel-cache', '.cache', '.gradle',
  'coverage', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', '.eggs',
  '.idea', 'bower_components', 'jspm_packages', '.terraform', 'Pods', 'DerivedData', '.dart_tool', '.pub-cache', 'obj',
];

export function defaultConfig(): Config {
  return {
    language: 'en',
    depth: 'standard',
    exclude: [],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS],
    useGitignore: true,
    include: [],
    access: { deny: [], restricted: [], followSymlinks: 'within-roots', maxFileBytes: 2 * 1024 * 1024 },
    layout: { folderThreshold: 6, maxNoteChars: 24000 },
    retention: { backupRuns: 10 },
    attachments: { copy: true, maxBytes: 5 * 1024 * 1024 },
    plugins: [],
    truthPrecedence: ['manifest', 'code', 'generated-doc', 'doc', 'readme'],
  };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function merge<T>(base: T, over: unknown): T {
  if (!isObj(over) || !isObj(base)) return (over === undefined ? base : (over as T));
  const out: Json = { ...(base as Json) };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in out)) continue; // unknown keys are ignored (validated separately)
    out[k] = isObj(out[k]) && isObj(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

export function validateConfig(raw: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(raw)) return ['config must be a JSON object'];
  const known = new Set(Object.keys(defaultConfig()).concat(['$schema', 'sources', 'vault', 'scope', 'name']));
  for (const k of Object.keys(raw)) if (!known.has(k)) errs.push(`unknown key "${k}"`);
  const arr = (k: string, v: unknown) => {
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) errs.push(`"${k}" must be an array of strings`);
  };
  for (const k of ['exclude', 'include', 'ignoreDirs', 'plugins', 'truthPrecedence', 'sources', 'scope']) arr(k, raw[k]);
  if (raw.language !== undefined && !['en', 'es'].includes(raw.language as string)) errs.push('"language" must be "en" or "es"');
  if (raw.depth !== undefined && !['shallow', 'standard', 'deep'].includes(raw.depth as string)) errs.push('"depth" must be shallow|standard|deep');
  if (raw.access !== undefined) {
    if (!isObj(raw.access)) errs.push('"access" must be an object');
    else {
      arr('access.deny', raw.access.deny);
      arr('access.restricted', raw.access.restricted);
      if (raw.access.followSymlinks !== undefined && !['within-roots', 'never'].includes(raw.access.followSymlinks as string)) errs.push('"access.followSymlinks" must be within-roots|never');
    }
  }
  return errs;
}

export interface LoadedConfig {
  config: Config;
  /** absolute path of the config file, if one was found */
  file?: string;
  /** extra settings that are not part of Config */
  extra: { sources?: string[]; vault?: string; scope?: string[]; name?: string };
  errors: string[];
}

export function findConfigFile(startDir: string): string | undefined {
  for (const n of CONFIG_NAMES) {
    const p = path.join(startDir, n);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export function loadConfig(startDir: string, explicit?: string): LoadedConfig {
  const file = explicit ? path.resolve(startDir, explicit) : findConfigFile(startDir);
  const base = defaultConfig();
  if (!file) return { config: base, extra: {}, errors: [] };
  if (!fs.existsSync(file)) throw new VgError('E_CONFIG', `Config file not found: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(normalizeText(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    throw new VgError('E_CONFIG', `Invalid JSON in ${file}: ${(e as Error).message}`);
  }
  const errors = validateConfig(raw);
  const r = (isObj(raw) ? raw : {}) as Json;
  const config = merge(base, r);
  // arrays that extend defaults rather than replace them
  if (Array.isArray(r.ignoreDirs)) config.ignoreDirs = [...new Set([...DEFAULT_IGNORE_DIRS, ...(r.ignoreDirs as string[])])];
  return {
    config,
    file,
    errors,
    extra: {
      sources: Array.isArray(r.sources) ? (r.sources as string[]) : undefined,
      vault: typeof r.vault === 'string' ? r.vault : undefined,
      scope: Array.isArray(r.scope) ? (r.scope as string[]) : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
    },
  };
}
