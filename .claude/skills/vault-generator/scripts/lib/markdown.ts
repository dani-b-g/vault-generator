import type { LinkRef, Section } from './types.ts';
import { headingSlug, normalizeText } from './util.ts';
import { parseYaml, stringifyYaml } from './yaml.ts';

export interface Frontmatter {
  data: Record<string, unknown>;
  /** raw text between the fences, without fences */
  raw: string;
  /** 0-based line index of the first body line */
  bodyStart: number;
  error?: string;
}

/** Split a document into frontmatter and body. Frontmatter must start on line 1. */
export function splitFrontmatter(text: string): { fm?: Frontmatter; body: string } {
  const t = normalizeText(text);
  if (!t.startsWith('---\n') && t !== '---') return { body: t };
  const lines = t.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) return { body: t };
  const raw = lines.slice(1, end).join('\n');
  const parsed = raw.trim() ? parseYaml(raw) : { value: {} };
  const data = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : {};
  const fm: Frontmatter = { data, raw, bodyStart: end + 1 };
  if (parsed.error) fm.error = parsed.error;
  return { fm, body: lines.slice(end + 1).join('\n') };
}

export function serializeFrontmatter(data: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) clean[k] = v;
  if (!Object.keys(clean).length) return '';
  return `---\n${stringifyYaml(clean).replace(/\n+$/, '')}\n---\n`;
}

export interface FenceInfo {
  open: number;
  close: number;
  lang: string;
  info: string;
}

/** Returns a per-line boolean array: true when the line is inside (or is a delimiter of) a fenced code block. */
export function codeMask(lines: string[]): { mask: boolean[]; fences: FenceInfo[] } {
  const mask = new Array<boolean>(lines.length).fill(false);
  const fences: FenceInfo[] = [];
  let open: { ch: string; len: number; line: number; info: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/.exec(l);
      if (m) {
        open = { ch: m[1][0], len: m[1].length, line: i, info: m[2].trim() };
        mask[i] = true;
      }
    } else {
      mask[i] = true;
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) {
        fences.push({ open: open.line, close: i, lang: (open.info.split(/\s+/)[0] ?? '').toLowerCase(), info: open.info });
        open = undefined;
      }
    }
  }
  if (open) {
    // unterminated fence swallows the rest of the file (CommonMark behaviour)
    fences.push({ open: open.line, close: lines.length - 1, lang: (open.info.split(/\s+/)[0] ?? '').toLowerCase(), info: open.info });
  }
  return { mask, fences };
}

export interface ParsedMarkdown {
  title?: string;
  sections: Section[];
  links: LinkRef[];
  codeBlocks: { lang: string; line: number }[];
  mermaid: number;
  tables: number;
  admonitions: { kind: string; text: string; line: number }[];
  /** first non-heading paragraph, plain text (used as summary) */
  firstParagraph?: string;
}

const INLINE_LINK = /(!?)\[((?:[^\[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const REF_DEF = /^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)/;

/** Heading levels in body: ATX plus setext. Offsets are 1-based lines of `body`. */
export function parseMarkdown(body: string): ParsedMarkdown {
  const lines = body.split('\n');
  const { mask, fences } = codeMask(lines);
  const sections: Section[] = [];
  const links: LinkRef[] = [];
  const admonitions: { kind: string; text: string; line: number }[] = [];
  let tables = 0;
  let firstParagraph: string | undefined;
  const seenSlugs = new Map<string, number>();

  const pushSection = (level: number, title: string, line: number) => {
    let slug = headingSlug(title) || 'section';
    const n = seenSlugs.get(slug) ?? 0;
    seenSlugs.set(slug, n + 1);
    if (n) slug = `${slug}-${n}`;
    sections.push({ level, title, slug, start: line, end: lines.length });
  };

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const l = lines[i];
    const atx = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (atx) {
      pushSection(atx[1].length, atx[2].replace(/\s*\{#[^}]+\}\s*$/, '').trim(), i + 1);
      continue;
    }
    const next = lines[i + 1];
    if (l.trim() && !mask[i + 1] && next !== undefined && /^ {0,3}(=+|-+)\s*$/.test(next) && !/^\s*([-*+]|\d+[.)])\s/.test(l) && !/^\s*>/.test(l) && !/^\s*\|/.test(l)) {
      pushSection(next.trim().startsWith('=') ? 1 : 2, l.trim(), i + 1);
      i++;
      continue;
    }
    // GitHub style alerts and docusaurus/mkdocs admonitions
    const gh = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(l);
    if (gh) {
      admonitions.push({ kind: gh[1].toLowerCase(), text: gh[2] || (lines[i + 1] ?? '').replace(/^\s*>\s?/, ''), line: i + 1 });
    }
    const dc = /^\s*:::\s*(note|tip|info|warning|danger|caution|important)\b\s*(.*)$/i.exec(l);
    if (dc) admonitions.push({ kind: dc[1].toLowerCase(), text: dc[2], line: i + 1 });
    const mk = /^\s*(?:!!!|\?\?\?\+?)\s+(note|tip|info|warning|danger|caution|important|example|abstract)\b\s*(?:"([^"]*)")?/i.exec(l);
    if (mk) admonitions.push({ kind: mk[1].toLowerCase(), text: mk[2] ?? '', line: i + 1 });
    // tables
    if (/^\s*\|?.+\|.+/.test(l) && next !== undefined && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(next) && next.includes('-')) {
      tables++;
    }
    // first paragraph (summary)
    if (!firstParagraph && l.trim() && !/^\s*([#>|<!`~]|[-*+]\s|\d+[.)]\s|---|\[!\[|!\[|\[[^\]]+\]:)/.test(l) && !/^\s*<\w/.test(l)) {
      const para: string[] = [];
      for (let j = i; j < lines.length && lines[j].trim() && !mask[j] && !/^\s*[#>|`~]/.test(lines[j]); j++) para.push(lines[j].trim());
      const text = plainText(para.join(' '));
      if (text.length >= 20) firstParagraph = text;
    }
    // links
    INLINE_LINK.lastIndex = 0;
    let m: RegExpExecArray | null;
    const lineNoCode = l.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
    while ((m = INLINE_LINK.exec(lineNoCode))) {
      const target = m[3].replace(/^<|>$/g, '');
      if (target) links.push({ target, text: m[2], line: i + 1, kind: m[1] ? 'image' : 'link' });
    }
    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(lineNoCode))) links.push({ target: m[2].split('|')[0].split('#')[0].trim(), text: m[2].split('|')[1]?.trim(), line: i + 1, kind: m[1] ? 'embed' : 'wikilink' });
    const rd = REF_DEF.exec(l);
    if (rd) links.push({ target: rd[2].replace(/^<|>$/g, ''), text: rd[1], line: i + 1, kind: 'link' });
    // html images
    const img = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    let hm: RegExpExecArray | null;
    while ((hm = img.exec(lineNoCode))) links.push({ target: hm[1], line: i + 1, kind: 'image' });
  }

  // section ends: until next heading of same or higher level
  for (let s = 0; s < sections.length; s++) {
    let end = lines.length;
    for (let n = s + 1; n < sections.length; n++) {
      if (sections[n].level <= sections[s].level) {
        end = sections[n].start - 1;
        break;
      }
    }
    sections[s].end = end;
  }

  const codeBlocks = fences.map((f) => ({ lang: f.lang, line: f.open + 1 }));
  const mermaid = fences.filter((f) => f.lang === 'mermaid').length;
  const h1 = sections.find((s) => s.level === 1);
  return { title: h1?.title, sections, links, codeBlocks, mermaid, tables, admonitions, firstParagraph };
}

export function plainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a: string, b: string) => b || a)
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Apply `fn` to every inline link/image target that is outside fenced code and inline code. */
export function rewriteLinks(body: string, fn: (target: string, kind: 'link' | 'image', text: string) => string | undefined): string {
  const lines = body.split('\n');
  const { mask } = codeMask(lines);
  return lines
    .map((l, i) => {
      if (mask[i]) return l;
      const parts = l.split(/(`[^`]*`)/);
      return parts
        .map((p, idx) => {
          if (idx % 2 === 1) return p;
          return p.replace(INLINE_LINK, (full, bang: string, text: string, target: string) => {
            const raw = target.replace(/^<|>$/g, '');
            const res = fn(raw, bang ? 'image' : 'link', text);
            if (res === undefined) return full;
            const wrapped = /\s/.test(res) ? `<${res}>` : res;
            return `${bang}[${text}](${wrapped})`;
          });
        })
        .join('');
    })
    .join('\n');
}

/** Replace every inline link/image outside code with `fn`'s result (undefined keeps the original). */
export function replaceLinks(body: string, fn: (m: { image: boolean; text: string; target: string; full: string }) => string | undefined): string {
  return mapOutsideCode(body, (seg) =>
    seg.replace(INLINE_LINK, (full, bang: string, text: string, target: string) => fn({ image: !!bang, text, target: target.replace(/^<|>$/g, ''), full }) ?? full),
  );
}

/** Replace text outside fenced/inline code only. */
export function mapOutsideCode(body: string, fn: (segment: string) => string): string {
  const lines = body.split('\n');
  const { mask } = codeMask(lines);
  return lines
    .map((l, i) => (mask[i] ? l : l.split(/(`[^`]*`)/).map((p, idx) => (idx % 2 ? p : fn(p))).join('')))
    .join('\n');
}

export function extractSection(body: string, parsed: ParsedMarkdown, slugOrTitle: string): string | undefined {
  const want = slugOrTitle.toLowerCase();
  const sec = parsed.sections.find((s) => s.slug === want || s.title.toLowerCase() === want || headingSlug(s.title) === headingSlug(slugOrTitle));
  if (!sec) return undefined;
  return body.split('\n').slice(sec.start - 1, sec.end).join('\n');
}

/** Heading-aware chunking used by the search index: each section becomes a chunk, oversized sections are split by paragraphs. */
export interface Chunk {
  heading: string;
  anchor: string;
  level: number;
  start: number;
  end: number;
  text: string;
  /** heading path, e.g. "Install > Windows" */
  path: string;
}
export function chunkMarkdown(body: string, maxChars = 2400): Chunk[] {
  const lines = body.split('\n');
  const parsed = parseMarkdown(body);
  const chunks: Chunk[] = [];
  const stack: { level: number; title: string }[] = [];
  const bounds: { heading: string; anchor: string; level: number; start: number }[] = [];
  const first = parsed.sections[0]?.start ?? lines.length + 1;
  if (first > 1) bounds.push({ heading: '', anchor: '', level: 0, start: 1 });
  for (const s of parsed.sections) bounds.push({ heading: s.title, anchor: s.slug, level: s.level, start: s.start });
  for (let b = 0; b < bounds.length; b++) {
    const cur = bounds[b];
    const end = (bounds[b + 1]?.start ?? lines.length + 1) - 1;
    while (stack.length && stack[stack.length - 1].level >= cur.level && cur.level > 0) stack.pop();
    if (cur.level > 0) stack.push({ level: cur.level, title: cur.heading });
    const text = lines.slice(cur.start - 1, end).join('\n').trim();
    if (!text) continue;
    const path = stack.map((s) => s.title).join(' > ');
    if (text.length <= maxChars) {
      chunks.push({ heading: cur.heading, anchor: cur.anchor, level: cur.level, start: cur.start, end, text, path });
    } else {
      let buf: string[] = [];
      let bufStart = cur.start;
      let len = 0;
      for (let i = cur.start - 1; i < end; i++) {
        buf.push(lines[i]);
        len += lines[i].length + 1;
        const atBreak = lines[i].trim() === '' || i === end - 1;
        if (len >= maxChars && atBreak) {
          chunks.push({ heading: cur.heading, anchor: cur.anchor, level: cur.level, start: bufStart, end: i + 1, text: buf.join('\n').trim(), path });
          buf = [];
          bufStart = i + 2;
          len = 0;
        }
      }
      if (buf.join('').trim()) chunks.push({ heading: cur.heading, anchor: cur.anchor, level: cur.level, start: bufStart, end, text: buf.join('\n').trim(), path });
    }
  }
  return chunks;
}

/** Split an oversized document into parts at the shallowest heading level that yields several parts. */
export function splitByHeading(body: string, maxChars: number): { title: string; body: string }[] | undefined {
  if (body.length <= maxChars) return undefined;
  const parsed = parseMarkdown(body);
  const lines = body.split('\n');
  for (const level of [2, 3, 4]) {
    const heads = parsed.sections.filter((s) => s.level === level);
    if (heads.length < 2) continue;
    const parts: { title: string; body: string }[] = [];
    const intro = lines.slice(0, heads[0].start - 1).join('\n').trim();
    if (intro) parts.push({ title: '', body: intro });
    for (const h of heads) parts.push({ title: h.title, body: lines.slice(h.start - 1, h.end).join('\n').trim() });
    // merge tiny neighbours so we do not over-fragment
    const merged: { title: string; body: string }[] = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      if (last && last.body.length + p.body.length < maxChars * 0.35) {
        last.body += `\n\n${p.body}`;
        if (!last.title) last.title = p.title;
      } else merged.push({ ...p });
    }
    if (merged.length >= 2) return merged;
  }
  return undefined;
}
