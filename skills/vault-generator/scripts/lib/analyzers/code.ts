// Static, dependency-free code analysis. It extracts the *public surface* (exported symbols,
// signatures, doc comments, decorators, HTTP routes) and imports. It does not type-check or
// execute code, and it never claims behaviour that is not visible in declarations.
import type { Analyzer, AnalysisResult, CodeFileInfo, CodeSymbol, FileInfo } from '../types.ts';
import { codeLanguage } from '../scan.ts';
import { redactSecrets } from '../safety.ts';
import { oneLine, sha256, stableStringify, truncate } from '../util.ts';
import { emptyResult, entity, refOf } from './common.ts';

/** Replace comments and string contents with spaces (newlines kept) so braces/keywords can be scanned safely. */
export function maskCode(src: string, lang: 'c' | 'python' | 'ruby' | 'shell'): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (lang === 'c' && c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      blank(i, e < 0 ? n : e);
      i = e < 0 ? n : e;
    } else if (lang === 'c' && c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      blank(i, e < 0 ? n : e + 2);
      i = e < 0 ? n : e + 2;
    } else if ((lang !== 'c') && c === '#') {
      const e = src.indexOf('\n', i);
      blank(i, e < 0 ? n : e);
      i = e < 0 ? n : e;
    } else if (lang === 'python' && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const q = src.slice(i, i + 3);
      const e = src.indexOf(q, i + 3);
      blank(i + 3, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
    } else if (c === '"' || c === "'" || (c === '`' && lang === 'c')) {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return masked.length - 1;
}
const lineAt = (src: string, idx: number) => {
  let l = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src.charCodeAt(i) === 10) l++;
  return l;
};
function lineIndex(src: string): (idx: number) => number {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (idx: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** JSDoc / block / line doc comment immediately preceding `idx` in the original source. */
function docBefore(src: string, idx: number, style: 'jsdoc' | 'slashes' | 'rustdoc' | 'xmldoc'): string | undefined {
  let j = idx - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  // skip decorators / annotations lines immediately above
  for (;;) {
    const lineStart = src.lastIndexOf('\n', j) + 1;
    const line = src.slice(lineStart, j + 1).trim();
    if (/^@[\w.]+(\(.*\))?$/.test(line) || /^\[[\w.]+(\(.*\))?\]$/.test(line) || /^#\[[^\]]+\]$/.test(line)) {
      j = lineStart - 2;
      while (j >= 0 && /\s/.test(src[j])) j--;
    } else break;
  }
  if (style === 'jsdoc' && src.slice(j - 1, j + 1) === '*/') {
    const start = src.lastIndexOf('/**', j);
    if (start < 0 || src.slice(start, j).includes('*/')) return undefined;
    return cleanJsDoc(src.slice(start + 3, j - 1));
  }
  const prefix = style === 'rustdoc' ? '///' : style === 'xmldoc' ? '///' : '//';
  const lines: string[] = [];
  let end = j;
  for (;;) {
    const lineStart = src.lastIndexOf('\n', end) + 1;
    const line = src.slice(lineStart, end + 1).trim();
    if (!line.startsWith(prefix) || (style === 'slashes' && line.startsWith('///'))) break;
    lines.unshift(line.slice(prefix.length).trim());
    if (lineStart === 0) break;
    end = lineStart - 2;
  }
  if (!lines.length) return undefined;
  const txt = lines.join('\n');
  return style === 'xmldoc' ? txt.replace(/<\/?(summary|remarks|returns|param[^>]*|see[^>]*)>/g, '').trim() : txt;
}
function cleanJsDoc(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}
function docSummary(d?: string): string | undefined {
  if (!d) return undefined;
  const firstPara = d.split(/\n\s*\n/)[0].split('\n').filter((l) => !l.trim().startsWith('@')).join(' ');
  return truncate(oneLine(firstPara), 300) || undefined;
}
/** Tags from JSDoc useful for knowledge (deprecated, since, example). */
function docTags(d?: string): Record<string, unknown> {
  if (!d) return {};
  const tags: Record<string, unknown> = {};
  if (/@deprecated\b/.test(d)) tags.deprecated = oneLine(/@deprecated\b([^@]*)/.exec(d)?.[1] ?? '') || true;
  const since = /@since\s+(\S+)/.exec(d)?.[1];
  if (since) tags.since = since;
  const ex = /@example\b([\s\S]*?)(?=\n\s*@\w|$)/.exec(d)?.[1]?.trim();
  if (ex) tags.example = ex.replace(/^```\w*\n?|```$/g, '').trim();
  return tags;
}

function sigUntil(src: string, masked: string, from: number, stops: string): string {
  let depth = 0;
  let i = from;
  for (; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '<' || c === '[') depth++;
    else if (c === ')' || c === '>' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && stops.includes(c)) break;
    if (c === '=' && masked[i + 1] === '>' && depth === 0 && stops.includes('=')) break;
  }
  return oneLine(src.slice(from, i)).replace(/\s*[{;=]\s*$/, '');
}

// ───────────────────────── TypeScript / JavaScript ─────────────────────────
const TS_DECL = /(^|\n)([ \t]*)((?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?)(function\s*\*?|class|interface|type|enum|const\s+enum|const|let|var|namespace|module)\s+([A-Za-z_$][\w$]*)/g;
function analyzeTs(src: string, file: FileInfo): CodeFileInfo {
  const masked = maskCode(src, 'c');
  const li = lineIndex(src);
  const symbols: CodeSymbol[] = [];
  const imports: CodeFileInfo['imports'] = [];
  const exportedNames = new Set<string>();
  // export { a, b as c } / export * from
  for (const m of masked.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) {
    const nm = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
    if (nm) exportedNames.add(nm);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:([\w$*{},\s]+?)\s+from\s+)?["']([^"']+)["']/g)) {
    const names = (m[1] ?? '').replace(/[{}]/g, ' ').split(/[\s,]+/).filter((x) => x && x !== 'as' && x !== '*' && x !== 'type');
    imports.push({ spec: m[2], names, line: li(m.index! + m[0].indexOf(m[2])) });
  }
  for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)/g)) imports.push({ spec: m[1] ?? m[2], names: [], line: li(m.index!) });
  const isTop = (indent: string) => indent.length === 0;
  TS_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  const cjsExports = new Set<string>();
  for (const e of masked.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) e[1].split(',').forEach((p) => cjsExports.add(p.split(':')[0].trim()));
  for (const e of masked.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) cjsExports.add(e[1]);
  while ((m = TS_DECL.exec(masked))) {
    const indent = m[2];
    if (!isTop(indent)) continue;
    const start = m.index + m[1].length + indent.length;
    const mods = m[3];
    const kw = m[4].replace(/\s+/g, ' ').replace(/\*$/, '').trim();
    const name = m[5];
    const exported = /export/.test(mods) || exportedNames.has(name) || cjsExports.has(name);
    const isDefault = /default/.test(mods);
    const doc = docBefore(src, start, 'jsdoc');
    const decorators = decoratorsBefore(src, start);
    const line = li(start);
    const afterName = m.index + m[0].length;
    let kind = kw === 'function' ? 'function' : kw === 'const enum' ? 'enum' : kw === 'let' || kw === 'var' ? 'variable' : kw === 'module' ? 'namespace' : kw;
    let signature: string;
    const sym: CodeSymbol = { name, kind, signature: '', line, exported, doc: docSummary(doc), decorators: decorators.length ? decorators : undefined, attrs: { ...docTags(doc), ...(isDefault ? { default: true } : {}) } };
    if (kind === 'class' || kind === 'interface' || kind === 'enum' || kind === 'namespace') {
      const brace = masked.indexOf('{', afterName);
      const head = oneLine(src.slice(start, brace < 0 ? afterName : brace));
      signature = head.replace(/^export\s+(default\s+)?/, '');
      if (brace > 0 && kind !== 'namespace') {
        const end = matchBrace(masked, brace);
        sym.members = tsMembers(src, masked, brace + 1, end, kind, li);
        TS_DECL.lastIndex = end;
      }
      if (kind === 'class') {
        const ext = /\bextends\s+([\w$.]+)/.exec(head)?.[1];
        const impl = /\bimplements\s+([\w$.,\s<>]+)/.exec(head)?.[1];
        if (ext) sym.attrs!.extends = ext;
        if (impl) sym.attrs!.implements = impl.split(',').map((s) => s.trim().replace(/<.*$/, ''));
      }
    } else if (kind === 'function') {
      signature = sigUntil(src, masked, start, '{;').replace(/^export\s+(default\s+)?/, '');
    } else if (kind === 'type') {
      signature = truncate(sigUntil(src, masked, start, ';\n').replace(/^export\s+/, ''), 300);
    } else {
      // const/let/var: detect arrow functions and components
      const rest = masked.slice(afterName, afterName + 400);
      const arrow = /^\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/.exec(rest);
      const fnExpr = /^\s*(?::\s*[^=]+)?=\s*(?:async\s+)?function\b/.exec(rest);
      if (arrow || fnExpr) {
        kind = 'function';
        sym.kind = 'function';
        const eq = src.indexOf('=', afterName);
        const arrowIdx = arrow ? masked.indexOf('=>', eq + 1) : masked.indexOf('{', eq);
        signature = oneLine(`${kw} ${name}${src.slice(afterName, eq)} = ${src.slice(eq + 1, arrowIdx).trim()}${arrow ? ' => …' : ' {…}'}`);
      } else {
        const typeAnn = /^\s*:\s*([^=;\n]+)/.exec(src.slice(afterName, afterName + 200))?.[1]?.trim();
        const init = /^\s*(?::[^=;\n]+)?=\s*([^;\n]{0,80})/.exec(src.slice(afterName, afterName + 200))?.[1]?.trim();
        signature = `${kw} ${name}${typeAnn ? `: ${typeAnn}` : ''}${!typeAnn && init ? ` = ${truncate(init, 60)}` : ''}`;
      }
    }
    sym.signature = truncate(signature, 400);
    if (/^[A-Z]/.test(name) && sym.kind === 'function' && /\.(tsx|jsx)$/.test(file.path)) sym.kind = 'component';
    symbols.push(sym);
  }
  // framework semantics from decorators
  for (const s of symbols) {
    const dec = (s.decorators ?? []).join(' ');
    const ng = /@(Component|Directive|Pipe|Injectable|NgModule)\b/.exec(dec);
    if (ng) {
      s.attrs!.role = ng[1].toLowerCase();
      const sel = /selector\s*:\s*["'`]([^"'`]+)/.exec(src.slice(Math.max(0, src.lastIndexOf('@', src.indexOf(`class ${s.name}`))), src.indexOf(`class ${s.name}`)))?.[1];
      if (sel) s.attrs!.selector = sel;
      if (ng[1] === 'Component') s.kind = 'component';
    }
    const ctrl = /@Controller\(\s*["'`]?([^"'`)]*)/.exec(dec);
    if (ctrl) {
      s.attrs!.role = 'controller';
      const base = ctrl[1];
      for (const mem of s.members ?? []) {
        const r = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\(\s*["'`]?([^"'`)]*)/.exec((mem.decorators ?? []).join(' '));
        if (r) {
          mem.kind = 'route';
          mem.attrs = { ...(mem.attrs ?? {}), method: r[1].toUpperCase(), path: `/${[base, r[2]].filter(Boolean).join('/')}`.replace(/\/+/g, '/') };
        }
      }
    }
  }
  // express/fastify/hono style routes
  for (const r of masked.matchAll(/\b(app|router|server|api|fastify|route[rs]?)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*/g)) {
    const at = r.index! + r[0].length;
    const lit = /^["'`]([^"'`]+)["'`]/.exec(src.slice(at, at + 200));
    if (!lit) continue;
    symbols.push({ name: `${r[2].toUpperCase()} ${lit[1]}`, kind: 'route', signature: oneLine(src.slice(r.index!, at + lit[0].length)) + ', …)', line: li(r.index!), exported: true, attrs: { method: r[2].toUpperCase(), path: lit[1], framework: r[1] } });
  }
  const moduleDoc = /^\s*\/\*\*([\s\S]*?)\*\//.exec(src)?.[1];
  return { file: refOf(file), language: codeLanguage(file.ext) ?? 'javascript', imports, symbols, moduleDoc: moduleDoc ? docSummary(cleanJsDoc(moduleDoc)) : undefined, lines: src.split('\n').length };
}
function decoratorsBefore(src: string, idx: number): string[] {
  const out: string[] = [];
  let j = idx;
  for (let k = 0; k < 6; k++) {
    const prevEnd = src.lastIndexOf('\n', j - 1);
    if (prevEnd < 0) break;
    // accumulate a decorator that may span several lines (object literal argument)
    const chunk = src.slice(Math.max(0, prevEnd - 2000), j);
    const dm = /@([A-Z][\w.]*)\s*(\((?:[^()]|\([^()]*\))*\))?\s*$/.exec(chunk);
    if (!dm) break;
    out.unshift(`@${dm[1]}${dm[2] ? oneLine(dm[2]).slice(0, 200) : ''}`);
    j = Math.max(0, prevEnd - 2000) + dm.index;
  }
  return out;
}
function tsMembers(src: string, masked: string, from: number, to: number, kind: string, li: (i: number) => number): CodeSymbol[] {
  const members: CodeSymbol[] = [];
  let depth = 0;
  let segStart = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') {
      if (c === '{' && depth === 0) {
        pushMember(segStart, i);
        const end = matchBrace(masked, i);
        i = end;
        segStart = end + 1;
        continue;
      }
      depth++;
    } else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ';' || c === ',' && kind === 'enum' || (c === '\n' && kind !== 'class' && /\S/.test(masked.slice(segStart, i)) && !/[,(|&:=]\s*$/.test(masked.slice(segStart, i))))) {
      pushMember(segStart, i);
      segStart = i + 1;
    }
  }
  pushMember(segStart, to);
  return members.slice(0, 80);
  function pushMember(a: number, b: number) {
    const raw = src.slice(a, b);
    const decorators = [...raw.matchAll(/@([A-Z][\w.]*)\s*(\((?:[^()]|\([^()]*\))*\))?/g)].map((d) => `@${d[1]}${d[2] ? oneLine(d[2]).slice(0, 160) : ''}`);
    const textOnly = oneLine(maskCode(raw, 'c').replace(/@[A-Z][\w.]*\s*(\((?:[^()]|\([^()]*\))*\))?/g, ''));
    if (!textOnly || textOnly === ',' ) return;
    const sig = oneLine(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/@[A-Z][\w.]*\s*(\((?:[^()]|\([^()]*\))*\))?/g, '')).replace(/[;,]$/, '').trim();
    if (!sig) return;
    if (/^(private|#)/.test(sig) || /^protected\b/.test(sig) && kind === 'class') return;
    const nm = /^(?:(?:public|static|readonly|abstract|async|override|declare|get|set|accessor)\s+)*\*?\s*\[?([A-Za-z_$][\w$]*|constructor)\]?\??/.exec(sig)?.[1];
    if (!nm) return;
    if (kind === 'class' && /^_/.test(nm)) return;
    const startIdx = a + raw.search(/\S/);
    const doc = docBefore(src, a + raw.indexOf(raw.trimStart().replace(/^\/\*\*[\s\S]*?\*\/\s*/, '').slice(0, 10)), 'jsdoc');
    const mk = kind === 'enum' ? 'enum-member' : /\(/.test(sig.split(':')[0].split('=')[0]) || nm === 'constructor' ? 'method' : 'property';
    const inputOutput = decorators.find((d) => /^@(Input|Output|Prop|Emit|HostListener)\b/.test(d));
    members.push({ name: nm, kind: inputOutput ? inputOutput.slice(1).split('(')[0].toLowerCase() : mk, signature: truncate(sig.replace(/\s*\{$/, ''), 300), line: li(startIdx), exported: true, doc: docSummary(doc), decorators: decorators.length ? decorators : undefined });
  }
}

// ───────────────────────── Python ─────────────────────────
function analyzePython(src: string, file: FileInfo): CodeFileInfo {
  const masked = maskCode(src, 'python');
  const li = lineIndex(src);
  const lines = src.split('\n');
  const mlines = masked.split('\n');
  const symbols: CodeSymbol[] = [];
  const imports: CodeFileInfo['imports'] = [];
  const allMatch = /^__all__\s*=\s*[[(]([^\])]*)[\])]/m.exec(src);
  const all = allMatch ? new Set([...allMatch[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1])) : undefined;
  const docstring = (lineIdx: number): string | undefined => {
    for (let k = lineIdx; k < Math.min(lines.length, lineIdx + 3); k++) {
      const t = lines[k].trim();
      if (!t) continue;
      const q = /^[rubf]*("""|''')/i.exec(t);
      if (!q) return undefined;
      const rest = lines.slice(k).join('\n');
      const start = rest.indexOf(q[1]) + 3;
      const end = rest.indexOf(q[1], start);
      return end > 0 ? rest.slice(start, end).trim() : undefined;
    }
    return undefined;
  };
  let currentClass: CodeSymbol | undefined;
  for (let i = 0; i < mlines.length; i++) {
    const ml = mlines[i];
    const im = /^(?:from\s+([.\w]+)\s+import\s+(.+)|import\s+(.+))$/.exec(ml.trim());
    if (im && !/^\s/.test(ml)) {
      if (im[1]) imports.push({ spec: im[1], names: im[2].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean), line: i + 1 });
      else for (const s of im[3].split(',')) imports.push({ spec: s.trim().split(/\s+as\s+/)[0], names: [], line: i + 1 });
    }
    const dm = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(ml);
    if (!dm) continue;
    const indent = dm[1].length;
    if (indent === 0) currentClass = undefined;
    if (indent > 0 && !(currentClass && indent <= 8)) continue;
    // full signature until ':' at depth 0
    let sig = '';
    let depth = 0;
    let j = i;
    outer: for (; j < Math.min(lines.length, i + 30); j++) {
      const l = lines[j];
      const mm = mlines[j];
      for (let k = j === i ? dm[1].length : 0; k < mm.length; k++) {
        const c = mm[k];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ':' && depth === 0) {
          sig += l.slice(j === i ? dm[1].length : 0, k);
          break outer;
        }
      }
      sig += `${l.slice(j === i ? dm[1].length : 0)} `;
    }
    const decorators: string[] = [];
    for (let k = i - 1; k >= 0 && /^\s*@/.test(lines[k]); k--) decorators.unshift(lines[k].trim());
    const name = dm[3];
    const doc = docstring(j + 1);
    const isClass = dm[2] === 'class';
    const sym: CodeSymbol = { name, kind: isClass ? 'class' : indent ? 'method' : 'function', signature: truncate(oneLine(sig), 400), line: i + 1, exported: indent === 0 ? (all ? all.has(name) : !name.startsWith('_')) : !name.startsWith('_') || name === '__init__', doc: docSummary(doc), decorators: decorators.length ? decorators : undefined, attrs: {} };
    const route = decorators.map((d) => /^@(?:\w+)\.(get|post|put|patch|delete|route|api_route)\(\s*["']([^"']+)["'](?:.*methods\s*=\s*\[([^\]]+)\])?/.exec(d)).find(Boolean);
    if (route) {
      sym.kind = 'route';
      sym.attrs!.method = route[1] === 'route' || route[1] === 'api_route' ? (route[3] ? route[3].replace(/["'\s]/g, '').toUpperCase() : 'GET') : route[1].toUpperCase();
      sym.attrs!.path = route[2];
    }
    if (/deprecated/i.test(decorators.join(' ')) || /\.\.\s*deprecated::/.test(doc ?? '')) sym.attrs!.deprecated = true;
    if (indent === 0) {
      symbols.push(sym);
      currentClass = isClass ? sym : undefined;
      if (isClass) {
        const base = /\(([^)]*)\)/.exec(sig)?.[1];
        if (base) sym.attrs!.extends = base.split(',').map((s) => s.trim()).filter(Boolean)[0];
        sym.members = [];
      }
    } else if (currentClass && sym.exported) currentClass.members!.push(sym);
  }
  // Django urls.py
  for (const m of src.matchAll(/\b(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/g)) symbols.push({ name: `URL ${m[1] || '/'}`, kind: 'route', signature: oneLine(m[0]), line: lineAt(src, m.index!), exported: true, attrs: { method: 'ANY', path: `/${m[1]}`, handler: m[2] } });
  const moduleDoc = docstring(0);
  return { file: refOf(file), language: 'python', imports, symbols, moduleDoc: docSummary(moduleDoc), lines: lines.length };
}

// ───────────────────────── Go ─────────────────────────
function analyzeGo(src: string, file: FileInfo): CodeFileInfo {
  const masked = maskCode(src, 'c');
  const li = lineIndex(src);
  const symbols: CodeSymbol[] = [];
  const imports: CodeFileInfo['imports'] = [];
  const block = /^import\s*\(([\s\S]*?)\)/m.exec(src);
  if (block) for (const m of block[1].matchAll(/(?:(\w+)\s+)?"([^"]+)"/g)) imports.push({ spec: m[2], names: m[1] ? [m[1]] : [], line: li(block.index + m.index!) });
  for (const m of src.matchAll(/^import\s+(?:(\w+)\s+)?"([^"]+)"/gm)) imports.push({ spec: m[2], names: m[1] ? [m[1]] : [], line: li(m.index!) });
  for (const m of masked.matchAll(/^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)/gm)) {
    const name = m[2];
    const recv = m[1] ? /\*?\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\)/.exec(m[1])?.[1] : undefined;
    const doc = docBefore(src, m.index!, 'slashes');
    symbols.push({ name, kind: recv ? 'method' : 'function', signature: truncate(sigUntil(src, masked, m.index!, '{\n'), 400), line: li(m.index!), exported: /^[A-Z]/.test(name), parent: recv, doc: docSummary(doc), attrs: /Deprecated:/.test(doc ?? '') ? { deprecated: true } : {} });
  }
  for (const m of masked.matchAll(/^type\s+([A-Za-z_]\w*)(\[[^\]]*\])?\s+(struct|interface|func|[\w.*[\]]+)/gm)) {
    const doc = docBefore(src, m.index!, 'slashes');
    const sym: CodeSymbol = { name: m[1], kind: m[3] === 'struct' ? 'struct' : m[3] === 'interface' ? 'interface' : 'type', signature: oneLine(src.slice(m.index!, m.index! + m[0].length)), line: li(m.index!), exported: /^[A-Z]/.test(m[1]), doc: docSummary(doc), attrs: {} };
    const brace = masked.indexOf('{', m.index! + m[0].length - 1);
    if ((m[3] === 'struct' || m[3] === 'interface') && brace > 0 && brace - (m.index! + m[0].length) < 3) {
      const end = matchBrace(masked, brace);
      sym.members = src
        .slice(brace + 1, end)
        .split('\n')
        .map((l, k) => ({ l: l.trim(), k }))
        .filter(({ l }) => /^[A-Z]\w*/.test(l))
        .map(({ l, k }) => ({ name: /^(\w+)/.exec(l)![1], kind: m[3] === 'struct' ? 'field' : 'method', signature: oneLine(l.replace(/\/\/.*$/, '')), line: li(brace) + k, exported: true }));
    }
    symbols.push(sym);
  }
  for (const m of masked.matchAll(/^(const|var)\s+([A-Z]\w*)\b/gm)) symbols.push({ name: m[2], kind: m[1] === 'const' ? 'const' : 'variable', signature: oneLine(src.slice(m.index!, src.indexOf('\n', m.index!))), line: li(m.index!), exported: true, doc: docSummary(docBefore(src, m.index!, 'slashes')) });
  for (const m of src.matchAll(/\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"([^"]+)"/g)) symbols.push({ name: `${m[1].toUpperCase().replace('HANDLEFUNC', 'ANY').replace('HANDLE', 'ANY')} ${m[2]}`, kind: 'route', signature: oneLine(m[0]), line: li(m.index!), exported: true, attrs: { method: m[1].toUpperCase().replace(/^HANDLE(FUNC)?$/, 'ANY'), path: m[2].replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/, '') } });
  const pkg = /^package\s+(\w+)/m.exec(src)?.[1];
  const moduleDoc = docBefore(src, /^package\s/m.exec(src)?.index ?? 0, 'slashes');
  // attach methods to their receiver types for readability
  for (const s of symbols.filter((x) => x.kind === 'method' && x.parent)) {
    const owner = symbols.find((t) => t.name === s.parent && t.kind !== 'method');
    if (owner && s.exported) (owner.members ??= []).push({ ...s });
  }
  return { file: refOf(file), language: 'go', imports, symbols: symbols.filter((s) => !(s.kind === 'method' && symbols.some((t) => t.name === s.parent && t.kind !== 'method'))), moduleDoc: docSummary(moduleDoc) ?? (pkg ? `package ${pkg}` : undefined), lines: src.split('\n').length };
}

// ───────────────────────── JVM / C# / Rust / others (declaration-level) ─────────────────────────
function analyzeCLike(src: string, file: FileInfo, lang: string): CodeFileInfo {
  const masked = maskCode(src, 'c');
  const li = lineIndex(src);
  const symbols: CodeSymbol[] = [];
  const imports: CodeFileInfo['imports'] = [];
  const docStyle = lang === 'rust' ? 'rustdoc' : lang === 'csharp' ? 'xmldoc' : 'jsdoc';
  const impRe = lang === 'rust' ? /^\s*(?:pub\s+)?use\s+([^;]+);/gm : lang === 'csharp' ? /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm : lang === 'php' ? /^\s*use\s+([\w\\]+)/gm : lang === 'swift' || lang === 'kotlin' || lang === 'java' || lang === 'scala' || lang === 'groovy' || lang === 'dart' ? /^\s*import\s+(?:static\s+)?["']?([\w.:/]+)/gm : /^\s*#include\s+[<"]([^>"]+)[>"]/gm;
  for (const m of src.matchAll(impRe)) imports.push({ spec: m[1].trim(), names: [], line: li(m.index!) });
  const typeRe =
    lang === 'rust'
      ? /^[ \t]*pub(?:\([^)]*\))?\s+(?:async\s+|const\s+|unsafe\s+)*(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/gm
      : lang === 'kotlin'
        ? /^[ \t]*(?:@\w+(?:\([^)]*\))?\s+)*((?:public|internal|open|data|sealed|abstract|enum|annotation|inline|value|suspend|override)\s+)*(class|interface|object|fun|typealias)\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)/gm
        : lang === 'swift'
          ? /^[ \t]*(?:@\w+\s+)*(?:public|open)\s+(?:final\s+)?(class|struct|enum|protocol|func|actor|extension|typealias)\s+([A-Za-z_]\w*)/gm
          : lang === 'php'
            ? /^[ \t]*(?:final\s+|abstract\s+)?(class|interface|trait|enum|function)\s+([A-Za-z_]\w*)/gm
            : /^[ \t]*(?:\[[^\]]+\]\s*)*(?:@\w+(?:\([^)]*\))?\s+)*(public|protected)\s+((?:static|final|abstract|sealed|partial|readonly|virtual|override|async|default|synchronized|record)\s+)*(class|interface|enum|record|struct|@interface|[\w<>\[\],.?\s]+?)\s+([A-Za-z_]\w*)\s*(?=[({<:]|extends|implements|where|$)/gm;
  for (const m of masked.matchAll(typeRe)) {
    // the match may start on annotation lines; the declaration itself starts after them
    const decl = m[0].replace(/^[ \t\n]*(?:(?:\[[^\]\n]+\]|#\[[^\]\n]+\]|@\w+(?:\([^)]*\))?)[ \t]*\n?[ \t]*)*/, '');
    const idx = m.index! + (m[0].length - decl.length);
    let kind: string;
    let name: string;
    if (lang === 'rust') {
      kind = m[1] === 'fn' ? 'function' : m[1];
      name = m[2];
    } else if (lang === 'kotlin') {
      kind = m[2] === 'fun' ? 'function' : m[2];
      name = m[3];
      if (/\b(private|protected)\b/.test(m[0])) continue;
    } else if (lang === 'swift' || lang === 'php') {
      kind = m[1] === 'func' || m[1] === 'function' ? 'function' : m[1];
      name = m[2];
    } else {
      const t = m[3].trim();
      kind = ['class', 'interface', 'enum', 'record', 'struct', '@interface'].includes(t) ? t.replace('@interface', 'annotation') : 'method';
      name = m[4];
      if (kind === 'method' && /^(return|new|else|throw)$/.test(t)) continue;
    }
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    const signature = truncate(sigUntil(src, masked, lineStart, '{;=').trim(), 400);
    const doc = docBefore(src, lineStart, docStyle as 'jsdoc');
    const decorators: string[] = [];
    for (const d of src.slice(Math.max(0, lineStart - 600), lineStart).split('\n').reverse()) {
      const t = d.trim();
      if (/^@\w/.test(t) || /^\[\w/.test(t) || /^#\[/.test(t)) decorators.unshift(t);
      else if (t && !t.startsWith('*') && !t.startsWith('/') && !t.startsWith('///')) break;
    }
    const sym: CodeSymbol = { name, kind, signature, line: li(idx), exported: true, doc: docSummary(doc), decorators: decorators.length ? decorators : undefined, attrs: {} };
    if (/@Deprecated|\[Obsolete|#\[deprecated/.test(decorators.join(' '))) sym.attrs!.deprecated = true;
    const route = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']?([^"')]*)|\[(?:Http(Get|Post|Put|Patch|Delete))(?:\(\s*"([^"]*)")?/.exec(decorators.join(' '));
    if (route) {
      sym.kind = 'route';
      sym.attrs!.method = (route[1] ?? route[3] ?? 'ANY').toUpperCase().replace('REQUEST', 'ANY');
      sym.attrs!.path = route[2] ?? route[4] ?? '';
    }
    symbols.push(sym);
  }
  return { file: refOf(file), language: lang, imports, symbols: symbols.slice(0, 300), moduleDoc: undefined, lines: src.split('\n').length };
}

export function analyzeCode(src: string, file: FileInfo): CodeFileInfo | undefined {
  const lang = codeLanguage(file.ext);
  if (!lang) return undefined;
  if (lang === 'typescript' || lang === 'javascript') return analyzeTs(src, file);
  if (lang === 'vue' || lang === 'svelte' || lang === 'astro') {
    const script = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(src)?.[1] ?? (lang === 'astro' ? /^---\n([\s\S]*?)\n---/.exec(src)?.[1] : '') ?? '';
    const info = analyzeTs(script, file);
    const name = file.path.split('/').pop()!.replace(/\.\w+$/, '');
    const props = [...script.matchAll(/defineProps<\{([^}]*)\}>|defineProps\(\s*\{([^}]*)\}|export\s+let\s+(\w+)/g)].map((m) => oneLine(m[1] ?? m[2] ?? m[3]));
    info.language = lang;
    info.symbols.unshift({ name, kind: 'component', signature: `<${name}>${props.length ? ` props: ${truncate(props.join('; '), 200)}` : ''}`, line: 1, exported: true, attrs: { framework: lang } });
    return info;
  }
  if (lang === 'python') return analyzePython(src, file);
  if (lang === 'go') return analyzeGo(src, file);
  if (['java', 'kotlin', 'scala', 'groovy', 'csharp', 'rust', 'swift', 'php', 'dart', 'cpp', 'c'].includes(lang)) return analyzeCLike(src, file, lang);
  return { file: refOf(file), language: lang, imports: [], symbols: [], lines: src.split('\n').length };
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|specs)\/|\.(test|spec|e2e)\.[a-z]+$|_test\.(go|py)$|^test_[^/]*\.py$|\/test_[^/]*\.py$/i;
export const isTestFile = (p: string): boolean => TEST_FILE.test(p);

export const codeAnalyzer: Analyzer = {
  id: 'code',
  version: '1',
  description: 'Static extraction of public API: exported symbols, signatures, doc comments, decorators/annotations, HTTP routes and imports.',
  handles: ['TypeScript/JavaScript (+JSX/TSX, Vue/Svelte/Astro script blocks)', 'Python', 'Go', 'Java/Kotlin/Scala/Groovy', 'C#', 'Rust', 'Swift', 'PHP', 'Dart', 'C/C++ (includes and public declarations)'],
  limitations: [
    'Heuristic parsing, not a compiler: complex generics, macros, overloads and re-export chains may be summarised or missed.',
    'Only declarations are read; runtime behaviour is never inferred.',
    'Routes registered dynamically (computed paths) are not detected.',
  ],
  match: (f) => (f.format.startsWith('code:') ? 10 : 0),
  analyze(file, ctx): AnalysisResult {
    const res = emptyResult();
    const src = ctx.read(file);
    const red = redactSecrets(src);
    if (red.count) {
      res.redactions = red.count;
      res.warnings.push({ code: 'secret-redacted', message: `${red.count} secret-like literal(s) found in source (${red.kinds.join(', ')}); they are never copied to the vault`, ref: refOf(file) });
    }
    const info = analyzeCode(red.text, file);
    if (!info) return res;
    res.code = info;
    const exported = info.symbols.filter((s) => s.exported);
    const fp = sha256(stableStringify(exported.map((s) => [s.kind, s.name, s.signature, (s.members ?? []).map((m) => m.signature)]))).slice(0, 16);
    res.entities.push(entity({ key: `file:${file.source}:${file.path}`, type: 'source-file', name: file.path, scope: '', attrs: { language: info.language, symbols: exported.length, test: isTestFile(file.path) }, refs: [refOf(file)], fingerprint: fp }));
    return res;
  },
};
