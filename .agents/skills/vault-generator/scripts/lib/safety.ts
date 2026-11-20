// Effective (not metadata-only) safety checks used by every reader/writer in the skill.
import fs from 'node:fs';
import path from 'node:path';
import { VgError, matchAny, toPosix } from './util.ts';

/** True when `target` is `root` or inside it (lexical check on absolute paths). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve symlinks of the deepest existing ancestor, so not-yet-created paths can still be checked. */
export function realpathLoose(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function realInside(root: string, target: string): boolean {
  return isInside(realpathLoose(root), realpathLoose(target));
}

/** Join untrusted relative segments below `root`; throws on traversal, absolute paths, drive letters, NULs. */
export function safeJoin(root: string, rel: string): string {
  if (rel.includes('\0')) throw new VgError('E_PATH', `NUL byte in path: ${JSON.stringify(rel)}`);
  const posix = toPosix(rel);
  if (/^([a-zA-Z]:|\/|\\\\)/.test(posix)) throw new VgError('E_PATH', `Absolute path not allowed: ${rel}`);
  if (posix.split('/').some((s) => s === '..')) throw new VgError('E_PATH', `Path traversal not allowed: ${rel}`);
  const abs = path.resolve(root, posix);
  if (!isInside(root, abs)) throw new VgError('E_PATH', `Path escapes root: ${rel}`);
  if (!realInside(root, abs)) throw new VgError('E_PATH', `Path resolves (via symlink) outside root: ${rel}`);
  return abs;
}

const FORBIDDEN_WRITE_SEGMENTS = new Set(['.git', 'node_modules']);
/** Gate for every write: must be inside one of `allowedRoots`, never inside .git/node_modules. */
export function assertWritable(target: string, allowedRoots: string[]): string {
  const abs = path.resolve(target);
  const ok = allowedRoots.some((r) => isInside(r, abs) && realInside(r, abs));
  if (!ok) throw new VgError('E_WRITE_DENIED', `Refusing to write outside authorized output roots: ${abs}`);
  const seg = toPosix(abs).split('/');
  if (seg.some((s) => FORBIDDEN_WRITE_SEGMENTS.has(s))) throw new VgError('E_WRITE_DENIED', `Refusing to write inside ${abs}`);
  return abs;
}

/** Sensitive files are never read, indexed or exported. */
export const SENSITIVE_GLOBS = [
  '.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx', '*.ppk', '*.gpg', '*.asc',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.htpasswd',
  '**/.aws/credentials', '**/.ssh/**', '**/.docker/config.json', 'credentials.json', 'service-account*.json', '*.tfstate', '*.tfstate.*',
  '*.tfvars', 'secrets.*', '*.secret', '*.secrets', 'kubeconfig', '**/.kube/config',
];
/** Non-secret env templates are fine to read. */
const SENSITIVE_EXCEPTIONS = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env', 'sample.env'];

export function isSensitiveFile(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  if (SENSITIVE_EXCEPTIONS.includes(base.toLowerCase())) return false;
  return matchAny(SENSITIVE_GLOBS, rel);
}

const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g },
  { kind: 'anthropic-or-openai-key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]{3,}@/gi },
  {
    // the key must END with a secret-like word (so "authority:" or "tokenizer:" do not match)
    kind: 'assigned-secret',
    re: /\b((?:[A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer)(?:[_-]?(?:value|hash))?)["']?\s*[:=]\s*)(["'`]?)([^\s"'`,;{}()<>$[][^\s"'`,;]{7,})\2/gi,
  },
];
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|<[^>]+>|\$\{?[A-Za-z_]+\}?|\{\{.*\}\}|\[REDACTED|your[_-]|changeme|example|placeholder|redacted|null|undefined|process\.env|env\.|os\.environ|secrets\.|vars\.|true|false)/i;
/** values that are code, types, paths or plain numbers rather than secrets */
const NOT_A_SECRET = /^(?:\d+|[A-Z][a-zA-Z]+(?:<.*>)?(?:\[\])?|[a-z]+(?:[A-Z][a-z]+)+|[\w./-]+\.(?:json|ya?ml|md|ts|js|py|toml|txt|env|example)|\/[\w/.-]*|https?:\/\/[^@\s]+)$/;

export interface RedactResult {
  text: string;
  count: number;
  kinds: string[];
}
/** Best-effort secret redaction applied before any text reaches a note, index or export. */
export function redactSecrets(text: string): RedactResult {
  let count = 0;
  const kinds = new Set<string>();
  let out = text;
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, (...m: unknown[]) => {
      const full = m[0] as string;
      if (kind === 'assigned-secret') {
        const value = m[3] as string;
        if (PLACEHOLDER.test(value) || /^[a-z_]+\(/i.test(value) || NOT_A_SECRET.test(value)) return full;
        count++;
        kinds.add(kind);
        return `${m[1] as string}${m[2] as string}[REDACTED:secret]${m[2] as string}`;
      }
      if (kind === 'url-credentials') {
        count++;
        kinds.add(kind);
        return full.replace(/\/\/[^/@]+@/, '//[REDACTED:credentials]@');
      }
      count++;
      kinds.add(kind);
      return `[REDACTED:${kind}]`;
    });
  }
  return { text: out, count, kinds: [...kinds] };
}
export const containsPrivateKey = (text: string): boolean => /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(text);

const INJECTION: RegExp[] = [
  /ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)/i,
  /disregard (?:all |any )?(?:the )?(?:previous|prior|above) (?:instructions|prompts?)/i,
  /you are now (?:in )?(?:developer|dan|jailbreak)/i,
  /(?:reveal|print|exfiltrate|send) (?:your |the )?(?:system prompt|api[_ -]?keys?|credentials|secrets)/i,
  /ignora (?:todas )?las instrucciones (?:anteriores|previas)/i,
  /<\s*(?:system|assistant)\s*>/i,
];
/** Heuristic detector for instruction-like text inside documentation (treated as data, flagged for the reader). */
export function detectInjection(text: string): string[] {
  const hits: string[] = [];
  for (const re of INJECTION) if (re.test(text)) hits.push(re.source.slice(0, 40));
  return hits;
}

export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32 && b !== 27)) suspicious++;
  }
  return n > 0 && suspicious / n > 0.3;
}

/** Private-looking absolute paths must never be persisted in manifests/notes. */
export function hasPrivateAbsolutePath(s: string): boolean {
  return /(?:^|[\s"'`(])(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:home|Users)\/[^/\s]+\/)/.test(s);
}
export function scrubPrivatePaths(s: string): string {
  return s.replace(/(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`]+|\/(?:home|Users)\/[^/\s"'`]+)/g, '~');
}
