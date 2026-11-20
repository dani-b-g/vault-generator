import type { Analyzer, AnalysisResult, FileInfo } from '../types.ts';
import { htmlToMarkdown } from '../html.ts';
import { parseMarkdown, plainText } from '../markdown.ts';
import { detectInjection, redactSecrets } from '../safety.ts';
import { posixBase } from '../util.ts';
import { emptyResult, entity, extractFacts, refOf, versionFromPath } from './common.ts';
import { docCategory } from './markdown.ts';

/** Pages of generated sites that carry no knowledge of their own. */
const CHROME_PAGES = /(^|\/)(search|genindex|py-modindex|404|sitemap|coverage|routes|overview|miscellaneous\/[a-z]+)\.html?$/i;

export const htmlAnalyzer: Analyzer = {
  id: 'html',
  version: '1',
  description: 'HTML pages and generated documentation sites (TypeDoc, Compodoc, Javadoc, Sphinx, MkDocs, Docusaurus builds) converted to Markdown.',
  handles: ['.html', '.htm', '.xhtml'],
  limitations: [
    'Scripts, forms, inline SVG and embedded media are dropped (media become links).',
    'Table colspan/rowspan and nested tables are flattened.',
    'CSS-only semantics (colors, layout) are not preserved.',
  ],
  match: (f) => (f.format === 'html' ? 10 : 0),
  analyze(file: FileInfo, ctx): AnalysisResult {
    const res = emptyResult();
    if (CHROME_PAGES.test(file.path)) {
      res.limitations.push('generated-site navigation/search page skipped');
      return res;
    }
    const conv = htmlToMarkdown(ctx.read(file));
    if (!conv.markdown.trim()) {
      res.warnings.push({ code: 'empty', message: 'no readable content found in HTML page', ref: refOf(file) });
      return res;
    }
    const red = redactSecrets(conv.markdown);
    if (red.count) {
      res.redactions = red.count;
      res.warnings.push({ code: 'secret-redacted', message: `${red.count} secret-like value(s) redacted`, ref: refOf(file) });
    }
    const body = red.text;
    const parsed = parseMarkdown(body);
    const stem = posixBase(file.path).replace(/\.[^.]+$/, '');
    const title = (conv.title ?? parsed.title ?? (stem === 'index' ? posixBase(file.path.split('/').slice(-2, -1)[0] ?? stem) : stem)).trim();
    const generated = !!conv.generator && ['typedoc', 'compodoc', 'javadoc', 'sphinx', 'mkdocs', 'docusaurus', 'hugo', 'jekyll'].includes(conv.generator);
    const category = conv.generator && ['typedoc', 'compodoc', 'javadoc'].includes(conv.generator) ? 'api-doc' : docCategory(file.path, title, body);
    const lossy = [...conv.lossy];
    const key = `doc:${file.source}:${file.path}`;
    res.documents.push({
      key,
      file: refOf(file),
      title,
      kind: 'html',
      category,
      body,
      sections: parsed.sections,
      links: parsed.links,
      codeBlocks: parsed.codeBlocks,
      mermaid: parsed.mermaid,
      tables: parsed.tables,
      admonitions: parsed.admonitions,
      version: versionFromPath(file.path),
      lossy,
    });
    const inj = detectInjection(body);
    if (inj.length) res.warnings.push({ code: 'untrusted-instructions', message: 'page contains instruction-like text; kept as data and flagged', ref: refOf(file) });
    res.entities.push(
      entity({
        key,
        type: category === 'decision' ? 'decision' : 'document',
        name: title,
        scope: '',
        summary: parsed.firstParagraph ? plainText(parsed.firstParagraph).slice(0, 300) : undefined,
        attrs: { category, generator: conv.generator, generated, region: conv.region, injection: inj.length > 0 },
        refs: [refOf(file)],
      }),
    );
    for (const f of extractFacts(body, refOf(file), generated ? 'generated-doc' : 'doc')) res.facts.push(f);
    res.limitations.push(...lossy);
    return res;
  },
};
