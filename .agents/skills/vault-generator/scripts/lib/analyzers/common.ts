import type { AnalysisResult, Entity, Fact, FileInfo, Relation, SourceRef } from '../types.ts';
import { posixBase } from '../util.ts';

export const emptyResult = (): AnalysisResult => ({ documents: [], entities: [], relations: [], facts: [], limitations: [], warnings: [] });

export const refOf = (f: FileInfo, lines?: [number, number]): SourceRef => ({ source: f.source, path: f.path, hash: f.hash ? f.hash.slice(0, 16) : undefined, ...(lines ? { lines } : {}) });

export function entity(e: Omit<Entity, 'attrs' | 'refs' | 'confidence'> & Partial<Pick<Entity, 'attrs' | 'refs' | 'confidence'>>): Entity {
  return { attrs: {}, refs: [], confidence: 'verified', ...e };
}
export function rel(type: string, from: string, to: string, status: Relation['status'], ref: SourceRef, note?: string): Relation {
  return { type, from, to, status, evidence: [{ ref, note }] };
}

const RUNTIME_RE = /\b(node(?:\.?js)?|python|java|go(?:lang)?|ruby|php|\.net|dotnet|deno|bun|rust)\s*(?:version\s*)?(?:v(?=\d))?(>=|=>|>|\^|~|=)?\s*(\d+(?:\.\d+){0,2})(\+|\.x)?/gi;
const RT_NAMES: Record<string, string> = { node: 'node', nodejs: 'node', 'node.js': 'node', python: 'python', java: 'java', go: 'go', golang: 'go', ruby: 'ruby', php: 'php', '.net': 'dotnet', dotnet: 'dotnet', deno: 'deno', bun: 'bun', rust: 'rust' };
const PORT_RE = /\b(?:port|puerto)\s*(?:[:=]|is|es|on|en)?\s*(\d{2,5})\b|\blocalhost:(\d{2,5})\b|\b(?:127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi;

/** Extract verifiable claims (runtime versions, ports, npm/yarn/pnpm commands) from prose and code blocks. */
export function extractFacts(text: string, ref: SourceRef, authority: string): Fact[] {
  const facts: Fact[] = [];
  const lines = text.split('\n');
  let inCode = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      return;
    }
    const lr: SourceRef = { ...ref, lines: [i + 1, i + 1] };
    if (!inCode) {
      RUNTIME_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RUNTIME_RE.exec(line))) {
        const rt = RT_NAMES[m[1].toLowerCase().replace(/\s+/g, '')];
        // require a version-ish context to avoid "go 2 places" style false positives
        if (!rt || (rt === 'go' && !/\bgo\s*(?:version\s*)?\d+\.\d+/i.test(m[0]))) continue;
        const v = m[3];
        if (rt === 'java' && +v.split('.')[0] < 5) continue;
        facts.push({ subject: `runtime:${rt}`, value: `${m[2] ?? ''}${v}${m[4] ?? ''}`, ref: lr, authority, text: line.trim().slice(0, 200) });
      }
      PORT_RE.lastIndex = 0;
      while ((m = PORT_RE.exec(line))) {
        const port = m[1] ?? m[2] ?? m[3];
        if (+port >= 80 && +port <= 65535) facts.push({ subject: 'port', value: port, ref: lr, authority, text: line.trim().slice(0, 200) });
      }
    }
    const cmd = /\b(npm run|yarn|pnpm(?: run)?|bun run)\s+([a-z0-9][\w:.-]*)/i.exec(line);
    if (cmd && (inCode || /`/.test(line))) {
      const script = cmd[2];
      if (!['install', 'add', 'remove', 'i', 'ci', 'init', 'create', 'dlx', 'exec', 'x', 'up', 'upgrade', 'link', 'publish', 'why', 'audit', 'outdated', 'global', 'workspace', 'workspaces', 'config', 'set', 'version', 'pack', 'list', 'ls', 'info', 'cache', 'login', 'logout', 'run', 'test'].includes(script.toLowerCase()) || cmd[1].toLowerCase().includes('run')) {
        if (script.toLowerCase() !== 'test' || cmd[1].toLowerCase().includes('run')) facts.push({ subject: `script:${script}`, value: 'documented', ref: lr, authority, text: line.trim().slice(0, 200) });
      }
    }
  });
  return facts;
}

export const isReadme = (p: string): boolean => /^readme(\.[a-z]+)?$/i.test(posixBase(p));
export const docAuthority = (p: string): string => (isReadme(p) ? 'readme' : 'doc');

const VERSION_SEG = /^(?:v|version-)?(\d+(?:\.\d+){0,2}(?:\.x)?)$/i;
export function versionFromPath(p: string): string | undefined {
  for (const seg of p.split('/').slice(0, -1)) {
    const m = VERSION_SEG.exec(seg);
    if (m) return m[1].startsWith('v') ? m[1] : `v${m[1]}`;
  }
  return undefined;
}
