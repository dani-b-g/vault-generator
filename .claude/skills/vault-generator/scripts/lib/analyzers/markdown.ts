import type { Analyzer, AnalysisResult, DocumentUnit, FileInfo } from '../types.ts';
import { mapOutsideCode, parseMarkdown, plainText, splitFrontmatter } from '../markdown.ts';
import { detectInjection, redactSecrets } from '../safety.ts';
import { posixBase, posixDir } from '../util.ts';
import { docAuthority, emptyResult, entity, extractFacts, isReadme, refOf, rel, versionFromPath } from './common.ts';

/** Category from path/title/content. Purely descriptive: used for layout and filtering, never as a claim. */
export function docCategory(p: string, title: string, body: string): string {
  const lp = p.toLowerCase();
  const base = posixBase(lp);
  if (isReadme(lp)) return 'readme';
  if (/^(changelog|changes|history|releases?|release-notes)(\.|$)/.test(base)) return 'changelog';
  if (/^(contributing|code_of_conduct|code-of-conduct|governance)(\.|$)/.test(base)) return 'contributing';
  if (/^(license|licence|copying|notice)(\.|$)/.test(base)) return 'license';
  if (/^security(\.|$)/.test(base)) return 'security';
  if (/(^|\/)(adrs?|decisions?|architecture-decisions?|rfcs?)\//.test(lp) || /^(adr|rfc)[-_ ]?\d+/i.test(base) || /^\s*#?\s*(adr|rfc)[-_ ]?\d+/i.test(title) || (/^##?\s*(status|estado)\s*$/im.test(body) && /^##?\s*(context|contexto)\s*$/im.test(body) && /^##?\s*(decision|decisión)\s*$/im.test(body))) return 'decision';
  if (/(^|\/)(examples?|samples?|demos?|recipes|cookbook)\//.test(lp)) return 'example';
  if (/(^|\/)(tutorials?|getting-started|quickstart|quick-start|primeros-pasos)\b/.test(lp) || /^(getting started|quick ?start|tutorial)/i.test(title)) return 'tutorial';
  if (/(^|\/)(guides?|how-?to|howtos|guias?)\//.test(lp)) return 'guide';
  if (/(^|\/)(api|reference|referencia)\//.test(lp)) return 'reference';
  if (/(^|\/)(architecture|arquitectura|design|diseno|diseño)\//.test(lp) || /architecture|arquitectura/i.test(title)) return 'architecture';
  if (/(^|\/)(ops|operations|runbooks?|deploy(ment)?|infra(structure)?)\//.test(lp)) return 'operations';
  return 'document';
}

const MDX_IMPORT = /^\s*(import|export)\s[^\n]*$/gm;
const JSX_BLOCK = /^\s*<([A-Z][A-Za-z0-9.]*)\b[^>]*\/?>\s*$/gm;

/** Convert dialect-specific markdown to Obsidian-flavoured markdown, recording what was lost. */
export function toObsidian(body: string, mdx: boolean, lossy: string[]): string {
  let out = body;
  // docusaurus / vitepress admonitions  ::: kind [title] ... :::
  out = out.replace(/^:::\s*(note|tip|info|warning|danger|caution|important|details)\b[ \t]*(.*)\n([\s\S]*?)^:::\s*$/gim, (_m, kind: string, title: string, inner: string) => {
    const k = kind.toLowerCase() === 'details' ? 'note]-' : `${kind.toLowerCase()}]`;
    return `> [!${k}${title.trim() ? ` ${title.trim()}` : ''}\n${inner.replace(/\n$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n`;
  });
  // mkdocs admonitions  !!! kind "title"  + indented body
  out = out.replace(/^(?:!!!|\?\?\?\+?)\s+(\w+)(?:\s+"([^"]*)")?\s*\n((?:(?: {4}|\t).*\n?|\s*\n)*)/gm, (_m, kind: string, title: string | undefined, inner: string) => {
    const lines = inner.replace(/\n+$/, '').split('\n').map((l) => l.replace(/^( {4}|\t)/, ''));
    return `> [!${kind.toLowerCase()}]${title ? ` ${title}` : ''}\n${lines.map((l) => (l ? `> ${l}` : '>')).join('\n')}\n`;
  });
  if (mdx) {
    let imports = 0;
    let jsx = 0;
    out = mapOutsideCode(out, (seg) => seg.replace(MDX_IMPORT, () => (imports++, '')));
    out = mapOutsideCode(out, (seg) => seg.replace(JSX_BLOCK, (m: string, name: string) => (jsx++, `> [!info] MDX component \`<${name}>\` not rendered in Obsidian`)));
    if (imports) lossy.push(`MDX import/export statements removed (${imports})`);
    if (jsx) lossy.push(`MDX/JSX components replaced by placeholders (${jsx})`);
  }
  // HTML comments are preserved by Obsidian; tabs/raw html stay as-is.
  return out;
}

export const markdownAnalyzer: Analyzer = {
  id: 'markdown',
  version: '1',
  description: 'Markdown/MDX/plain text/Mermaid documents: headings, links, code, tables, admonitions, frontmatter, ADRs, versions.',
  handles: ['.md', '.markdown', '.mdx', '.txt', '.rst (as text)', '.adoc (as text)', '.mmd', '.mermaid'],
  limitations: [
    'reStructuredText and AsciiDoc are imported as plain text (no markup conversion).',
    'MDX/JSX components are replaced by placeholders.',
  ],
  match: (f) => (f.format === 'markdown' || f.format === 'text' || f.format === 'mermaid' ? 10 : 0),
  analyze(file: FileInfo, ctx): AnalysisResult {
    const res = emptyResult();
    const raw = ctx.read(file);
    const lossy: string[] = [];
    let body: string;
    let fmData: Record<string, unknown> | undefined;
    if (file.format === 'mermaid') {
      body = `\`\`\`mermaid\n${raw.trim()}\n\`\`\``;
    } else if (file.format === 'text') {
      if (/\.(rst|adoc|asciidoc|org|textile)$/.test(file.ext)) lossy.push(`${file.ext} markup not converted (imported as preformatted text)`);
      body = /\.(rst|adoc|asciidoc|org|textile)$/.test(file.ext) ? `\`\`\`text\n${raw.replace(/```/g, "'''")}\n\`\`\`` : raw;
    } else {
      const sp = splitFrontmatter(raw);
      body = sp.body;
      fmData = sp.fm?.data;
      if (sp.fm?.error) res.warnings.push({ code: 'frontmatter', message: `invalid YAML frontmatter kept as text: ${sp.fm.error}`, ref: refOf(file) });
      if (sp.fm?.error) body = `\`\`\`yaml\n${sp.fm.raw}\n\`\`\`\n${body}`;
      body = toObsidian(body, file.ext === '.mdx', lossy);
    }
    const red = redactSecrets(body);
    body = red.text;
    if (red.count) {
      res.redactions = red.count;
      res.warnings.push({ code: 'secret-redacted', message: `${red.count} secret-like value(s) redacted (${red.kinds.join(', ')})`, ref: refOf(file) });
    }
    const inj = detectInjection(body);
    if (inj.length) res.warnings.push({ code: 'untrusted-instructions', message: 'document contains instruction-like text; it is kept as data and flagged', ref: refOf(file) });

    const parsed = parseMarkdown(body);
    const fmTitle = typeof fmData?.title === 'string' ? fmData.title : undefined;
    const dirName = posixBase(posixDir(file.path)) || ctx.source.label;
    const stem = posixBase(file.path).replace(/\.[^.]+$/, '');
    let title = fmTitle ?? parsed.title ?? (file.format === 'mermaid' ? `${stem} (diagram)` : stem);
    if (isReadme(file.path) && (!parsed.title || /^readme$/i.test(parsed.title))) title = `${dirName} README`;
    const category = typeof fmData?.vg_category === 'string' ? fmData.vg_category : docCategory(file.path, title, body);
    const version = (typeof fmData?.version === 'string' || typeof fmData?.version === 'number' ? String(fmData.version) : undefined) ?? versionFromPath(file.path);
    const key = `doc:${file.source}:${file.path}`;
    const doc: DocumentUnit = {
      key,
      file: refOf(file),
      title: String(title).trim(),
      kind: file.format === 'mermaid' ? 'diagram' : category === 'decision' ? 'adr' : file.format,
      category,
      body,
      frontmatter: fmData,
      sections: parsed.sections,
      links: parsed.links,
      codeBlocks: parsed.codeBlocks,
      mermaid: file.format === 'mermaid' ? 1 : parsed.mermaid,
      tables: parsed.tables,
      admonitions: parsed.admonitions,
      version,
      lossy,
    };
    res.documents.push(doc);
    const type = category === 'decision' ? 'decision' : category === 'example' ? 'example' : 'document';
    const summary = typeof fmData?.description === 'string' ? fmData.description : parsed.firstParagraph ? plainText(parsed.firstParagraph).slice(0, 300) : undefined;
    const attrs: Record<string, unknown> = { category, version, injection: inj.length > 0 };
    if (category === 'decision') {
      const status = /^##?\s*(?:status|estado)\s*\n+\s*([^\n]+)/im.exec(body)?.[1] ?? (typeof fmData?.status === 'string' ? fmData.status : undefined);
      if (status) attrs.decisionStatus = plainText(status).toLowerCase();
      const sup = /superseded by\s*\[?([^\]\n]+)\]?(?:\(([^)]+)\))?/i.exec(body) ?? /sustituid[oa] por\s*\[?([^\]\n]+)\]?(?:\(([^)]+)\))?/i.exec(body);
      if (sup) attrs.supersededBy = sup[2] ?? sup[1];
    }
    res.entities.push(entity({ key, type, name: doc.title, scope: '', summary, attrs, refs: [refOf(file)] }));
    // supersedes: explicit statement in the newer ADR ("Supersedes [ADR-1](0001-x.md)")
    for (const m of body.matchAll(/(?:supersedes|replaces|sustituye a)\s*\[([^\]]+)\]\(([^)]+)\)/gi)) {
      res.relations.push(rel('supersedes', key, `link:${file.source}:${file.path}:${m[2]}`, 'verified', refOf(file), `explicit: "${m[0].slice(0, 80)}"`));
    }
    for (const f of extractFacts(body, refOf(file), docAuthority(file.path))) res.facts.push(f);
    if (lossy.length) res.limitations.push(...lossy);
    return res;
  },
};
