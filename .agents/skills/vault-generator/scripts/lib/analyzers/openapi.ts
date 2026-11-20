import type { Analyzer, AnalysisResult, FileInfo } from '../types.ts';
import { parseJson, parseYaml } from '../yaml.ts';
import { redactSecrets } from '../safety.ts';
import { escapeMdTable, fence, mdTable, oneLine, posixBase, sha256, stableStringify, truncate } from '../util.ts';
import { emptyResult, entity, refOf } from './common.ts';

export interface ApiOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  params: { name: string; in: string; required: boolean; type: string; description?: string }[];
  requestBody?: { contentType: string; schema: string; required: boolean };
  responses: { status: string; description: string; schema?: string }[];
  deprecated: boolean;
  security?: string[];
}
export interface ApiSchema {
  name: string;
  type: string;
  description?: string;
  properties: { name: string; type: string; required: boolean; description?: string }[];
  enum?: string[];
}
export interface ApiModel {
  title: string;
  version: string;
  spec: string;
  description?: string;
  servers: string[];
  operations: ApiOperation[];
  schemas: ApiSchema[];
  securitySchemes: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function schemaType(s: any, depth = 0): string {
  if (!s || typeof s !== 'object') return 'any';
  if (s.$ref) return String(s.$ref).split('/').pop() ?? 'ref';
  if (depth > 3) return 'object';
  if (s.oneOf || s.anyOf) return (s.oneOf ?? s.anyOf).map((x: any) => schemaType(x, depth + 1)).join(' | ');
  if (s.allOf) return s.allOf.map((x: any) => schemaType(x, depth + 1)).join(' & ');
  if (s.type === 'array') return `${schemaType(s.items, depth + 1)}[]`;
  if (s.enum) return s.enum.map((e: unknown) => JSON.stringify(e)).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type ?? (s.properties ? 'object' : 'any');
  return s.format ? `${t}(${s.format})` : String(t);
}

/** Resolve a local $ref ("#/components/parameters/X") once; external refs are reported, not fetched. */
function deref(spec: any, v: any, unresolved: Set<string>): any {
  if (v && typeof v === 'object' && typeof v.$ref === 'string') {
    if (!v.$ref.startsWith('#/')) {
      unresolved.add(v.$ref);
      return v;
    }
    let cur = spec;
    for (const part of v.$ref.slice(2).split('/')) cur = cur?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (cur === undefined) unresolved.add(v.$ref);
    return cur ?? v;
  }
  return v;
}

export function isOpenApi(doc: unknown): boolean {
  return !!doc && typeof doc === 'object' && (typeof (doc as any).openapi === 'string' || typeof (doc as any).swagger === 'string' || (doc as any).swagger === 2) && typeof (doc as any).paths === 'object';
}

export function readApiModel(spec: any, unresolved = new Set<string>()): ApiModel {
  const v2 = !!spec.swagger;
  const servers: string[] = v2
    ? spec.host
      ? [`${(spec.schemes ?? ['https'])[0]}://${spec.host}${spec.basePath ?? ''}`]
      : spec.basePath
        ? [spec.basePath]
        : []
    : (spec.servers ?? []).map((s: any) => String(s.url));
  const ops: ApiOperation[] = [];
  for (const [p, item0] of Object.entries<any>(spec.paths ?? {})) {
    const item = deref(spec, item0, unresolved) ?? {};
    const shared = (item.parameters ?? []).map((x: any) => deref(spec, x, unresolved));
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const params = [...shared, ...(op.parameters ?? []).map((x: any) => deref(spec, x, unresolved))]
        .filter((x: any) => x && x.in !== 'body')
        .map((x: any) => ({ name: String(x.name), in: String(x.in), required: !!x.required || x.in === 'path', type: schemaType(x.schema ?? x), description: x.description ? oneLine(String(x.description)) : undefined }));
      let requestBody: ApiOperation['requestBody'];
      if (v2) {
        const b = [...shared, ...(op.parameters ?? [])].map((x: any) => deref(spec, x, unresolved)).find((x: any) => x?.in === 'body');
        if (b) requestBody = { contentType: (op.consumes ?? spec.consumes ?? ['application/json'])[0], schema: schemaType(b.schema), required: !!b.required };
      } else if (op.requestBody) {
        const rb = deref(spec, op.requestBody, unresolved);
        const [ct, media] = Object.entries<any>(rb?.content ?? {})[0] ?? [];
        if (ct) requestBody = { contentType: ct, schema: schemaType(media?.schema), required: !!rb.required };
      }
      const responses = Object.entries<any>(op.responses ?? {}).map(([status, r0]) => {
        const r = deref(spec, r0, unresolved) ?? {};
        const schema = v2 ? (r.schema ? schemaType(r.schema) : undefined) : (() => {
          const media = Object.values<any>(r.content ?? {})[0];
          return media?.schema ? schemaType(media.schema) : undefined;
        })();
        return { status, description: oneLine(String(r.description ?? '')), schema };
      });
      ops.push({
        method: m.toUpperCase(),
        path: p,
        operationId: op.operationId,
        summary: op.summary ? oneLine(String(op.summary)) : undefined,
        description: op.description ? String(op.description).trim() : undefined,
        tags: Array.isArray(op.tags) && op.tags.length ? op.tags.map(String) : [],
        params,
        requestBody,
        responses,
        deprecated: !!op.deprecated,
        security: (op.security ?? spec.security)?.flatMap((s: any) => Object.keys(s)),
      });
    }
  }
  const rawSchemas = v2 ? spec.definitions ?? {} : spec.components?.schemas ?? {};
  const schemas: ApiSchema[] = Object.entries<any>(rawSchemas).map(([name, s]) => {
    const req = new Set<string>(s?.required ?? []);
    const props = Object.entries<any>(s?.properties ?? {}).map(([pn, ps]) => ({ name: pn, type: schemaType(ps), required: req.has(pn), description: ps?.description ? oneLine(String(ps.description)) : undefined }));
    return { name, type: schemaType({ ...s, $ref: undefined }), description: s?.description ? oneLine(String(s.description)) : undefined, properties: props, enum: Array.isArray(s?.enum) ? s.enum.map(String) : undefined };
  });
  const securitySchemes = Object.keys(v2 ? spec.securityDefinitions ?? {} : spec.components?.securitySchemes ?? {});
  return {
    title: String(spec.info?.title ?? 'API'),
    version: String(spec.info?.version ?? ''),
    spec: v2 ? `Swagger ${spec.swagger}` : `OpenAPI ${spec.openapi}`,
    description: spec.info?.description ? String(spec.info.description).trim() : undefined,
    servers,
    operations: ops,
    schemas,
    securitySchemes,
  };
}

/** Contract fingerprint per element, used by sync to classify changes (added/removed/changed). */
export function contractSignature(model: ApiModel): Record<string, string> {
  const sig: Record<string, string> = {};
  for (const o of model.operations) sig[`op ${o.method} ${o.path}`] = sha256(stableStringify({ p: o.params, b: o.requestBody, r: o.responses.map((r) => [r.status, r.schema]) })).slice(0, 12);
  for (const s of model.schemas) sig[`schema ${s.name}`] = sha256(stableStringify(s.properties.map((p) => [p.name, p.type, p.required]))).slice(0, 12);
  return sig;
}

export function renderApiReference(model: ApiModel, lang: 'en' | 'es'): string {
  const L = lang === 'es'
    ? { ops: 'Operaciones', models: 'Modelos', servers: 'Servidores', params: 'Parámetros', body: 'Cuerpo de la petición', resp: 'Respuestas', security: 'Seguridad', deprecated: 'Obsoleta' }
    : { ops: 'Operations', models: 'Models', servers: 'Servers', params: 'Parameters', body: 'Request body', resp: 'Responses', security: 'Security', deprecated: 'Deprecated' };
  const out: string[] = [];
  out.push(`**${model.spec}** · version \`${model.version || '?'}\``);
  if (model.description) out.push(model.description);
  if (model.servers.length) out.push(`### ${L.servers}\n\n${model.servers.map((s) => `- \`${s}\``).join('\n')}`);
  if (model.securitySchemes.length) out.push(`### ${L.security}\n\n${model.securitySchemes.map((s) => `- \`${s}\``).join('\n')}`);
  out.push(`## ${L.ops}\n\n${mdTable(['Method', 'Path', 'operationId', 'Summary'], model.operations.map((o) => [`\`${o.method}\``, `\`${o.path}\``, o.operationId ?? '', `${o.deprecated ? `~~${L.deprecated}~~ ` : ''}${o.summary ?? ''}`]))}`);
  const byTag = new Map<string, ApiOperation[]>();
  for (const o of model.operations) for (const t of o.tags.length ? o.tags : ['default']) byTag.set(t, [...(byTag.get(t) ?? []), o]);
  const multiTag = byTag.size > 1;
  for (const [tag, ops] of byTag) {
    if (multiTag) out.push(`## ${tag}`);
    for (const o of ops) {
      const h = multiTag ? '###' : '###';
      const parts = [`${h} ${o.method} ${o.path}`];
      if (o.summary) parts.push(o.summary);
      if (o.description && o.description !== o.summary) parts.push(o.description);
      if (o.deprecated) parts.push(`> [!warning] ${L.deprecated}`);
      if (o.params.length) parts.push(`**${L.params}**\n\n${mdTable(['Name', 'In', 'Type', 'Required', 'Description'], o.params.map((p) => [`\`${p.name}\``, p.in, `\`${p.type}\``, p.required ? 'yes' : 'no', p.description ?? '']))}`);
      if (o.requestBody) parts.push(`**${L.body}**: \`${o.requestBody.contentType}\` → \`${o.requestBody.schema}\`${o.requestBody.required ? ' (required)' : ''}`);
      if (o.responses.length) parts.push(`**${L.resp}**\n\n${mdTable(['Status', 'Description', 'Schema'], o.responses.map((r) => [`\`${r.status}\``, r.description, r.schema ? `\`${r.schema}\`` : '']))}`);
      if (o.security?.length) parts.push(`**${L.security}**: ${o.security.map((s) => `\`${s}\``).join(', ')}`);
      out.push(parts.join('\n\n'));
    }
  }
  if (model.schemas.length) {
    out.push(`## ${L.models}`);
    for (const s of model.schemas) {
      const parts = [`### ${s.name}`];
      if (s.description) parts.push(s.description);
      if (s.enum) parts.push(`Enum: ${s.enum.map((e) => `\`${escapeMdTable(e)}\``).join(', ')}`);
      if (s.properties.length) parts.push(mdTable(['Property', 'Type', 'Required', 'Description'], s.properties.map((p) => [`\`${p.name}\``, `\`${p.type}\``, p.required ? 'yes' : 'no', truncate(p.description ?? '', 160)])));
      else if (!s.enum) parts.push(`Type: \`${s.type}\``);
      out.push(parts.join('\n\n'));
    }
  }
  return out.join('\n\n');
}

export const openapiAnalyzer: Analyzer = {
  id: 'openapi',
  version: '1',
  description: 'OpenAPI 3.x / Swagger 2.0 specifications (JSON or YAML) → API reference, operations, models and contract fingerprints.',
  handles: ['openapi.{json,yaml,yml}', 'swagger.{json,yaml,yml}', 'any JSON/YAML with an openapi/swagger root key'],
  limitations: ['External $ref files are not fetched (reported as unresolved).', 'Callbacks, links and webhooks are not rendered.', 'Schema composition is summarised as type expressions.'],
  match(f, head) {
    if (f.format !== 'json' && f.format !== 'yaml') return 0;
    return /["']?(openapi|swagger)["']?\s*:\s*["']?\d/.test(head) ? 50 : 0;
  },
  analyze(file: FileInfo, ctx): AnalysisResult {
    const res = emptyResult();
    const text = ctx.read(file);
    const parsed = file.format === 'json' ? parseJson(text) : parseYaml(text);
    if (parsed.error || !isOpenApi(parsed.value)) {
      res.warnings.push({ code: 'parse', message: `not a parseable OpenAPI document: ${parsed.error ?? 'missing paths'}`, ref: refOf(file) });
      return res;
    }
    const unresolved = new Set<string>();
    const model = readApiModel(parsed.value, unresolved);
    const key = `api:${file.source}:${file.path}`;
    const body = redactSecrets(renderApiReference(model, ctx.config.language)).text;
    const lossy = unresolved.size ? [`unresolved $ref (${[...unresolved].slice(0, 5).join(', ')}${unresolved.size > 5 ? ', …' : ''})`] : [];
    res.documents.push({
      key, file: refOf(file), title: `${model.title} API`, kind: 'api-spec', category: 'api', body, sections: [], links: [], codeBlocks: [], mermaid: 0,
      tables: 1, admonitions: [], version: model.version || undefined, lossy,
    });
    const sig = contractSignature(model);
    res.entities.push(
      entity({
        key, type: 'api', name: `${model.title} API`, scope: '', summary: model.description ? truncate(oneLine(model.description), 300) : `${model.operations.length} operations, ${model.schemas.length} models`,
        attrs: { spec: model.spec, version: model.version, servers: model.servers, operations: model.operations.map((o) => ({ method: o.method, path: o.path, operationId: o.operationId, summary: o.summary, tags: o.tags })), schemas: model.schemas.map((s) => s.name), contract: sig, specHash: file.hash },
        refs: [refOf(file)], fingerprint: sha256(stableStringify(sig)).slice(0, 16),
      }),
    );
    res.facts.push({ subject: `api-version:${posixBase(file.path)}`, value: model.version, ref: refOf(file), authority: 'manifest' });
    if (lossy.length) res.limitations.push(...lossy);
    return res;
  },
};

export const renderFence = fence;
