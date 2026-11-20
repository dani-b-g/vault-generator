// Configuration & infrastructure analyzers: Docker, Compose, Kubernetes, CI workflows, env templates,
// Makefiles, Terraform, generic JSON/YAML/TOML. They produce operational facts and entities,
// never secret values.
import type { Analyzer, AnalysisResult, FileInfo } from '../types.ts';
import { parseJson, parseToml, parseYaml, parseYamlAll } from '../yaml.ts';
import { redactSecrets } from '../safety.ts';
import { fence, mdTable, oneLine, posixBase, truncate } from '../util.ts';
import { emptyResult, entity, refOf } from './common.ts';

type Kind = 'dockerfile' | 'compose' | 'k8s' | 'github-actions' | 'gitlab-ci' | 'env-template' | 'makefile' | 'terraform' | 'helm-chart' | 'tool-versions' | 'generic';

export function configKind(f: FileInfo, head: string): Kind | undefined {
  const p = f.path.toLowerCase();
  const b = posixBase(p);
  if (b === 'dockerfile' || b === 'containerfile' || b.startsWith('dockerfile.') || b.endsWith('.dockerfile')) return 'dockerfile';
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(b)) return 'compose';
  if (p.startsWith('.github/workflows/') || /\/\.github\/workflows\//.test(p)) return 'github-actions';
  if (b === '.gitlab-ci.yml') return 'gitlab-ci';
  if (/^\.env\.(example|sample|template|dist)$|^(example|sample)\.env$/.test(b)) return 'env-template';
  if (b === 'makefile' || b === 'justfile') return 'makefile';
  if (b.endsWith('.tf')) return 'terraform';
  if (b === 'chart.yaml') return 'helm-chart';
  if (['.nvmrc', '.node-version', '.python-version', '.tool-versions', '.ruby-version', '.java-version'].includes(b)) return 'tool-versions';
  if ((f.format === 'yaml') && /^\s*apiVersion:\s*\S+/m.test(head) && /^\s*kind:\s*\S+/m.test(head)) return 'k8s';
  if (f.format === 'yaml' || f.format === 'toml' || f.format === 'json') return 'generic';
  return undefined;
}

/** Manifests are owned by context detection; generic config files below are only indexed when meaningful. */
const MANIFEST_NAMES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'composer.lock', 'cargo.lock', 'poetry.lock', 'go.sum', 'gemfile.lock',
  'pubspec.lock', 'pubspec.yaml', 'bun.lock', 'cargo.toml', 'pyproject.toml', 'deno.json', 'deno.jsonc', 'mkdocs.yml', 'vault-generator.config.json', '.vault-generator.json',
]);
const NOISE_JSON = /(^|\/)(tsconfig[\w.-]*|jsconfig|\.eslintrc[\w.]*|\.prettierrc[\w.]*|\.babelrc|babel\.config|jest\.config|\.stylelintrc|renovate|\.vscode\/[\w.-]+|\.devcontainer\/[\w.-]+|components|manifest|lerna|nx|turbo|angular|project|workspace|composer|deno|app|vercel|netlify|firebase|\.markdownlint[\w.]*)\.jsonc?$/i;

function dockerfile(text: string, f: FileInfo, res: AnalysisResult) {
  const lines = text.split('\n');
  const stages: { from: string; as?: string; line: number }[] = [];
  const ports: string[] = [];
  const env: string[] = [];
  let cmd: string | undefined;
  lines.forEach((l, i) => {
    const t = l.trim();
    let m: RegExpExecArray | null;
    if ((m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(t))) stages.push({ from: m[1], as: m[2], line: i + 1 });
    else if ((m = /^EXPOSE\s+(.+)$/i.exec(t))) ports.push(...m[1].split(/\s+/));
    else if ((m = /^ENV\s+([A-Za-z_][\w]*)/i.exec(t))) env.push(m[1]);
    else if ((m = /^(CMD|ENTRYPOINT)\s+(.+)$/i.exec(t))) cmd = `${m[1].toUpperCase()} ${m[2]}`;
  });
  for (const p of ports) res.facts.push({ subject: 'port', value: p.replace(/\/\w+$/, ''), ref: refOf(f), authority: 'manifest' });
  for (const s of stages) {
    const m = /^(node|python|golang|openjdk|eclipse-temurin|ruby|php|mcr\.microsoft\.com\/dotnet\/\w+):(\d+(?:\.\d+)*)/i.exec(s.from);
    if (m) res.facts.push({ subject: `runtime:${({ golang: 'go', openjdk: 'java', 'eclipse-temurin': 'java' } as Record<string, string>)[m[1].toLowerCase()] ?? (m[1].includes('dotnet') ? 'dotnet' : m[1].toLowerCase())}`, value: m[2], ref: { ...refOf(f), lines: [s.line, s.line] }, authority: 'manifest' });
  }
  return {
    summary: `Container image built from ${stages.map((s) => `\`${s.from}\``).join(' → ') || 'unknown base'}${ports.length ? `, exposes ${ports.join(', ')}` : ''}`,
    attrs: { stages, ports, env, cmd },
    body: [
      mdTable(['Stage', 'Base image', 'Line'], stages.map((s, i) => [s.as ?? String(i + 1), `\`${s.from}\``, String(s.line)])),
      ports.length ? `**Exposed ports:** ${ports.map((p) => `\`${p}\``).join(', ')}` : '',
      env.length ? `**Environment variables declared:** ${env.map((e) => `\`${e}\``).join(', ')}` : '',
      cmd ? `**Start command:** \`${truncate(cmd, 200)}\`` : '',
    ].filter(Boolean).join('\n\n'),
  };
}

function compose(data: any, f: FileInfo, res: AnalysisResult) {
  const services = Object.entries<any>(data?.services ?? {});
  const rows = services.map(([name, s]) => {
    const ports = (s?.ports ?? []).map((p: any) => (typeof p === 'object' ? `${p.published ?? ''}:${p.target ?? ''}` : String(p)));
    for (const p of ports) {
      const host = /^(?:[\d.]+:)?(\d+)(?::\d+)?/.exec(p)?.[1];
      if (host) res.facts.push({ subject: 'port', value: host, ref: refOf(f), authority: 'manifest', text: `service ${name}` });
    }
    const deps = Array.isArray(s?.depends_on) ? s.depends_on : Object.keys(s?.depends_on ?? {});
    return { name, image: s?.image ?? (s?.build ? `build: ${typeof s.build === 'string' ? s.build : s.build.context ?? '.'}` : ''), ports, deps, envKeys: Array.isArray(s?.environment) ? s.environment.map((e: string) => e.split('=')[0]) : Object.keys(s?.environment ?? {}) };
  });
  return {
    summary: `Compose stack with ${rows.length} service(s): ${rows.map((r) => r.name).join(', ')}`,
    attrs: { services: rows.map((r) => ({ name: r.name, image: r.image, ports: r.ports, dependsOn: r.deps })) },
    body: mdTable(['Service', 'Image / build', 'Ports', 'Depends on', 'Env vars (names only)'], rows.map((r) => [`\`${r.name}\``, r.image ? `\`${r.image}\`` : '', r.ports.join(', '), r.deps.join(', '), r.envKeys.join(', ')])),
  };
}

function k8s(docs: any[]) {
  const rows = docs.filter((d) => d && typeof d === 'object' && d.kind).map((d) => {
    const containers = d.spec?.template?.spec?.containers ?? d.spec?.containers ?? [];
    return { kind: String(d.kind), name: String(d.metadata?.name ?? ''), ns: d.metadata?.namespace ?? '', images: containers.map((c: any) => c.image).filter(Boolean), ports: (d.spec?.ports ?? []).map((p: any) => `${p.port}${p.targetPort ? `→${p.targetPort}` : ''}`) };
  });
  return {
    summary: `Kubernetes manifest: ${rows.map((r) => `${r.kind}/${r.name}`).join(', ')}`,
    attrs: { resources: rows },
    body: mdTable(['Kind', 'Name', 'Namespace', 'Images', 'Ports'], rows.map((r) => [r.kind, `\`${r.name}\``, r.ns, r.images.map((i: string) => `\`${i}\``).join(', '), r.ports.join(', ')])),
  };
}

function githubActions(data: any, f: FileInfo, res: AnalysisResult) {
  const on = data?.on ?? data?.true; // YAML 1.1 "on" → true
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  const jobs = Object.entries<any>(data?.jobs ?? {}).map(([id, j]) => ({ id, name: j?.name ?? id, runsOn: Array.isArray(j?.['runs-on']) ? j['runs-on'].join(', ') : String(j?.['runs-on'] ?? ''), steps: (j?.steps ?? []).map((s: any) => s?.name ?? s?.uses ?? truncate(oneLine(String(s?.run ?? '')), 80)) }));
  const text = JSON.stringify(data);
  for (const m of text.matchAll(/"node-version":"?(\d+(?:\.\w+)*)/g)) res.facts.push({ subject: 'runtime:node', value: m[1], ref: refOf(f), authority: 'manifest' });
  for (const m of text.matchAll(/"python-version":"?(\d+(?:\.\d+)*)/g)) res.facts.push({ subject: 'runtime:python', value: m[1], ref: refOf(f), authority: 'manifest' });
  for (const m of text.matchAll(/(?:npm run|pnpm(?: run)?|yarn)\s+([a-z][\w:.-]*)/g)) if (!['install', 'ci', 'i', 'add'].includes(m[1])) res.facts.push({ subject: `script:${m[1]}`, value: 'used-in-ci', ref: refOf(f), authority: 'manifest' });
  return {
    summary: `CI workflow "${data?.name ?? posixBase(f.path)}" triggered by ${triggers.join(', ') || '?'}`,
    attrs: { triggers, jobs: jobs.map((j) => ({ id: j.id, runsOn: j.runsOn, steps: j.steps.length })) },
    body: [`**Triggers:** ${triggers.map((t: string) => `\`${t}\``).join(', ')}`, ...jobs.map((j) => `### Job \`${j.id}\`${j.name !== j.id ? ` — ${j.name}` : ''}\n\nRuns on \`${j.runsOn}\`\n\n${j.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`)].join('\n\n'),
  };
}

function envTemplate(text: string) {
  const vars = text.split('\n').map((l) => /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => ({ name: m![1], hasDefault: !!m![2].trim() && !/^(["']?)(?:|changeme|xxx+|your[-_].*|<.*>)\1$/i.test(m![2].trim()) }));
  return {
    summary: `Environment template declaring ${vars.length} variable(s)`,
    attrs: { variables: vars.map((v) => v.name) },
    body: mdTable(['Variable', 'Example value provided'], vars.map((v) => [`\`${v.name}\``, v.hasDefault ? 'yes (value not copied)' : 'no'])),
  };
}

function makefile(text: string) {
  const targets = [...text.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)([^\n]*)(?:\n((?:\t[^\n]*\n?)*))?/gm)].filter((m) => !m[1].startsWith('.')).map((m) => ({ name: m[1], deps: m[2].trim(), recipe: (m[3] ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3) }));
  return {
    summary: `Build file with ${targets.length} target(s): ${targets.slice(0, 8).map((t) => t.name).join(', ')}`,
    attrs: { targets: targets.map((t) => t.name) },
    body: mdTable(['Target', 'Prerequisites', 'Recipe (first lines)'], targets.map((t) => [`\`${t.name}\``, t.deps, t.recipe.map((r) => `\`${truncate(r, 80)}\``).join('<br>')])),
  };
}

function terraform(text: string) {
  const blocks = [...text.matchAll(/^(resource|module|data|variable|output|provider)\s+"([^"]+)"(?:\s+"([^"]+)")?/gm)].map((m) => ({ kind: m[1], type: m[2], name: m[3] ?? '' }));
  return {
    summary: `Terraform: ${blocks.filter((b) => b.kind === 'resource').length} resource(s), ${blocks.filter((b) => b.kind === 'module').length} module(s), ${blocks.filter((b) => b.kind === 'variable').length} variable(s)`,
    attrs: { blocks },
    body: mdTable(['Block', 'Type', 'Name'], blocks.map((b) => [b.kind, `\`${b.type}\``, b.name ? `\`${b.name}\`` : ''])),
  };
}

export const configAnalyzer: Analyzer = {
  id: 'config',
  version: '1',
  description: 'Configuration and infrastructure: Dockerfile, Compose, Kubernetes, GitHub Actions, GitLab CI, env templates, Makefile/justfile, Terraform, Helm, runtime version files, generic JSON/YAML/TOML.',
  handles: ['Dockerfile*', 'compose*.yml', 'k8s YAML', '.github/workflows/*.yml', '.gitlab-ci.yml', '.env.example', 'Makefile', '*.tf', 'Chart.yaml', '.nvmrc/.python-version/.tool-versions', '*.json/*.yaml/*.toml'],
  limitations: ['Environment values are never copied, only variable names.', 'Generic JSON/YAML/TOML files are summarised by top-level keys only.', 'Terraform is read at block level (no HCL evaluation).'],
  match(f, head) {
    if (MANIFEST_NAMES.has(posixBase(f.path).toLowerCase())) return 0;
    const k = configKind(f, head);
    if (!k) return 0;
    if (k === 'generic') return NOISE_JSON.test(f.path) ? 0 : 1;
    return 20;
  },
  analyze(file, ctx): AnalysisResult {
    const res = emptyResult();
    const text = ctx.read(file);
    const kind = configKind(file, text.slice(0, 4000))!;
    let out: { summary: string; attrs: Record<string, unknown>; body: string } | undefined;
    try {
      if (kind === 'dockerfile') out = dockerfile(text, file, res);
      else if (kind === 'compose') {
        const y = parseYaml(text);
        if (y.error) throw new Error(y.error);
        out = compose(y.value, file, res);
      } else if (kind === 'k8s') {
        const y = parseYamlAll(text);
        if (y.error) throw new Error(y.error);
        out = k8s(y.value ?? []);
      } else if (kind === 'github-actions' || kind === 'gitlab-ci') {
        const y = parseYaml(text);
        if (y.error) throw new Error(y.error);
        out = kind === 'github-actions' ? githubActions(y.value, file, res) : { summary: `GitLab CI pipeline with stages: ${((y.value as any)?.stages ?? []).join(', ')}`, attrs: { stages: (y.value as any)?.stages ?? [], jobs: Object.keys(y.value ?? {}).filter((k) => !['stages', 'variables', 'default', 'include', 'workflow'].includes(k) && !k.startsWith('.')) }, body: `**Stages:** ${((y.value as any)?.stages ?? []).join(' → ')}\n\n**Jobs:** ${Object.keys(y.value ?? {}).filter((k) => !['stages', 'variables', 'default', 'include', 'workflow'].includes(k) && !k.startsWith('.')).map((j) => `\`${j}\``).join(', ')}` };
      } else if (kind === 'env-template') out = envTemplate(text);
      else if (kind === 'makefile') out = makefile(text);
      else if (kind === 'terraform') out = terraform(text);
      else if (kind === 'tool-versions') {
        const name = posixBase(file.path).replace(/^\./, '').replace(/-version$/, '');
        const entries = name === 'tool-versions' ? text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/)) : [[name === 'nvmrc' || name === 'node' ? 'node' : name, text.trim()]];
        for (const [tool, v] of entries) if (v) res.facts.push({ subject: `runtime:${tool === 'nodejs' ? 'node' : tool}`, value: v, ref: refOf(file), authority: 'manifest' });
        out = { summary: `Pinned tool versions: ${entries.map((e) => e.join(' ')).join(', ')}`, attrs: { versions: Object.fromEntries(entries.map((e) => [e[0], e[1]])) }, body: entries.map((e) => `- \`${e[0]}\` → \`${e[1]}\``).join('\n') };
      } else if (kind === 'helm-chart') {
        const y = parseYaml(text).value as any;
        out = { summary: `Helm chart ${y?.name ?? ''} ${y?.version ?? ''}`, attrs: { name: y?.name, version: y?.version, appVersion: y?.appVersion }, body: mdTable(['Field', 'Value'], [['name', String(y?.name ?? '')], ['version', String(y?.version ?? '')], ['appVersion', String(y?.appVersion ?? '')], ['description', String(y?.description ?? '')]]) };
      } else {
        const parsed = file.format === 'json' ? parseJson(text) : file.format === 'toml' ? parseToml(text) : parseYaml(text);
        if (parsed.error) throw new Error(parsed.error);
        const v = parsed.value as any;
        if (!v || typeof v !== 'object') return res;
        const keys = Array.isArray(v) ? [`array[${v.length}]`] : Object.keys(v);
        if (keys.length === 0) return res;
        const preview = redactSecrets(truncate(text, 1500)).text;
        out = { summary: `${file.format.toUpperCase()} configuration with keys: ${truncate(keys.join(', '), 200)}`, attrs: { keys: keys.slice(0, 50), format: file.format }, body: `**Top-level keys:** ${keys.slice(0, 50).map((k) => `\`${k}\``).join(', ')}\n\n${fence(preview + (text.length > 1500 ? '\n# … truncated' : ''), file.format === 'toml' ? 'toml' : file.format)}` };
      }
    } catch (e) {
      res.warnings.push({ code: 'parse', message: `could not parse ${kind}: ${(e as Error).message}`, ref: refOf(file) });
      return res;
    }
    if (!out) return res;
    const key = `config:${file.source}:${file.path}`;
    const title = `${posixBase(file.path)}${kind === 'generic' ? '' : ` (${kind})`}`;
    res.entities.push(entity({ key, type: 'configuration', name: title, scope: '', summary: out.summary, attrs: { configKind: kind, ...out.attrs }, refs: [refOf(file)] }));
    res.documents.push({ key, file: refOf(file), title, kind: 'config', category: kind === 'generic' ? 'configuration' : ['dockerfile', 'compose', 'k8s', 'terraform', 'helm-chart'].includes(kind) ? 'infrastructure' : kind === 'github-actions' || kind === 'gitlab-ci' ? 'ci' : 'configuration', body: redactSecrets(out.body).text, sections: [], links: [], codeBlocks: [], mermaid: 0, tables: 1, admonitions: [], lossy: [] });
    return res;
  },
};
