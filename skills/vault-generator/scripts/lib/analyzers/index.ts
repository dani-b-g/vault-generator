import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Analyzer, Transformer } from '../types.ts';
import { sha256, VgError } from '../util.ts';
import { codeAnalyzer } from './code.ts';
import { configAnalyzer } from './config.ts';
import { htmlAnalyzer } from './html.ts';
import { markdownAnalyzer } from './markdown.ts';
import { openapiAnalyzer } from './openapi.ts';

export const BUILTIN_ANALYZERS: Analyzer[] = [openapiAnalyzer, markdownAnalyzer, htmlAnalyzer, configAnalyzer, codeAnalyzer];

export interface PluginModule {
  analyzers?: Analyzer[];
  transformers?: Transformer[];
}
export interface LoadedPlugins {
  analyzers: Analyzer[];
  transformers: Transformer[];
  /** plugin path → content hash (persisted as "trusted" only after the user confirms) */
  hashes: Record<string, string>;
  untrusted: string[];
  errors: string[];
}

/**
 * Plugins are local modules declared in the config. They run code, so they are only loaded when
 * their current content hash matches a hash the user explicitly trusted (stored in the manifest).
 */
export async function loadPlugins(baseDir: string, specs: string[], trusted: Record<string, string>, trustNow = false): Promise<LoadedPlugins> {
  const out: LoadedPlugins = { analyzers: [], transformers: [], hashes: {}, untrusted: [], errors: [] };
  for (const spec of specs) {
    const abs = path.resolve(baseDir, spec);
    if (!fs.existsSync(abs)) {
      out.errors.push(`plugin not found: ${spec}`);
      continue;
    }
    const hash = sha256(fs.readFileSync(abs)).slice(0, 16);
    out.hashes[spec] = hash;
    if (!trustNow && trusted[spec] !== hash) {
      out.untrusted.push(spec);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(abs).href)) as PluginModule & { default?: PluginModule };
      const m = mod.default ?? mod;
      for (const a of m.analyzers ?? []) {
        validateAnalyzer(a, spec);
        out.analyzers.push(a);
      }
      for (const t of m.transformers ?? []) {
        if (!t.id || typeof t.run !== 'function') throw new VgError('E_PLUGIN', `transformer without id/run in ${spec}`);
        out.transformers.push(t);
      }
    } catch (e) {
      out.errors.push(`plugin ${spec} failed to load: ${(e as Error).message}`);
    }
  }
  return out;
}

function validateAnalyzer(a: Analyzer, spec: string): void {
  for (const k of ['id', 'version', 'description'] as const) if (typeof a[k] !== 'string' || !a[k]) throw new VgError('E_PLUGIN', `analyzer in ${spec} is missing "${k}"`);
  if (typeof a.match !== 'function' || typeof a.analyze !== 'function') throw new VgError('E_PLUGIN', `analyzer ${a.id} in ${spec} must implement match() and analyze()`);
  if (!Array.isArray(a.handles) || !Array.isArray(a.limitations)) throw new VgError('E_PLUGIN', `analyzer ${a.id} in ${spec} must declare handles[] and limitations[]`);
}

/** Highest-priority analyzer for a file. Plugins win ties against built-ins. */
export function pickAnalyzer(analyzers: Analyzer[], file: Parameters<Analyzer['match']>[0], head: string): Analyzer | undefined {
  let best: Analyzer | undefined;
  let score = 0;
  for (const a of analyzers) {
    let s = 0;
    try {
      s = a.match(file, head) || 0;
    } catch {
      s = 0;
    }
    if (s > score || (s === score && s > 0 && !BUILTIN_ANALYZERS.includes(a))) {
      best = a;
      score = s;
    }
  }
  return best;
}
