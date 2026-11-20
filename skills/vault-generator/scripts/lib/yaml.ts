import YAML from '../vendor/yaml.mjs';
import { parse as tomlParse } from '../vendor/smol-toml.mjs';

export interface Parsed<T = unknown> {
  value?: T;
  error?: string;
}
export function parseYaml(text: string): Parsed {
  try {
    return { value: YAML.parse(text, { maxAliasCount: 200, strict: false, uniqueKeys: false }) };
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0] };
  }
}
/** Multi-document YAML (k8s manifests, compose overrides). */
export function parseYamlAll(text: string): Parsed<unknown[]> {
  try {
    const docs = YAML.parseAllDocuments(text, { maxAliasCount: 200, uniqueKeys: false });
    const list = Array.isArray(docs) ? docs : [docs];
    const out: unknown[] = [];
    for (const d of list) {
      if (d.errors?.length) return { error: String(d.errors[0].message).split('\n')[0] };
      const js = d.toJS({ maxAliasCount: 200 });
      if (js !== null && js !== undefined) out.push(js);
    }
    return { value: out };
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0] };
  }
}
export function stringifyYaml(v: unknown): string {
  return YAML.stringify(v, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
}
export function parseToml(text: string): Parsed<Record<string, any>> {
  try {
    return { value: tomlParse(text) };
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0] };
  }
}
export function parseJson(text: string): Parsed {
  try {
    return { value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (e) {
    // tolerate JSON-with-comments / trailing commas (tsconfig, devcontainer ...)
    try {
      const stripped = stripJsonComments(text).replace(/,\s*([}\]])/g, '$1');
      return { value: JSON.parse(stripped) };
    } catch {
      return { error: (e as Error).message.split('\n')[0] };
    }
  }
}
export function stripJsonComments(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out;
}
