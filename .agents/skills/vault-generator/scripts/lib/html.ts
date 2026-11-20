// Dependency-free HTML → Obsidian Markdown converter.
// Goal: preserve structure (headings, lists, tables, code + language, links, images, admonitions,
// definition lists, mermaid) and report everything that could not be preserved.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul', 'caption', 'center', 'menu',
]);
/** opening one of these implicitly closes an open element of the listed tag */
const IMPLIED_CLOSE: Record<string, string[]> = {
  p: ['p'], li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'],
  thead: ['tbody', 'tfoot'], tbody: ['thead', 'tbody', 'tfoot'], tfoot: ['thead', 'tbody'], option: ['option'],
};
const P_CLOSERS = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'figure', 'details']);

export interface HNode {
  tag: string; // '#text' | '#comment' | element name
  attrs: Record<string, string>;
  children: HNode[];
  parent?: HNode;
  text?: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', divide: '÷', rarr: '→', larr: '←',
  uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', le: '≤', ge: '≥', ne: '≠', plusmn: '±', deg: '°', para: '¶', sect: '§', euro: '€',
  pound: '£', yen: '¥', cent: '¢', iexcl: '¡', iquest: '¿', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü', ccedil: 'ç', Ccedil: 'Ç', zwj: '‍', zwnj: '‌',
  shy: '', thinsp: ' ', ensp: ' ', emsp: ' ', check: '✓', lambda: 'λ', alpha: 'α', beta: 'β', infin: '∞',
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? (m.endsWith(';') ? m : m);
  });
}

export function parseHtml(html: string): HNode {
  const root: HNode = { tag: '#root', attrs: {}, children: [] };
  let cur = root;
  const len = html.length;
  let i = 0;
  const appendText = (t: string) => {
    if (!t) return;
    const last = cur.children[cur.children.length - 1];
    if (last && last.tag === '#text') last.text += t;
    else cur.children.push({ tag: '#text', attrs: {}, children: [], text: t, parent: cur });
  };
  const closeTo = (tag: string): boolean => {
    for (let n: HNode | undefined = cur; n && n !== root; n = n.parent) {
      if (n.tag === tag) {
        cur = n.parent ?? root;
        return true;
      }
    }
    return false;
  };
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      appendText(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? len : end + 1;
      continue;
    }
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 64));
    if (!m) {
      appendText('<');
      i = lt + 1;
      continue;
    }
    // find tag end respecting quoted attribute values
    let j = lt + m[0].length;
    let q: string | undefined;
    for (; j < len; j++) {
      const c = html[j];
      if (q) {
        if (c === q) q = undefined;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    const raw = html.slice(lt, j + 1);
    i = j + 1;
    const tag = m[1].toLowerCase();
    if (raw.startsWith('</')) {
      if (tag === 'p' && !closeTo('p')) cur.children.push({ tag: 'p', attrs: {}, children: [], parent: cur });
      else closeTo(tag);
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    const attrSrc = raw.slice(m[0].length, raw.endsWith('/>') ? -2 : -1);
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrSrc))) attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? '');
    if (IMPLIED_CLOSE[tag]) {
      // close the nearest implied sibling, but never across a list/table boundary
      for (let n: HNode | undefined = cur; n && n !== root; n = n.parent) {
        if (IMPLIED_CLOSE[tag].includes(n.tag)) {
          cur = n.parent ?? root;
          break;
        }
        if (['ul', 'ol', 'table', 'dl', 'tbody', 'thead', 'tfoot', 'tr', 'select'].includes(n.tag) && !(tag === 'tr' && ['tbody', 'thead', 'tfoot'].includes(n.tag) === false)) break;
      }
    }
    if (P_CLOSERS.has(tag)) {
      for (let n: HNode | undefined = cur; n && n !== root; n = n.parent) {
        if (n.tag === 'p') {
          cur = n.parent ?? root;
          break;
        }
        if (BLOCK.has(n.tag)) break;
      }
    }
    const node: HNode = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (VOID.has(tag) || raw.endsWith('/>')) continue;
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const body = html.slice(i, close < 0 ? len : close);
      node.children.push({ tag: '#text', attrs: {}, children: [], text: tag === 'textarea' || tag === 'title' ? decodeEntities(body) : body, parent: node });
      const gt = close < 0 ? len : html.indexOf('>', close);
      i = gt < 0 ? len : gt + 1;
      continue;
    }
    cur = node;
  }
  return root;
}

const cls = (n: HNode) => ` ${(n.attrs.class ?? '').toLowerCase()} `;
const hasClass = (n: HNode, c: string) => cls(n).includes(` ${c} `);
export function findAll(n: HNode, pred: (x: HNode) => boolean, out: HNode[] = []): HNode[] {
  for (const c of n.children) {
    if (c.tag[0] !== '#' && pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}
export const findFirst = (n: HNode, pred: (x: HNode) => boolean): HNode | undefined => findAll(n, pred)[0];
export function textContent(n: HNode): string {
  if (n.tag === '#text') return n.text ?? '';
  if (RAW.has(n.tag) && n.tag !== 'title') return '';
  return n.children.map(textContent).join('');
}

export interface HtmlConversion {
  title?: string;
  markdown: string;
  lossy: string[];
  generator?: string;
  /** css selector-ish description of the region converted */
  region: string;
  links: { href: string; text: string }[];
  images: string[];
}

function detectGenerator(root: HNode): string | undefined {
  const meta = findAll(root, (n) => n.tag === 'meta' && (n.attrs.name ?? '').toLowerCase() === 'generator')[0];
  const gen = meta?.attrs.content?.toLowerCase() ?? '';
  if (gen.includes('typedoc')) return 'typedoc';
  if (gen.includes('docusaurus')) return 'docusaurus';
  if (gen.includes('mkdocs')) return 'mkdocs';
  if (gen.includes('sphinx')) return 'sphinx';
  if (gen.includes('javadoc') || findFirst(root, (n) => n.tag === 'meta' && (n.attrs.name ?? '') === 'dc.created')) return 'javadoc';
  if (gen.includes('hugo')) return 'hugo';
  if (gen.includes('jekyll')) return 'jekyll';
  if (findFirst(root, (n) => n.tag === 'script' && /compodoc/i.test(n.attrs.src ?? ''))) return 'compodoc';
  if (findFirst(root, (n) => n.tag === 'compodoc-menu' || (n.tag === 'div' && hasClass(n, 'compodoc-table')))) return 'compodoc';
  if (findFirst(root, (n) => n.tag === 'div' && hasClass(n, 'tsd-page-toolbar'))) return 'typedoc';
  return gen ? gen.split(/\s+/)[0] : undefined;
}

const MAIN_SELECTORS: ((n: HNode) => boolean)[] = [
  (n) => n.tag === 'div' && hasClass(n, 'col-content'), // typedoc
  (n) => n.tag === 'div' && hasClass(n, 'content') && !!n.parent && hasClass(n.parent, 'container-fluid'), // compodoc
  (n) => n.tag === 'article' && hasClass(n, 'md-content__inner'), // mkdocs material
  (n) => (n.attrs.role ?? '') === 'main',
  (n) => n.tag === 'main',
  (n) => n.tag === 'article',
  (n) => n.tag === 'div' && (n.attrs.id === 'content' || n.attrs.id === 'main-content' || hasClass(n, 'markdown-body') || hasClass(n, 'markdown') || hasClass(n, 'document') || hasClass(n, 'contentContainer')),
];
const STRIP_TAGS = new Set(['nav', 'script', 'style', 'noscript', 'template', 'form', 'button', 'select', 'input', 'iframe', 'object', 'embed', 'svg', 'canvas', 'video', 'audio', 'link', 'meta', 'head']);
const ADMONITION = /\b(admonition|alert|callout|note|tip|info|warning|caution|danger|important|attention|hint|error)\b/;

interface RenderState {
  lossy: Map<string, number>;
  links: { href: string; text: string }[];
  images: string[];
}
const bump = (st: RenderState, k: string) => st.lossy.set(k, (st.lossy.get(k) ?? 0) + 1);

function inline(n: HNode, st: RenderState): string {
  if (n.tag === '#text') return (n.text ?? '').replace(/[\s ]+/g, (s) => (s.includes(' ') ? ' ' : ' ')).replace(/([*_`])/g, '\\$1');
  if (STRIP_TAGS.has(n.tag)) {
    if (n.tag === 'svg') bump(st, 'inline SVG graphics dropped');
    else if (n.tag === 'iframe' || n.tag === 'video' || n.tag === 'audio' || n.tag === 'embed' || n.tag === 'object') {
      const src = n.attrs.src ?? findFirst(n, (x) => x.tag === 'source')?.attrs.src;
      bump(st, 'embedded media replaced by links');
      return src ? ` [${n.tag}](${src}) ` : '';
    } else if (n.tag === 'form' || n.tag === 'input' || n.tag === 'select' || n.tag === 'button') bump(st, 'form controls removed');
    return '';
  }
  const kids = () => n.children.map((c) => inline(c, st)).join('');
  switch (n.tag) {
    case 'br':
      return '  \n';
    case 'strong':
    case 'b': {
      const k = kids().trim();
      return k ? `**${k}**` : '';
    }
    case 'em':
    case 'i':
    case 'cite':
    case 'dfn': {
      const k = kids().trim();
      return k ? `*${k}*` : '';
    }
    case 'del':
    case 's':
    case 'strike':
      return `~~${kids().trim()}~~`;
    case 'mark':
      return `==${kids().trim()}==`;
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt': {
      const t = textContent(n).replace(/\s+/g, ' ');
      if (!t.trim()) return '';
      return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
    }
    case 'a': {
      const href = n.attrs.href ?? '';
      const text = kids().trim() || href;
      if (!href || href.startsWith('javascript:')) return text;
      if (href.startsWith('#') && !text) return '';
      st.links.push({ href, text });
      return `[${text.replace(/\]/g, '\\]')}](${/\s/.test(href) ? `<${href}>` : href})`;
    }
    case 'img': {
      const src = n.attrs.src ?? '';
      if (!src) return '';
      if (src.startsWith('data:')) {
        bump(st, 'inline data-URI images dropped');
        return n.attrs.alt ? `*[image: ${n.attrs.alt}]*` : '';
      }
      st.images.push(src);
      return `![${(n.attrs.alt ?? '').replace(/\]/g, '')}](${/\s/.test(src) ? `<${src}>` : src})`;
    }
    case 'sup':
    case 'sub':
      return `<${n.tag}>${textContent(n)}</${n.tag}>`;
    case 'q':
      return `“${kids()}”`;
    default:
      return kids();
  }
}

function tableToMd(n: HNode, st: RenderState): string {
  const rows = findAll(n, (x) => x.tag === 'tr').filter((tr) => {
    // ignore rows of nested tables
    for (let p = tr.parent; p && p !== n; p = p.parent) if (p.tag === 'table') return false;
    return true;
  });
  if (!rows.length) return '';
  const grid: string[][] = [];
  let headerRow = -1;
  rows.forEach((tr, idx) => {
    const cells = tr.children.filter((c) => c.tag === 'td' || c.tag === 'th');
    if (headerRow < 0 && cells.length && cells.every((c) => c.tag === 'th')) headerRow = idx;
    const row: string[] = [];
    for (const c of cells) {
      if (findFirst(c, (x) => x.tag === 'table')) bump(st, 'nested tables flattened');
      const blocks = findFirst(c, (x) => ['ul', 'ol', 'pre', 'p', 'div'].includes(x.tag));
      if (blocks && findAll(c, (x) => ['ul', 'ol', 'pre'].includes(x.tag)).length) bump(st, 'block content inside table cells flattened');
      const txt = c.children.map((k) => (k.tag === 'pre' ? `\`${textContent(k).replace(/\s+/g, ' ').trim()}\`` : inline(k, st))).join(' ').replace(/\s+/g, ' ').trim();
      row.push(txt.replace(/\|/g, '\\|'));
      const span = parseInt(c.attrs.colspan ?? '1', 10);
      if (span > 1) {
        bump(st, 'table cell spans (colspan/rowspan) flattened');
        for (let s = 1; s < span; s++) row.push('');
      }
      if (parseInt(c.attrs.rowspan ?? '1', 10) > 1) bump(st, 'table cell spans (colspan/rowspan) flattened');
    }
    grid.push(row);
  });
  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return '';
  for (const r of grid) while (r.length < width) r.push('');
  const header = headerRow >= 0 ? grid.splice(headerRow, 1)[0] : grid.shift()!;
  const caption = findFirst(n, (x) => x.tag === 'caption');
  const lines = [`| ${header.map((h) => h || ' ').join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...grid.map((r) => `| ${r.join(' | ')} |`)];
  return `${caption ? `*${textContent(caption).trim()}*\n\n` : ''}${lines.join('\n')}`;
}

function codeLang(n: HNode): string {
  const nodes = [n, ...findAll(n, (x) => x.tag === 'code')];
  for (const x of nodes) {
    const c = x.attrs.class ?? '';
    const m = /(?:^|\s)(?:language|lang|highlight|brush:?)-?([a-z0-9+#-]+)/i.exec(c) ?? /(?:^|\s)hljs\s+([a-z0-9+#-]+)/i.exec(c);
    if (m && m[1] !== 'none' && m[1] !== 'plaintext') return m[1].toLowerCase();
    if (x.attrs['data-lang']) return x.attrs['data-lang'].toLowerCase();
  }
  const parentCls = n.parent?.attrs.class ?? '';
  const pm = /highlight-([a-z0-9]+)/.exec(parentCls);
  return pm ? pm[1] : '';
}

function fenceBlock(code: string, lang: string): string {
  let ticks = '```';
  while (code.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${code.replace(/^\n+|\s+$/g, '')}\n${ticks}`;
}

function blocks(n: HNode, st: RenderState, depth = 0): string {
  const out: string[] = [];
  let para = '';
  const flush = () => {
    const p = para.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (p) out.push(p);
    para = '';
  };
  for (const c of n.children) {
    if (c.tag === '#text' || (!BLOCK.has(c.tag) && !STRIP_TAGS.has(c.tag) && c.tag !== 'pre' && c.tag !== 'table')) {
      // mermaid containers are inline-level divs in some generators
      para += inline(c, st);
      continue;
    }
    flush();
    const b = block(c, st, depth);
    if (b.trim()) out.push(b);
  }
  flush();
  return out.join('\n\n');
}

function block(n: HNode, st: RenderState, depth: number): string {
  if (STRIP_TAGS.has(n.tag)) return inline(n, st);
  const h = /^h([1-6])$/.exec(n.tag);
  if (h) {
    const text = n.children.map((c) => inline(c, st)).join('').replace(/\s+/g, ' ').replace(/\s*#+\s*$/, '').replace(/\[\s*\]\([^)]*\)/g, '').trim();
    return text ? `${'#'.repeat(+h[1])} ${text}` : '';
  }
  switch (n.tag) {
    case 'p':
      return n.children.map((c) => inline(c, st)).join('').replace(/[ \t]+/g, ' ').trim();
    case 'hr':
      return '---';
    case 'pre': {
      if (hasClass(n, 'mermaid')) return fenceBlock(textContent(n), 'mermaid');
      return fenceBlock(textContent(n), codeLang(n));
    }
    case 'blockquote': {
      const inner = blocks(n, st, depth);
      return inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    }
    case 'ul':
    case 'ol':
    case 'menu':
      return list(n, st, depth);
    case 'table':
      return tableToMd(n, st);
    case 'dl': {
      const parts: string[] = [];
      for (const c of n.children) {
        if (c.tag === 'dt') parts.push(`**${c.children.map((k) => inline(k, st)).join('').trim()}**`);
        else if (c.tag === 'dd') parts.push(`: ${blocks(c, st, depth).replace(/\n/g, '\n  ')}`);
      }
      return parts.join('\n');
    }
    case 'details': {
      const sum = findFirst(n, (x) => x.tag === 'summary');
      const rest: HNode = { ...n, children: n.children.filter((c) => c !== sum) };
      const body = blocks(rest, st, depth);
      return `> [!note]- ${sum ? textContent(sum).trim() : 'Details'}\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`;
    }
    case 'figure': {
      const cap = findFirst(n, (x) => x.tag === 'figcaption');
      const rest: HNode = { ...n, children: n.children.filter((c) => c !== cap) };
      const body = blocks(rest, st, depth);
      return cap ? `${body}\n\n*${textContent(cap).trim()}*` : body;
    }
    case 'div':
    case 'section':
    case 'aside': {
      if (hasClass(n, 'mermaid')) return fenceBlock(textContent(n), 'mermaid');
      const c = cls(n);
      const adm = ADMONITION.exec(c);
      if (adm && (c.includes('admonition') || c.includes('alert') || c.includes('callout') || n.tag === 'aside' || /\b(note|tip|warning|danger|important|caution)\b/.test(c))) {
        const kind = (/\b(note|tip|info|warning|caution|danger|important|attention|hint|error)\b/.exec(c)?.[1] ?? 'note').replace('attention', 'warning').replace('hint', 'tip').replace('error', 'danger');
        const titleNode = findFirst(n, (x) => hasClass(x, 'admonition-title') || hasClass(x, 'admonition-heading'));
        const rest: HNode = { ...n, children: n.children.filter((x) => x !== titleNode) };
        const body = blocks(rest, st, depth).trim();
        const title = titleNode ? textContent(titleNode).trim() : '';
        return `> [!${kind}]${title ? ` ${title}` : ''}\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`;
      }
      return blocks(n, st, depth);
    }
    default:
      return blocks(n, st, depth);
  }
}

function list(n: HNode, st: RenderState, depth: number): string {
  const ordered = n.tag === 'ol';
  let idx = parseInt(n.attrs.start ?? '1', 10) || 1;
  const lines: string[] = [];
  for (const li of n.children.filter((c) => c.tag === 'li')) {
    const marker = ordered ? `${idx++}.` : '-';
    const pad = ' '.repeat(marker.length + 1);
    const nested = li.children.filter((c) => c.tag === 'ul' || c.tag === 'ol');
    const rest: HNode = { ...li, children: li.children.filter((c) => !nested.includes(c)) };
    let body = blocks(rest, st, depth + 1).trim();
    const cb = findFirst(li, (x) => x.tag === 'input' && (x.attrs.type ?? '') === 'checkbox');
    if (cb) body = `[${'checked' in cb.attrs ? 'x' : ' '}] ${body}`;
    const bodyLines = body.split('\n');
    lines.push(`${marker} ${bodyLines[0] ?? ''}`);
    for (const l of bodyLines.slice(1)) lines.push(l ? `${pad}${l}` : '');
    for (const sub of nested) lines.push(list(sub, st, depth + 1).split('\n').map((l) => (l ? `${pad}${l}` : l)).join('\n'));
  }
  return lines.join('\n');
}

/** Remove structural chrome commonly produced by doc generators inside the main region. */
function pruneChrome(root: HNode, generator?: string): void {
  const kill = (n: HNode): boolean => {
    const c = cls(n);
    if (['nav', 'header', 'footer'].includes(n.tag)) return true;
    if (/\b(tsd-page-toolbar|tsd-navigation|tsd-breadcrumb|breadcrumbs?|headerlink|anchor-link|hash-link|md-source|md-header|md-footer|sidebar|toc|table-of-contents|skip-link|edit-this-page|theme-doc-footer|pagination-nav)\b/.test(c)) return true;
    if (generator === 'typedoc' && /\btsd-(?:filter|widget|index-panel|anchor-icon)\b/.test(c)) return true;
    if (generator === 'compodoc' && (n.tag === 'ul' && hasClass(n, 'nav-tabs'))) return true;
    if (n.tag === 'a' && hasClass(n, 'headerlink')) return true;
    return false;
  };
  const walk = (n: HNode) => {
    n.children = n.children.filter((c) => !(c.tag[0] !== '#' && kill(c)));
    n.children.forEach(walk);
  };
  walk(root);
}

export function htmlToMarkdown(html: string): HtmlConversion {
  const root = parseHtml(html);
  const st: RenderState = { lossy: new Map(), links: [], images: [] };
  const generator = detectGenerator(root);
  const titleNode = findFirst(root, (n) => n.tag === 'title');
  let region = 'body';
  let main: HNode | undefined;
  for (const sel of MAIN_SELECTORS) {
    main = findFirst(root, sel);
    if (main) {
      region = main.tag + (main.attrs.class ? `.${main.attrs.class.split(/\s+/)[0]}` : main.attrs.id ? `#${main.attrs.id}` : main.attrs.role ? `[role=${main.attrs.role}]` : '');
      break;
    }
  }
  if (!main) main = findFirst(root, (n) => n.tag === 'body') ?? root;
  pruneChrome(main, generator);
  const scripts = findAll(main, (n) => n.tag === 'script').length;
  if (scripts) bump(st, 'scripts removed');
  // mermaid inside <pre><code class="language-mermaid">
  let md = blocks(main, st, 0);
  md = md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, (m) => (m.startsWith('  ') ? '  \n' : '\n')).trim();
  const h1 = /^# (.+)$/m.exec(md)?.[1];
  const title = (h1 ?? (titleNode ? textContent(titleNode).replace(/\s+/g, ' ').trim() : undefined))?.replace(/\s*[|–—-]\s*[^|–—-]+$/, (s) => (h1 ? s : ''))?.trim();
  const lossy = [...st.lossy.entries()].map(([k, v]) => `${k} (${v})`);
  return { title: title || undefined, markdown: md, lossy, generator, region, links: st.links, images: st.images };
}
