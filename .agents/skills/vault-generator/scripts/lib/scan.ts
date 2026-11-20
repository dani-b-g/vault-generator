import fs from 'node:fs';
import path from 'node:path';
import type { Config, FileInfo, ScanResult, SkipRecord, SourceInfo } from './types.ts';
import { isInside, isSensitiveFile, looksBinary } from './safety.ts';
import { extOf, globToRegExp, matchAny, normalizeText, sha256, toPosix } from './util.ts';

const CODE_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.groovy': 'groovy',
  '.cs': 'csharp', '.fs': 'fsharp', '.vb': 'vb',
  '.php': 'php', '.rb': 'ruby', '.swift': 'swift', '.m': 'objective-c', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
  '.lua': 'lua', '.r': 'r', '.jl': 'julia', '.sh': 'shell', '.bash': 'shell', '.ps1': 'powershell', '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'protobuf', '.tf': 'terraform', '.hcl': 'hcl',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif']);
const UNSUPPORTED_DOC_EXT = new Set(['.pdf', '.docx', '.doc', '.odt', '.pptx', '.xlsx', '.epub', '.rtf']);
const CONFIG_NAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'justfile', 'procfile', 'jenkinsfile', 'vagrantfile', 'gemfile', 'rakefile',
  '.env.example', '.env.sample', '.env.template', '.env.dist', '.nvmrc', '.node-version', '.python-version', '.tool-versions',
  '.ruby-version', '.java-version', 'go.mod', 'go.work', 'requirements.txt', 'pipfile', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'cargo.toml', 'composer.json', 'license', 'license.md', 'codeowners',
]);

export function classify(rel: string): { ext: string; format: string } {
  const base = rel.split('/').pop()!.toLowerCase();
  const ext = extOf(base);
  if (CONFIG_NAMES.has(base) || base.startsWith('dockerfile') || base.endsWith('.dockerfile')) return { ext, format: 'config' };
  if (['.md', '.markdown', '.mdx', '.mdown'].includes(ext)) return { ext, format: 'markdown' };
  if (['.html', '.htm', '.xhtml'].includes(ext)) return { ext, format: 'html' };
  if (['.txt', '.rst', '.adoc', '.asciidoc', '.org', '.textile'].includes(ext)) return { ext, format: 'text' };
  if (['.mmd', '.mermaid'].includes(ext)) return { ext, format: 'mermaid' };
  if (ext === '.json' || ext === '.jsonc' || ext === '.json5') return { ext, format: 'json' };
  if (ext === '.yaml' || ext === '.yml') return { ext, format: 'yaml' };
  if (ext === '.toml') return { ext, format: 'toml' };
  if (ext === '.xml' || ext === '.csproj' || ext === '.fsproj' || ext === '.sln' || ext === '.props') return { ext, format: 'xml' };
  if (IMAGE_EXT.has(ext)) return { ext, format: 'image' };
  if (UNSUPPORTED_DOC_EXT.has(ext)) return { ext, format: 'unsupported' };
  if (CODE_EXT[ext]) return { ext, format: `code:${CODE_EXT[ext]}` };
  return { ext, format: 'other' };
}
export const codeLanguage = (ext: string): string | undefined => CODE_EXT[ext];

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** posix dir (relative to source root) where the ignore file lives; '' = root */
  base: string;
}
function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of normalizeText(text).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    const dirOnly = line.endsWith('/');
    rules.push({ re: globToRegExp(line), negate, dirOnly, base });
  }
  return rules;
}
function ignoredByRules(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    let sub = rel;
    if (r.base) {
      if (!rel.startsWith(`${r.base}/`)) continue;
      sub = rel.slice(r.base.length + 1);
    }
    if (r.dirOnly && !isDir && !sub.includes('/')) continue;
    if (r.re.test(sub)) ignored = !r.negate;
  }
  return ignored;
}

const RESTRICTED_SEGMENTS = /(^|\/)(private|confidential|restricted|internal-only|secret|secrets)(\/|$)/i;
const RESTRICTED_FM = /^---\n(?:[^\n]*\n){0,40}?(?:access|visibility|classification)\s*:\s*["']?(private|restricted|confidential|internal-only|secret)\b|^---\n(?:[^\n]*\n){0,40}?confidential\s*:\s*(?:true|yes)\b/i;

export interface ScanOptions {
  config: Config;
  /** absolute directories never descended into (e.g. the vault being generated) */
  excludeAbs?: string[];
  /** previous hashes by `${source}:${path}` to skip re-reading unchanged files */
  previous?: Record<string, { hash: string; size: number; mtimeMs: number }>;
  maxFiles?: number;
}

export function scanSource(src: SourceInfo, opts: ScanOptions): ScanResult {
  const { config } = opts;
  const files: FileInfo[] = [];
  const skipped: SkipRecord[] = [];
  let ignoredDirs = 0;
  const maxFiles = opts.maxFiles ?? 200_000;
  const excludeAbs = (opts.excludeAbs ?? []).map((p) => path.resolve(p));
  const ignoreDirs = new Set(config.ignoreDirs.map((d) => d.toLowerCase()));
  const visited = new Set<string>();
  const rootReal = fs.realpathSync.native(src.root);

  const walk = (absDir: string, relDir: string, rules: IgnoreRule[]) => {
    let real: string;
    try {
      real = fs.realpathSync.native(absDir);
    } catch {
      skipped.push({ source: src.id, path: relDir || '.', reason: 'unreadable' });
      return;
    }
    if (visited.has(real)) return; // symlink cycle
    visited.add(real);
    let localRules = rules;
    if (config.useGitignore) {
      for (const name of ['.gitignore', '.vgignore']) {
        const p = path.join(absDir, name);
        if (fs.existsSync(p)) {
          try {
            localRules = localRules.concat(parseIgnoreFile(fs.readFileSync(p, 'utf8'), relDir));
          } catch {
            /* unreadable ignore file: ignore */
          }
        }
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      skipped.push({ source: src.id, path: relDir || '.', reason: 'unreadable' });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      const abs = path.join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        if (config.access.followSymlinks === 'never') {
          skipped.push({ source: src.id, path: rel, reason: 'symlink-outside-root' });
          continue;
        }
        try {
          const target = fs.realpathSync.native(abs);
          if (!isInside(rootReal, target)) {
            skipped.push({ source: src.id, path: rel, reason: 'symlink-outside-root' });
            continue;
          }
          const st = fs.statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          skipped.push({ source: src.id, path: rel, reason: 'unreadable' });
          continue;
        }
      }
      if (isDir) {
        if (ignoreDirs.has(e.name.toLowerCase())) {
          ignoredDirs++;
          continue;
        }
        if (excludeAbs.some((x) => isInside(x, abs))) continue;
        if (fs.existsSync(path.join(abs, '.vault-generator', 'manifest.json'))) {
          ignoredDirs++; // another generated vault: never re-ingest generated output
          continue;
        }
        if (matchAny(config.access.deny, rel)) {
          skipped.push({ source: src.id, path: rel, reason: 'denied-by-policy' });
          continue;
        }
        if (ignoredByRules(localRules, rel, true) || matchAny(config.exclude, rel)) {
          ignoredDirs++;
          continue;
        }
        walk(abs, rel, localRules);
        continue;
      }
      if (!isFile) continue;
      if (matchAny(config.access.deny, rel)) {
        skipped.push({ source: src.id, path: rel, reason: 'denied-by-policy' });
        continue;
      }
      if (isSensitiveFile(rel)) {
        skipped.push({ source: src.id, path: rel, reason: 'sensitive-file' });
        continue;
      }
      if (ignoredByRules(localRules, rel, false) || matchAny(config.exclude, rel)) continue;
      if (config.include.length && !matchAny(config.include, rel)) continue;
      if (src.only && !src.only.includes(rel)) continue;
      const { ext, format } = classify(rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        skipped.push({ source: src.id, path: rel, reason: 'unreadable' });
        continue;
      }
      const limit = format === 'image' ? config.attachments.maxBytes : config.access.maxFileBytes;
      if (st.size > limit) {
        skipped.push({ source: src.id, path: rel, reason: 'too-large' });
        continue;
      }
      if (format === 'other' && !/^\./.test(e.name)) {
        // unknown formats are not read, only counted
        files.push({ source: src.id, path: rel, abs, size: st.size, mtimeMs: st.mtimeMs, ext, format, hash: '', restricted: false });
        continue;
      }
      if (format === 'other') continue;
      const prevKey = `${src.id}:${rel}`;
      const prev = opts.previous?.[prevKey];
      let hash: string;
      let restrictedBy: FileInfo['restrictedBy'];
      if (prev && prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < 1 && format !== 'markdown') {
        hash = prev.hash;
      } else {
        let buf: Buffer;
        try {
          buf = fs.readFileSync(abs);
        } catch {
          skipped.push({ source: src.id, path: rel, reason: 'unreadable' });
          continue;
        }
        if (format !== 'image' && format !== 'unsupported' && looksBinary(buf)) {
          skipped.push({ source: src.id, path: rel, reason: 'binary' });
          continue;
        }
        hash = sha256(buf);
        if (format === 'markdown' && RESTRICTED_FM.test(normalizeText(buf.subarray(0, 4096).toString('utf8')))) restrictedBy = 'marker';
      }
      if (matchAny(config.access.restricted, rel)) restrictedBy = 'policy';
      else if (!restrictedBy && (format === 'markdown' || format === 'html' || format === 'text') && RESTRICTED_SEGMENTS.test(rel)) restrictedBy = 'marker';
      files.push({ source: src.id, path: rel, abs, size: st.size, mtimeMs: st.mtimeMs, ext, format, hash, restricted: !!restrictedBy, restrictedBy });
    }
  };
  walk(src.root, '', []);
  return { files, skipped, ignoredDirs };
}

export function readSourceText(file: FileInfo): string {
  return normalizeText(fs.readFileSync(file.abs, 'utf8'));
}

/** Lightweight directory listing for context detection (no hashing, bounded depth). */
export function listTree(
  root: string,
  config: Config,
  opts: { maxDepth?: number; excludeAbs?: string[]; maxEntries?: number } = {},
): { files: string[]; dirs: string[]; gitDirs: string[]; obsidianDirs: string[]; generatedVaults: string[]; truncated: boolean } {
  const files: string[] = [];
  const dirs: string[] = [];
  const gitDirs: string[] = [];
  const obsidianDirs: string[] = [];
  const generatedVaults: string[] = [];
  const maxDepth = opts.maxDepth ?? 12;
  const maxEntries = opts.maxEntries ?? 300_000;
  const ignore = new Set(config.ignoreDirs.map((d) => d.toLowerCase()));
  ignore.delete('.git');
  const excludeAbs = (opts.excludeAbs ?? []).map((p) => path.resolve(p));
  const rootReal = fs.realpathSync.native(root);
  let truncated = false;
  const visited = new Set<string>();
  const walk = (abs: string, rel: string, depth: number, rules: IgnoreRule[]) => {
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let real: string;
    try {
      real = fs.realpathSync.native(abs);
    } catch {
      return;
    }
    if (visited.has(real) || !isInside(rootReal, real)) return;
    visited.add(real);
    let localRules = rules;
    const gi = path.join(abs, '.gitignore');
    if (config.useGitignore && fs.existsSync(gi)) {
      try {
        localRules = rules.concat(parseIgnoreFile(fs.readFileSync(gi, 'utf8'), rel));
      } catch {
        /* ignore */
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length + dirs.length > maxEntries) {
        truncated = true;
        return;
      }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.name === '.git') {
        gitDirs.push(rel || '.');
        continue;
      }
      if (e.name === '.obsidian' && e.isDirectory()) {
        obsidianDirs.push(rel || '.');
        continue;
      }
      if (e.name === '.vault-generator' && e.isDirectory()) {
        if (fs.existsSync(path.join(childAbs, 'manifest.json'))) generatedVaults.push(rel || '.');
        continue;
      }
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          const t = fs.realpathSync.native(childAbs);
          if (!isInside(rootReal, t)) continue;
          isDir = fs.statSync(childAbs).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (ignore.has(e.name.toLowerCase())) continue;
        if (excludeAbs.some((x) => isInside(x, childAbs))) continue;
        if (matchAny(config.access.deny, childRel) || ignoredByRules(localRules, childRel, true)) continue;
        if (fs.existsSync(path.join(childAbs, '.vault-generator', 'manifest.json'))) {
          generatedVaults.push(childRel); // generated output is recorded, never re-ingested
          continue;
        }
        dirs.push(childRel);
        walk(childAbs, childRel, depth + 1, localRules);
      } else {
        if (matchAny(config.access.deny, childRel) || isSensitiveFile(childRel) || ignoredByRules(localRules, childRel, false)) continue;
        files.push(childRel);
      }
    }
  };
  walk(root, '', 0, []);
  return {
    files: files.map(toPosix),
    dirs: dirs.map(toPosix),
    gitDirs: gitDirs.map(toPosix),
    // entries are the directories that *contain* `.obsidian` (the vault roots)
    obsidianDirs: obsidianDirs.map(toPosix),
    generatedVaults: generatedVaults.map(toPosix),
    truncated,
  };
}
