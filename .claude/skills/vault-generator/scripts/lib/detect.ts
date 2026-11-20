// Context detection: evidence-based identification of repositories, workspaces, projects,
// documentation sources and existing vaults. Folder names are only weak hints; manifests,
// workspace configuration and declared dependencies are the evidence.
import fs from 'node:fs';
import path from 'node:path';
import type { Config, ContextKind, ContextReport, Dependency, DocSourceInfo, ProjectInfo, ProjectKind, Tech, WorkspaceInfo } from './types.ts';
import { listTree, classify } from './scan.ts';
import { parseJson, parseToml, parseYaml } from './yaml.ts';
import { compareVersions, matchGlob, normalizeText, posixDir, slugify, toPosix, uniq } from './util.ts';

// ── recognition tables (labels for declared dependencies; unknown deps are still listed) ──
const NODE_TECH: Record<string, { name: string; role: 'frontend' | 'backend' | 'fullstack' | 'mobile' | 'desktop' | 'docs' | 'test' | 'build' | 'lang' | 'data' }> = {
  react: { name: 'React', role: 'frontend' }, 'react-dom': { name: 'React DOM', role: 'frontend' }, vue: { name: 'Vue', role: 'frontend' },
  '@angular/core': { name: 'Angular', role: 'frontend' }, svelte: { name: 'Svelte', role: 'frontend' }, 'solid-js': { name: 'SolidJS', role: 'frontend' },
  preact: { name: 'Preact', role: 'frontend' }, lit: { name: 'Lit', role: 'frontend' }, 'react-scripts': { name: 'Create React App', role: 'frontend' },
  next: { name: 'Next.js', role: 'fullstack' }, nuxt: { name: 'Nuxt', role: 'fullstack' }, '@sveltejs/kit': { name: 'SvelteKit', role: 'fullstack' },
  '@remix-run/react': { name: 'Remix', role: 'fullstack' }, astro: { name: 'Astro', role: 'fullstack' }, gatsby: { name: 'Gatsby', role: 'frontend' },
  express: { name: 'Express', role: 'backend' }, fastify: { name: 'Fastify', role: 'backend' }, koa: { name: 'Koa', role: 'backend' },
  hono: { name: 'Hono', role: 'backend' }, '@nestjs/core': { name: 'NestJS', role: 'backend' }, '@hapi/hapi': { name: 'hapi', role: 'backend' },
  'apollo-server': { name: 'Apollo Server', role: 'backend' }, '@apollo/server': { name: 'Apollo Server', role: 'backend' }, graphql: { name: 'GraphQL', role: 'data' },
  prisma: { name: 'Prisma', role: 'data' }, '@prisma/client': { name: 'Prisma', role: 'data' }, typeorm: { name: 'TypeORM', role: 'data' },
  mongoose: { name: 'Mongoose', role: 'data' }, sequelize: { name: 'Sequelize', role: 'data' }, 'drizzle-orm': { name: 'Drizzle ORM', role: 'data' },
  electron: { name: 'Electron', role: 'desktop' }, 'react-native': { name: 'React Native', role: 'mobile' }, expo: { name: 'Expo', role: 'mobile' },
  '@ionic/angular': { name: 'Ionic', role: 'mobile' }, '@capacitor/core': { name: 'Capacitor', role: 'mobile' },
  typescript: { name: 'TypeScript', role: 'lang' }, vite: { name: 'Vite', role: 'build' }, webpack: { name: 'webpack', role: 'build' },
  esbuild: { name: 'esbuild', role: 'build' }, rollup: { name: 'Rollup', role: 'build' }, tsup: { name: 'tsup', role: 'build' },
  jest: { name: 'Jest', role: 'test' }, vitest: { name: 'Vitest', role: 'test' }, mocha: { name: 'Mocha', role: 'test' },
  '@playwright/test': { name: 'Playwright', role: 'test' }, cypress: { name: 'Cypress', role: 'test' }, karma: { name: 'Karma', role: 'test' },
  '@docusaurus/core': { name: 'Docusaurus', role: 'docs' }, vitepress: { name: 'VitePress', role: 'docs' }, typedoc: { name: 'TypeDoc', role: 'docs' },
  '@compodoc/compodoc': { name: 'Compodoc', role: 'docs' }, storybook: { name: 'Storybook', role: 'docs' }, '@storybook/react': { name: 'Storybook', role: 'docs' },
};
const PY_TECH: Record<string, { name: string; role: string }> = {
  django: { name: 'Django', role: 'backend' }, flask: { name: 'Flask', role: 'backend' }, fastapi: { name: 'FastAPI', role: 'backend' },
  starlette: { name: 'Starlette', role: 'backend' }, aiohttp: { name: 'aiohttp', role: 'backend' }, tornado: { name: 'Tornado', role: 'backend' },
  sqlalchemy: { name: 'SQLAlchemy', role: 'data' }, pydantic: { name: 'Pydantic', role: 'data' }, celery: { name: 'Celery', role: 'backend' },
  pytest: { name: 'pytest', role: 'test' }, numpy: { name: 'NumPy', role: 'data' }, pandas: { name: 'pandas', role: 'data' },
  torch: { name: 'PyTorch', role: 'data' }, tensorflow: { name: 'TensorFlow', role: 'data' }, streamlit: { name: 'Streamlit', role: 'frontend' },
  click: { name: 'Click', role: 'cli' }, typer: { name: 'Typer', role: 'cli' }, mkdocs: { name: 'MkDocs', role: 'docs' }, sphinx: { name: 'Sphinx', role: 'docs' },
};
const BACKEND_NODE = new Set(['express', 'fastify', 'koa', 'hono', '@nestjs/core', '@hapi/hapi', 'apollo-server', '@apollo/server']);
const FRONTEND_APP_NODE = new Set(['next', 'nuxt', '@sveltejs/kit', '@remix-run/react', 'astro', 'gatsby', 'react-scripts', 'expo', 'react-native', 'electron']);
const DOCS_NODE = new Set(['@docusaurus/core', 'vitepress']);

const DOC_DIR_HINT = /^(docs?|documentation|wiki|guides?|handbook|manual|website|site|book|knowledge|kb|adr|adrs|decisions|rfcs?)$/i;
const EXAMPLE_DIR_HINT = /^(examples?|samples?|demos?|playground|sandbox|showcase|starters?|templates?)$/i;
const VERSION_DIR = /^(?:v|version-)?\d+(?:\.\d+){0,2}(?:\.x)?$/i;

interface Ctx {
  root: string;
  config: Config;
  files: string[];
  fileSet: Set<string>;
  evidence: ContextReport['evidence'];
}
const readRel = (c: Ctx, rel: string, max = 1_000_000): string | undefined => {
  try {
    const abs = path.join(c.root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > max) return undefined;
    return normalizeText(fs.readFileSync(abs, 'utf8'));
  } catch {
    return undefined;
  }
};
const has = (c: Ctx, rel: string) => c.fileSet.has(rel);
const join = (dir: string, f: string) => (dir && dir !== '.' ? `${dir}/${f}` : f);
const filesUnder = (c: Ctx, dir: string) => (dir === '.' || !dir ? c.files : c.files.filter((f) => f.startsWith(`${dir}/`)));

// ── project builders per ecosystem ──
function newProject(name: string, dir: string, ecosystem: string, manifest: string): ProjectInfo {
  return {
    id: '', name, path: dir || '.', ecosystem, kind: 'unknown', kindEvidence: [], frameworks: [], languages: [], dependencies: [],
    scripts: {}, entryPoints: [], manifests: [manifest],
  };
}
function deps(obj: unknown, kind: Dependency['kind'], ev: string): Dependency[] {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>).map(([name, range]) => ({
    name, range: typeof range === 'string' ? range : typeof range === 'object' && range && 'version' in range ? String((range as { version: unknown }).version) : undefined,
    kind, evidence: { ref: { source: '', path: ev } },
  }));
}

function nodeProject(c: Ctx, rel: string): ProjectInfo | undefined {
  const pj = parseJson(readRel(c, rel) ?? '').value as Record<string, any> | undefined;
  if (!pj || typeof pj !== 'object') return undefined;
  const dir = posixDir(rel);
  const p = newProject(String(pj.name ?? path.posix.basename(dir || path.basename(c.root))), dir, 'node', rel);
  p.version = typeof pj.version === 'string' ? pj.version : undefined;
  p.description = typeof pj.description === 'string' ? pj.description : undefined;
  p.private = pj.private === true;
  p.scripts = typeof pj.scripts === 'object' && pj.scripts ? Object.fromEntries(Object.entries(pj.scripts).map(([k, v]) => [k, String(v)])) : {};
  p.dependencies = [...deps(pj.dependencies, 'prod', rel), ...deps(pj.devDependencies, 'dev', rel), ...deps(pj.peerDependencies, 'peer', rel), ...deps(pj.optionalDependencies, 'optional', rel)];
  const all = new Set(p.dependencies.map((d) => d.name));
  for (const d of p.dependencies) {
    const t = NODE_TECH[d.name];
    if (t && !p.frameworks.some((f) => f.name === t.name)) p.frameworks.push({ name: t.name, version: d.range, evidence: `${rel} → ${d.kind === 'prod' ? 'dependencies' : `${d.kind}Dependencies`}.${d.name}` });
  }
  if (pj.engines?.node) p.frameworks.push({ name: 'Node.js', version: String(pj.engines.node), evidence: `${rel} → engines.node` });
  for (const k of ['main', 'module', 'types', 'browser']) if (typeof pj[k] === 'string') p.entryPoints.push(join(dir, String(pj[k]).replace(/^\.\//, '')));
  if (typeof pj.bin === 'string') p.entryPoints.push(join(dir, pj.bin.replace(/^\.\//, '')));
  else if (pj.bin && typeof pj.bin === 'object') for (const v of Object.values(pj.bin)) p.entryPoints.push(join(dir, String(v).replace(/^\.\//, '')));
  if (typeof pj.exports === 'string') p.entryPoints.push(join(dir, pj.exports.replace(/^\.\//, '')));
  // kind
  const ev = p.kindEvidence;
  const hasBin = !!pj.bin;
  const publishes = !p.private && (pj.main || pj.exports || pj.module || pj.types);
  const backend = [...all].filter((d) => BACKEND_NODE.has(d));
  const front = [...all].filter((d) => FRONTEND_APP_NODE.has(d));
  const docs = [...all].filter((d) => DOCS_NODE.has(d));
  if (docs.length) {
    p.kind = 'docs';
    ev.push(`declares documentation framework: ${docs.join(', ')}`);
  } else if (hasBin && !front.length && !backend.length) {
    p.kind = 'cli';
    ev.push(`${rel} declares "bin"`);
  } else if (backend.length && !publishes) {
    p.kind = 'service';
    ev.push(`depends on server framework: ${backend.join(', ')}`);
  } else if (front.length && !publishes) {
    p.kind = 'application';
    ev.push(`depends on application framework: ${front.join(', ')}`);
  } else if (publishes) {
    p.kind = 'library';
    ev.push(`${rel} is publishable (${pj.exports ? 'exports' : pj.main ? 'main' : 'module/types'}${p.private ? '' : ', not private'})`);
  } else if ((all.has('vite') || all.has('webpack') || all.has('@angular/core') || all.has('vue') || all.has('react')) && (has(c, join(dir, 'index.html')) || has(c, join(dir, 'src/index.html')) || has(c, join(dir, 'public/index.html')))) {
    p.kind = 'application';
    ev.push('frontend toolchain with an index.html entry');
  } else if (p.scripts.start || p.scripts.serve) {
    p.kind = 'application';
    ev.push(`has a "${p.scripts.start ? 'start' : 'serve'}" script`);
  } else if (p.private) {
    p.kind = 'package';
    ev.push('private package without app/server signals');
  }
  return p;
}

function pythonProject(c: Ctx, dir: string): ProjectInfo | undefined {
  const pyproject = has(c, join(dir, 'pyproject.toml')) ? join(dir, 'pyproject.toml') : undefined;
  const manifests: string[] = [];
  let name: string | undefined;
  let version: string | undefined;
  let description: string | undefined;
  const dl: Dependency[] = [];
  const scripts: Record<string, string> = {};
  if (pyproject) {
    manifests.push(pyproject);
    const t = parseToml(readRel(c, pyproject) ?? '').value ?? {};
    const proj = t.project ?? {};
    const poetry = t.tool?.poetry ?? {};
    name = proj.name ?? poetry.name;
    version = proj.version ?? poetry.version;
    description = proj.description ?? poetry.description;
    for (const s of Array.isArray(proj.dependencies) ? proj.dependencies : []) {
      const m = /^\s*([A-Za-z0-9_.\-[\]]+)\s*(.*)$/.exec(String(s));
      if (m) dl.push({ name: m[1].replace(/\[.*\]/, '').toLowerCase(), range: m[2].trim() || undefined, kind: 'prod', evidence: { ref: { source: '', path: pyproject } } });
    }
    for (const [k, v] of Object.entries(poetry.dependencies ?? {})) if (k !== 'python') dl.push({ name: k.toLowerCase(), range: typeof v === 'string' ? v : undefined, kind: 'prod', evidence: { ref: { source: '', path: pyproject } } });
    for (const [k, v] of Object.entries({ ...(proj.scripts ?? {}), ...(poetry.scripts ?? {}) })) scripts[k] = String(v);
  }
  for (const req of ['requirements.txt', 'requirements/base.txt', 'requirements-dev.txt']) {
    const r = join(dir, req);
    if (!has(c, r)) continue;
    manifests.push(r);
    for (const line of (readRel(c, r) ?? '').split('\n')) {
      const m = /^\s*([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*([<>=!~][^#;]*)?/.exec(line);
      if (m && !line.trim().startsWith('#') && !line.trim().startsWith('-')) dl.push({ name: m[1].toLowerCase(), range: m[2]?.trim(), kind: req.includes('dev') ? 'dev' : 'prod', evidence: { ref: { source: '', path: r } } });
    }
  }
  if (has(c, join(dir, 'setup.py'))) {
    manifests.push(join(dir, 'setup.py'));
    const s = readRel(c, join(dir, 'setup.py')) ?? '';
    name ??= /name\s*=\s*["']([^"']+)/.exec(s)?.[1];
    version ??= /version\s*=\s*["']([^"']+)/.exec(s)?.[1];
  }
  if (!manifests.length) return undefined;
  const p = newProject(name ?? path.posix.basename(dir || path.basename(c.root)), dir, 'python', manifests[0]);
  p.manifests = manifests;
  p.version = version;
  p.description = description;
  p.dependencies = dl;
  p.scripts = scripts;
  for (const d of dl) {
    const t = PY_TECH[d.name];
    if (t && !p.frameworks.some((f) => f.name === t.name)) p.frameworks.push({ name: t.name, version: d.range, evidence: `${d.evidence.ref.path} → ${d.name}` });
  }
  const names = new Set(dl.map((d) => d.name));
  const local = filesUnder(c, dir);
  if (has(c, join(dir, 'manage.py'))) {
    p.kind = 'service';
    p.kindEvidence.push('Django manage.py present');
    p.entryPoints.push(join(dir, 'manage.py'));
  } else if (['fastapi', 'flask', 'django', 'aiohttp', 'starlette', 'tornado'].some((n) => names.has(n))) {
    p.kind = 'service';
    p.kindEvidence.push(`depends on web framework: ${['fastapi', 'flask', 'django', 'aiohttp', 'starlette', 'tornado'].filter((n) => names.has(n)).join(', ')}`);
  } else if (Object.keys(scripts).length) {
    p.kind = 'cli';
    p.kindEvidence.push('declares console scripts');
  } else if (pyproject) {
    p.kind = 'library';
    p.kindEvidence.push('pyproject without app signals');
  }
  for (const f of ['main.py', 'app.py', 'wsgi.py', 'asgi.py', '__main__.py', 'src/main.py', 'app/main.py']) if (local.includes(join(dir, f))) p.entryPoints.push(join(dir, f));
  return p;
}

function goProject(c: Ctx, rel: string): ProjectInfo | undefined {
  const txt = readRel(c, rel);
  if (!txt) return undefined;
  const dir = posixDir(rel);
  const mod = /^module\s+(\S+)/m.exec(txt)?.[1];
  const p = newProject(mod ?? path.posix.basename(dir), dir, 'go', rel);
  const goVer = /^go\s+(\S+)/m.exec(txt)?.[1];
  if (goVer) p.frameworks.push({ name: 'Go', version: goVer, evidence: `${rel} → go directive` });
  const req = /require\s*\(([\s\S]*?)\)/m.exec(txt)?.[1] ?? '';
  for (const line of [...req.split('\n'), ...[...txt.matchAll(/^require\s+(\S+\s+\S+)/gm)].map((m) => m[1])]) {
    const m = /^\s*(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/.exec(line);
    if (m) p.dependencies.push({ name: m[1], range: m[2], kind: m[3] ? 'optional' : 'prod', evidence: { ref: { source: '', path: rel } } });
  }
  for (const m of txt.matchAll(/^replace\s+(\S+)(?:\s+\S+)?\s+=>\s+(\.\.?\/\S+)/gm)) p.dependencies.push({ name: m[1], range: m[2], kind: 'build', evidence: { ref: { source: '', path: rel } } });
  const local = filesUnder(c, dir);
  const mains = local.filter((f) => f.endsWith('/main.go') || f === 'main.go');
  if (mains.length) {
    p.kind = 'application';
    p.kindEvidence.push(`main package files: ${mains.slice(0, 3).join(', ')}`);
    p.entryPoints.push(...mains.slice(0, 10));
  } else {
    p.kind = 'library';
    p.kindEvidence.push('Go module without main.go');
  }
  const known: Record<string, string> = { 'github.com/gin-gonic/gin': 'Gin', 'github.com/labstack/echo/v4': 'Echo', 'github.com/gofiber/fiber/v2': 'Fiber', 'github.com/go-chi/chi/v5': 'chi', 'google.golang.org/grpc': 'gRPC', 'github.com/spf13/cobra': 'Cobra' };
  for (const d of p.dependencies) if (known[d.name]) p.frameworks.push({ name: known[d.name], version: d.range, evidence: `${rel} → require ${d.name}` });
  if (p.frameworks.some((f) => ['Gin', 'Echo', 'Fiber', 'chi', 'gRPC'].includes(f.name)) && p.kind === 'application') p.kind = 'service';
  return p;
}

function rustProject(c: Ctx, rel: string): ProjectInfo | undefined {
  const t = parseToml(readRel(c, rel) ?? '').value;
  if (!t?.package) return undefined;
  const dir = posixDir(rel);
  const p = newProject(String(t.package.name), dir, 'rust', rel);
  p.version = typeof t.package.version === 'string' ? t.package.version : undefined;
  p.description = t.package.description;
  for (const [sec, kind] of [['dependencies', 'prod'], ['dev-dependencies', 'dev'], ['build-dependencies', 'build']] as const) {
    for (const [n, v] of Object.entries(t[sec] ?? {})) {
      const vv = v as any;
      p.dependencies.push({ name: n, range: typeof vv === 'string' ? vv : vv?.path ? `path:${vv.path}` : vv?.version, kind, evidence: { ref: { source: '', path: rel } } });
    }
  }
  const isBin = has(c, join(dir, 'src/main.rs')) || Array.isArray(t.bin);
  const isLib = has(c, join(dir, 'src/lib.rs')) || !!t.lib;
  p.kind = isBin && !isLib ? 'application' : isLib ? 'library' : 'unknown';
  p.kindEvidence.push(isBin ? 'binary target (src/main.rs or a bin section)' : isLib ? 'library target (src/lib.rs or a lib section)' : 'no bin/lib target found');
  if (has(c, join(dir, 'src/main.rs'))) p.entryPoints.push(join(dir, 'src/main.rs'));
  if (has(c, join(dir, 'src/lib.rs'))) p.entryPoints.push(join(dir, 'src/lib.rs'));
  const known: Record<string, string> = { tokio: 'Tokio', axum: 'Axum', 'actix-web': 'Actix Web', rocket: 'Rocket', serde: 'Serde', clap: 'clap', tonic: 'tonic (gRPC)' };
  for (const d of p.dependencies) if (known[d.name]) p.frameworks.push({ name: known[d.name], version: d.range, evidence: `${rel} → ${d.name}` });
  if (p.kind === 'application' && p.dependencies.some((d) => ['axum', 'actix-web', 'rocket', 'tonic', 'warp'].includes(d.name))) p.kind = 'service';
  return p;
}

const xmlTag = (s: string, tag: string) => new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(s)?.[1];
function mavenProject(c: Ctx, rel: string): ProjectInfo | undefined {
  const x = readRel(c, rel);
  if (!x) return undefined;
  const dir = posixDir(rel);
  const noParent = x.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<dependencies>[\s\S]*<\/dependencies>/, '').replace(/<build>[\s\S]*<\/build>/, '');
  const artifact = xmlTag(noParent, 'artifactId');
  const p = newProject(artifact ?? path.posix.basename(dir), dir, 'jvm', rel);
  p.version = xmlTag(noParent, 'version') ?? xmlTag(/<parent>([\s\S]*?)<\/parent>/.exec(x)?.[1] ?? '', 'version');
  p.description = xmlTag(noParent, 'description');
  const group = xmlTag(noParent, 'groupId') ?? xmlTag(/<parent>([\s\S]*?)<\/parent>/.exec(x)?.[1] ?? '', 'groupId');
  if (group) p.name = `${group}:${p.name}`;
  for (const m of x.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const a = xmlTag(m[1], 'artifactId');
    if (a) p.dependencies.push({ name: `${xmlTag(m[1], 'groupId') ?? ''}:${a}`, range: xmlTag(m[1], 'version'), kind: xmlTag(m[1], 'scope') === 'test' ? 'dev' : 'prod', evidence: { ref: { source: '', path: rel } } });
  }
  const packaging = xmlTag(noParent, 'packaging') ?? 'jar';
  const javaVer = /<(?:java\.version|maven\.compiler\.release|maven\.compiler\.source)>([^<]+)</.exec(x)?.[1];
  if (javaVer) p.frameworks.push({ name: 'Java', version: javaVer, evidence: `${rel} → properties` });
  if (/spring-boot/.test(x)) {
    p.frameworks.push({ name: 'Spring Boot', version: /spring-boot[\s\S]{0,200}?<version>([^<]+)</.exec(x)?.[1], evidence: `${rel} → spring-boot` });
    p.kind = /spring-boot-maven-plugin/.test(x) ? 'service' : 'library';
    p.kindEvidence.push(p.kind === 'service' ? 'spring-boot-maven-plugin builds an executable' : 'Spring Boot dependency without the boot plugin');
  } else if (packaging === 'pom') {
    p.kind = 'package';
    p.kindEvidence.push('Maven aggregator (packaging pom)');
  } else if (packaging === 'war') {
    p.kind = 'application';
    p.kindEvidence.push('packaging war');
  } else {
    p.kind = 'library';
    p.kindEvidence.push(`packaging ${packaging}`);
  }
  return p;
}

function gradleProject(c: Ctx, rel: string): ProjectInfo | undefined {
  const g = readRel(c, rel);
  if (g === undefined) return undefined;
  const dir = posixDir(rel);
  const p = newProject(path.posix.basename(dir || path.basename(c.root)), dir, 'jvm', rel);
  for (const m of g.matchAll(/(implementation|api|compileOnly|runtimeOnly|testImplementation|kapt|ksp)\s*\(?\s*["']([^"':]+:[^"':]+)(?::([^"']+))?["']/g)) {
    p.dependencies.push({ name: m[2], range: m[3], kind: m[1].startsWith('test') ? 'dev' : 'prod', evidence: { ref: { source: '', path: rel } } });
  }
  for (const m of g.matchAll(/(implementation|api)\s*\(?\s*project\s*\(\s*["']:?([^"']+)["']/g)) {
    p.dependencies.push({ name: `project:${m[2].replace(/:/g, '/')}`, kind: 'prod', evidence: { ref: { source: '', path: rel } } });
  }
  if (/com\.android\.application/.test(g)) {
    p.kind = 'application';
    p.kindEvidence.push('Android application plugin');
    p.frameworks.push({ name: 'Android', evidence: `${rel} → com.android.application` });
  } else if (/org\.springframework\.boot/.test(g)) {
    p.kind = 'service';
    p.kindEvidence.push('Spring Boot Gradle plugin');
    p.frameworks.push({ name: 'Spring Boot', evidence: `${rel} → org.springframework.boot` });
  } else if (/\bapplication\b\s*(\{|$)|id\s*\(?\s*["']application["']/m.test(g)) {
    p.kind = 'application';
    p.kindEvidence.push('Gradle application plugin');
  } else if (/java-library|com\.android\.library|`java-library`/.test(g)) {
    p.kind = 'library';
    p.kindEvidence.push('java-library / android library plugin');
  }
  if (/kotlin/.test(g)) p.frameworks.push({ name: 'Kotlin', evidence: `${rel} → kotlin plugin` });
  const ver = /^\s*version\s*=\s*["']([^"']+)/m.exec(g)?.[1];
  if (ver) p.version = ver;
  return p;
}

function dotnetProject(c: Ctx, rel: string): ProjectInfo | undefined {
  const x = readRel(c, rel);
  if (!x) return undefined;
  const dir = posixDir(rel);
  const p = newProject(path.posix.basename(rel).replace(/\.(cs|fs|vb)proj$/, ''), dir, 'dotnet', rel);
  for (const m of x.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) p.dependencies.push({ name: m[1], range: m[2], kind: 'prod', evidence: { ref: { source: '', path: rel } } });
  for (const m of x.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) p.dependencies.push({ name: `project:${path.posix.basename(toPosix(m[1])).replace(/\.(cs|fs|vb)proj$/, '')}`, range: toPosix(m[1]), kind: 'prod', evidence: { ref: { source: '', path: rel } } });
  const tf = xmlTag(x, 'TargetFramework') ?? xmlTag(x, 'TargetFrameworks');
  if (tf) p.frameworks.push({ name: '.NET', version: tf, evidence: `${rel} → TargetFramework` });
  p.version = xmlTag(x, 'Version');
  if (/Sdk="Microsoft\.NET\.Sdk\.Web"/.test(x)) {
    p.kind = 'service';
    p.kindEvidence.push('Microsoft.NET.Sdk.Web');
    p.frameworks.push({ name: 'ASP.NET Core', version: tf, evidence: `${rel} → Sdk.Web` });
  } else if (/<OutputType>\s*(Exe|WinExe)\s*</.test(x)) {
    p.kind = 'application';
    p.kindEvidence.push('OutputType Exe');
  } else {
    p.kind = 'library';
    p.kindEvidence.push('class library (no OutputType Exe)');
  }
  if (/IsTestProject>true|Microsoft\.NET\.Test\.Sdk/.test(x)) {
    p.kind = 'package';
    p.kindEvidence.push('test project');
  }
  return p;
}

function genericManifest(c: Ctx, rel: string, ecosystem: string, read: (txt: string) => Partial<ProjectInfo> | undefined): ProjectInfo | undefined {
  const txt = readRel(c, rel);
  if (txt === undefined) return undefined;
  const info = read(txt);
  if (!info) return undefined;
  const dir = posixDir(rel);
  const p = newProject(info.name ?? path.posix.basename(dir || path.basename(c.root)), dir, ecosystem, rel);
  Object.assign(p, { ...info, path: dir || '.', manifests: [rel], kindEvidence: info.kindEvidence ?? [], frameworks: info.frameworks ?? [], dependencies: info.dependencies ?? [] });
  return p;
}

// ── workspace detection ──
function detectWorkspaces(c: Ctx): WorkspaceInfo[] {
  const ws: WorkspaceInfo[] = [];
  const add = (tool: string, p: string, globs: string[], evidence: string) => ws.push({ tool, path: p || '.', globs, evidence });
  for (const f of c.files) {
    const base = path.posix.basename(f);
    const dir = posixDir(f);
    if (base === 'package.json') {
      const pj = parseJson(readRel(c, f) ?? '').value as any;
      const w = Array.isArray(pj?.workspaces) ? pj.workspaces : Array.isArray(pj?.workspaces?.packages) ? pj.workspaces.packages : undefined;
      if (w) add(has(c, join(dir, 'yarn.lock')) ? 'yarn-workspaces' : has(c, join(dir, 'bun.lockb')) || has(c, join(dir, 'bun.lock')) ? 'bun-workspaces' : 'npm-workspaces', dir, w.map(String), `${f} → workspaces`);
    } else if (base === 'pnpm-workspace.yaml') {
      const y = parseYaml(readRel(c, f) ?? '').value as any;
      add('pnpm', dir, Array.isArray(y?.packages) ? y.packages.map(String) : ['**'], `${f} → packages`);
    } else if (base === 'lerna.json') {
      const l = parseJson(readRel(c, f) ?? '').value as any;
      add('lerna', dir, Array.isArray(l?.packages) ? l.packages : ['packages/*'], `${f}`);
    } else if (base === 'nx.json') add('nx', dir, [], `${f}`);
    else if (base === 'turbo.json') add('turborepo', dir, [], `${f}`);
    else if (base === 'rush.json') {
      const r = parseJson(readRel(c, f) ?? '').value as any;
      add('rush', dir, (r?.projects ?? []).map((p: any) => String(p.projectFolder)), `${f} → projects`);
    } else if (base === 'angular.json' || base === 'workspace.json') {
      const a = parseJson(readRel(c, f) ?? '').value as any;
      const projs = a?.projects && typeof a.projects === 'object' ? Object.values(a.projects) : [];
      if (projs.length > 1 || base === 'workspace.json') add(base === 'angular.json' ? 'angular-cli' : 'nx', dir, projs.map((p: any) => String(typeof p === 'string' ? p : p?.root ?? '')).filter(Boolean), `${f} → projects`);
    } else if (base === 'go.work') {
      const g = readRel(c, f) ?? '';
      const uses = [...(/use\s*\(([\s\S]*?)\)/.exec(g)?.[1] ?? '').split('\n'), ...[...g.matchAll(/^use\s+(\S+)/gm)].map((m) => m[1])].map((s) => s.trim().replace(/^\.\//, '')).filter((s) => s && !s.startsWith('//'));
      add('go-work', dir, uses, `${f} → use`);
    } else if (base === 'Cargo.toml') {
      const t = parseToml(readRel(c, f) ?? '').value;
      if (t?.workspace) add('cargo-workspace', dir, (t.workspace.members ?? []).map(String), `${f} → [workspace].members`);
    } else if (base === 'pom.xml') {
      const x = readRel(c, f) ?? '';
      const mods = [...(/<modules>([\s\S]*?)<\/modules>/.exec(x)?.[1] ?? '').matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]);
      if (mods.length) add('maven-multimodule', dir, mods, `${f} → <modules>`);
    } else if (base === 'settings.gradle' || base === 'settings.gradle.kts') {
      const s = readRel(c, f) ?? '';
      const inc = [...s.matchAll(/include\s*\(?\s*((?:["'][^"']+["']\s*,?\s*)+)\)?/g)].flatMap((m) => [...m[1].matchAll(/["']:?([^"']+)["']/g)].map((x) => x[1].replace(/:/g, '/')));
      if (inc.length) add('gradle-multiproject', dir, inc, `${f} → include`);
    } else if (base.endsWith('.sln')) {
      const s = readRel(c, f) ?? '';
      const projs = [...s.matchAll(/Project\("[^"]+"\)\s*=\s*"[^"]*",\s*"([^"]+\.(?:cs|fs|vb)proj)"/g)].map((m) => posixDir(toPosix(m[1])));
      if (projs.length > 1) add('dotnet-solution', dir, projs, `${f} → Project entries`);
    } else if (base === 'pyproject.toml') {
      const t = parseToml(readRel(c, f) ?? '').value;
      const m = t?.tool?.uv?.workspace?.members;
      if (Array.isArray(m)) add('uv-workspace', dir, m.map(String), `${f} → tool.uv.workspace.members`);
    } else if (base === 'deno.json' || base === 'deno.jsonc') {
      const d = parseJson(readRel(c, f) ?? '').value as any;
      if (Array.isArray(d?.workspace)) add('deno-workspace', dir, d.workspace.map((s: string) => s.replace(/^\.\//, '')), `${f} → workspace`);
    } else if (base === '.gitmodules') {
      const s = readRel(c, f) ?? '';
      add('git-submodules', dir, [...s.matchAll(/path\s*=\s*(\S+)/g)].map((m) => m[1]), `${f}`);
    }
  }
  return ws;
}

function inWorkspaceGlobs(ws: WorkspaceInfo, projectPath: string): boolean {
  if (!ws.globs.length) return projectPath === ws.path || ws.path === '.' || projectPath.startsWith(`${ws.path}/`);
  const rel = ws.path === '.' ? projectPath : projectPath.startsWith(`${ws.path}/`) ? projectPath.slice(ws.path.length + 1) : undefined;
  if (rel === undefined) return false;
  let ok = false;
  for (const g of ws.globs) {
    const neg = g.startsWith('!');
    const pat = g.replace(/^!/, '').replace(/^\.\//, '').replace(/\/$/, '');
    // workspace globs match the directory itself (not its children)
    const re = new RegExp(`^${pat.split('/').map((s) => (s === '**' ? '.*' : s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))).join('/')}$`);
    if (re.test(rel) || (pat === '**' && rel)) ok = !neg;
  }
  return ok;
}

// ── documentation sources ──
function detectDocs(c: Ctx, projects: ProjectInfo[]): DocSourceInfo[] {
  const docFiles = c.files.filter((f) => ['markdown', 'html', 'text', 'mermaid'].includes(classify(f).format));
  const byTop = new Map<string, string[]>();
  for (const f of docFiles) {
    const parts = f.split('/');
    // group by the first directory that looks like a doc root, else by its first two segments
    let key = '';
    for (let i = 0; i < parts.length - 1; i++) {
      if (DOC_DIR_HINT.test(parts[i]) || parts[i] === 'versioned_docs') {
        key = parts.slice(0, i + 1).join('/');
        break;
      }
    }
    if (!key) key = parts.length === 1 ? '.' : posixDir(f);
    const l = byTop.get(key);
    if (l) l.push(f);
    else byTop.set(key, [f]);
  }
  const out: DocSourceInfo[] = [];
  for (const [dir, list] of byTop) {
    if (dir === '.') continue; // root-level documents are added once below
    const isHint = dir.split('/').some((s) => DOC_DIR_HINT.test(s));
    const all = filesUnder(c, dir);
    const ratio = list.length / Math.max(1, all.length);
    if (!(isHint || (list.length >= 3 && ratio >= 0.6))) continue;
    const formats: Record<string, number> = {};
    for (const f of list) formats[classify(f).format] = (formats[classify(f).format] ?? 0) + 1;
    const info: DocSourceInfo = { path: dir, files: list.length, formats };
    const gen = docGenerator(c, dir, all);
    if (gen) info.generator = gen;
    out.push(info);
  }
  // root-level documents (README, CHANGELOG ...) are a doc source when there are any
  const rootDocs = docFiles.filter((f) => !f.includes('/'));
  if (rootDocs.length) out.push({ path: '.', files: rootDocs.length, formats: { markdown: rootDocs.length } });
  // versioned documentation trees
  for (const d of out) {
    const subs = uniq(filesUnder(c, d.path).map((f) => f.slice(d.path === '.' ? 0 : d.path.length + 1).split('/')[0]).filter((s) => VERSION_DIR.test(s)));
    if (subs.length >= 2) d.version = subs.sort(compareVersions).join(',');
  }
  void projects;
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
function docGenerator(c: Ctx, dir: string, files: string[]): string | undefined {
  const at = (f: string) => files.includes(join(dir === '.' ? '' : dir, f));
  if (at('assets/search.js') && files.some((f) => f.endsWith('/modules.html') || f.endsWith('/hierarchy.html') || f.endsWith('assets/navigation.js'))) return 'typedoc';
  if (files.some((f) => /\/(components|injectables|modules)\/[^/]+\.html$/.test(f)) && files.some((f) => f.endsWith('coverage.html') || f.endsWith('js/menu-wc.js'))) return 'compodoc';
  if (files.some((f) => f.endsWith('allclasses-index.html') || f.endsWith('allclasses-frame.html'))) return 'javadoc';
  if (files.some((f) => f.endsWith('/_static/searchtools.js') || f.endsWith('/objects.inv'))) return 'sphinx-html';
  if (has(c, join(dir === '.' ? '' : posixDir(dir), 'mkdocs.yml')) || at('mkdocs.yml')) return 'mkdocs';
  if (files.some((f) => /docusaurus\.config\.(js|ts|mjs)$/.test(f))) return 'docusaurus';
  return undefined;
}

// ── main ──
export interface DetectOptions {
  excludeAbs?: string[];
  maxDepth?: number;
  /** look for a parent workspace above the root */
  checkParents?: boolean;
}
export function detectContext(rootAbs: string, config: Config, opts: DetectOptions = {}): ContextReport {
  const root = path.resolve(rootAbs);
  const tree = listTree(root, config, { maxDepth: opts.maxDepth ?? 12, excludeAbs: opts.excludeAbs });
  const c: Ctx = { root, config, files: tree.files, fileSet: new Set(tree.files), evidence: [] };
  const evidence = c.evidence;
  if (tree.truncated) evidence.push({ kind: 'limit', path: '.', detail: 'directory listing truncated (depth or entry limit); some projects may be missing' });

  // projects
  const raw: ProjectInfo[] = [];
  const seenPy = new Set<string>();
  for (const f of tree.files) {
    const base = path.posix.basename(f);
    const dir = posixDir(f);
    let p: ProjectInfo | undefined;
    if (base === 'package.json') p = nodeProject(c, f);
    else if (base === 'pyproject.toml' || base === 'setup.py' || base === 'requirements.txt') {
      if (seenPy.has(dir)) continue;
      seenPy.add(dir);
      p = pythonProject(c, dir);
    } else if (base === 'go.mod') p = goProject(c, f);
    else if (base === 'Cargo.toml') p = rustProject(c, f);
    else if (base === 'pom.xml') p = mavenProject(c, f);
    else if ((base === 'build.gradle' || base === 'build.gradle.kts') && !has(c, join(dir, 'pom.xml'))) p = gradleProject(c, f);
    else if (/\.(cs|fs|vb)proj$/.test(base)) p = dotnetProject(c, f);
    else if (base === 'composer.json')
      p = genericManifest(c, f, 'php', (t) => {
        const j = parseJson(t).value as any;
        if (!j) return undefined;
        return { name: j.name, description: j.description, version: j.version, dependencies: deps(j.require, 'prod', f).concat(deps(j['require-dev'], 'dev', f)), kind: j.type === 'project' ? 'application' : j.type === 'library' ? 'library' : 'unknown', kindEvidence: j.type ? [`composer type "${j.type}"`] : [] };
      });
    else if (base === 'Gemfile')
      p = genericManifest(c, f, 'ruby', (t) => ({
        dependencies: [...t.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)].map((m) => ({ name: m[1], range: m[2], kind: 'prod' as const, evidence: { ref: { source: '', path: f } } })),
        kind: /gem\s+["']rails["']/.test(t) ? 'application' : 'unknown',
        kindEvidence: /gem\s+["']rails["']/.test(t) ? ['Gemfile declares rails'] : [],
        frameworks: /gem\s+["']rails["']/.test(t) ? [{ name: 'Ruby on Rails', evidence: `${f} → gem rails` }] : [],
      }));
    else if (base === 'pubspec.yaml')
      p = genericManifest(c, f, 'dart', (t) => {
        const y = parseYaml(t).value as any;
        if (!y?.name) return undefined;
        const flutter = !!y.dependencies?.flutter;
        return { name: y.name, version: y.version, description: y.description, dependencies: deps(y.dependencies, 'prod', f).concat(deps(y.dev_dependencies, 'dev', f)), kind: flutter && has(c, join(dir, 'lib/main.dart')) ? 'application' : 'library', kindEvidence: [flutter ? 'Flutter dependency' : 'Dart package'], frameworks: flutter ? [{ name: 'Flutter', evidence: `${f} → dependencies.flutter` }] : [] };
      });
    else if (base === 'mix.exs')
      p = genericManifest(c, f, 'elixir', (t) => ({ name: /app:\s*:(\w+)/.exec(t)?.[1], version: /version:\s*"([^"]+)"/.exec(t)?.[1], kind: /phoenix/.test(t) ? 'service' : 'unknown', kindEvidence: /phoenix/.test(t) ? ['depends on phoenix'] : [] }));
    else if (base === 'deno.json' || base === 'deno.jsonc')
      p = genericManifest(c, f, 'deno', (t) => {
        const j = parseJson(t).value as any;
        if (!j || (!j.name && !j.tasks && !j.imports)) return undefined;
        return { name: j.name, version: j.version, scripts: j.tasks ?? {}, kind: j.exports ? 'library' : 'unknown', kindEvidence: j.exports ? ['deno.json exports'] : [], frameworks: [{ name: 'Deno', evidence: f }] };
      });
    if (p) raw.push(p);
  }

  // merge projects living in the same directory (e.g. package.json + pyproject.toml)
  const byDir = new Map<string, ProjectInfo>();
  for (const p of raw) {
    const prev = byDir.get(p.path);
    if (!prev) {
      byDir.set(p.path, p);
      continue;
    }
    prev.manifests.push(...p.manifests);
    prev.dependencies.push(...p.dependencies);
    prev.frameworks.push(...p.frameworks.filter((f) => !prev.frameworks.some((x) => x.name === f.name)));
    prev.entryPoints.push(...p.entryPoints);
    if (prev.ecosystem !== p.ecosystem) prev.ecosystem = `${prev.ecosystem}+${p.ecosystem}`;
    if (prev.kind === 'unknown' || prev.kind === 'package') {
      prev.kind = p.kind;
      prev.kindEvidence.push(...p.kindEvidence);
    }
  }
  let projects = [...byDir.values()];

  const workspaces = detectWorkspaces(c);
  for (const w of workspaces) evidence.push({ kind: 'workspace', path: w.path, detail: `${w.tool}: ${w.evidence}` });

  // angular.json / nx project.json style sub-projects without their own package.json
  for (const f of tree.files) {
    const base = path.posix.basename(f);
    if (base === 'project.json') {
      const pj = parseJson(readRel(c, f) ?? '').value as any;
      const dir = posixDir(f);
      if (!pj || byDir.has(dir || '.')) {
        const ex = byDir.get(dir || '.');
        if (ex && pj?.projectType && (ex.kind === 'unknown' || ex.kind === 'package')) {
          ex.kind = pj.projectType === 'application' ? 'application' : 'library';
          ex.kindEvidence.push(`${f} → projectType ${pj.projectType}`);
        }
        continue;
      }
      const p = newProject(String(pj.name ?? path.posix.basename(dir)), dir, 'node', f);
      p.kind = pj.projectType === 'application' ? 'application' : pj.projectType === 'library' ? 'library' : 'unknown';
      p.kindEvidence.push(`${f} → projectType ${pj.projectType ?? '?'}`);
      projects.push(p);
      byDir.set(p.path, p);
    } else if (base === 'angular.json') {
      const a = parseJson(readRel(c, f) ?? '').value as any;
      const wsDir = posixDir(f);
      for (const [name, def] of Object.entries<any>(a?.projects ?? {})) {
        const dir = join(wsDir, String(def?.root ?? '')).replace(/\/$/, '') || wsDir || '.';
        const ex = byDir.get(dir || '.');
        const kind: ProjectKind = def?.projectType === 'library' ? 'library' : 'application';
        if (ex) {
          if (ex.kind === 'unknown' || ex.kind === 'package' || ex.path === (wsDir || '.')) {
            ex.kind = kind;
            ex.kindEvidence.push(`${f} → projects.${name}.projectType ${def?.projectType}`);
          }
          continue;
        }
        const p = newProject(name, dir, 'node', f);
        p.kind = kind;
        p.kindEvidence.push(`${f} → projects.${name}.projectType ${def?.projectType}`);
        p.frameworks.push({ name: 'Angular', evidence: f });
        projects.push(p);
        byDir.set(p.path, p);
      }
    }
  }

  const rootManifest = byDir.get('.');
  const rootName = rootManifest && !/^(root|workspace|monorepo)$/i.test(rootManifest.name) ? rootManifest.name : undefined;
  // workspace roots that only orchestrate are not projects themselves
  const wsRoots = new Set(workspaces.filter((w) => !['git-submodules'].includes(w.tool)).map((w) => w.path));
  projects = projects.filter((p) => {
    if (!wsRoots.has(p.path)) return true;
    const own = filesUnder(c, p.path === '.' ? '' : p.path).filter((f) => {
      const nested = projects.some((q) => q !== p && q.path !== '.' && (p.path === '.' ? f.startsWith(`${q.path}/`) : f.startsWith(`${q.path}/`)));
      return !nested && classify(f).format.startsWith('code:');
    });
    const others = projects.filter((q) => q !== p && (p.path === '.' || q.path.startsWith(`${p.path}/`)));
    if (others.length && own.length < 3) {
      evidence.push({ kind: 'workspace-root', path: p.path, detail: `${p.manifests[0]} orchestrates ${others.length} projects (not analysed as a project)` });
      return false;
    }
    return true;
  });

  // example / docs hints from location (weak evidence, only when kind still unknown)
  for (const p of projects) {
    const segs = p.path.split('/');
    if (segs.some((s) => EXAMPLE_DIR_HINT.test(s))) {
      p.kindEvidence.push(`located under an examples-like folder (${p.path})`);
      if (p.kind !== 'library') p.kind = 'example';
    }
    if (p.kind === 'unknown' && segs.some((s) => DOC_DIR_HINT.test(s))) {
      p.kind = 'docs';
      p.kindEvidence.push('located under a documentation folder');
    }
  }

  // languages per project (files owned by the deepest project)
  const sortedByDepth = [...projects].sort((a, b) => b.path.length - a.path.length);
  const owner = (f: string) => sortedByDepth.find((p) => p.path === '.' || f.startsWith(`${p.path}/`));
  const langCount = new Map<ProjectInfo, Map<string, number>>();
  let sourceFiles = 0;
  let docFiles = 0;
  for (const f of tree.files) {
    const fmt = classify(f).format;
    if (fmt.startsWith('code:')) sourceFiles++;
    if (fmt === 'markdown' || fmt === 'html' || fmt === 'text') docFiles++;
    if (!fmt.startsWith('code:')) continue;
    const p = owner(f);
    if (!p) continue;
    const m = langCount.get(p) ?? new Map<string, number>();
    m.set(fmt.slice(5), (m.get(fmt.slice(5)) ?? 0) + 1);
    langCount.set(p, m);
  }
  for (const p of projects) {
    const m = langCount.get(p);
    p.languages = m ? [...m.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l) : [];
    if (p.kind === 'unknown' && !p.languages.length && filesUnder(c, p.path === '.' ? '' : p.path).some((f) => classify(f).format === 'markdown')) {
      p.kind = 'docs';
      p.kindEvidence.push('no source code, only documentation');
    }
  }

  // stable ids
  const nameCount = new Map<string, number>();
  for (const p of projects) nameCount.set(slugify(p.name), (nameCount.get(slugify(p.name)) ?? 0) + 1);
  for (const p of projects) {
    const s = slugify(p.name.replace(/^@/, '').replace('/', '-'));
    p.id = (nameCount.get(slugify(p.name)) ?? 0) > 1 ? slugify(`${s}-${p.path}`) : s;
  }
  projects.sort((a, b) => a.path.localeCompare(b.path));

  // internal dependency graph
  const graph: ContextReport['graph'] = [];
  const byName = new Map<string, ProjectInfo>();
  for (const p of projects) {
    byName.set(p.name, p);
    byName.set(p.name.toLowerCase(), p);
    byName.set(`project:${p.path}`, p);
    byName.set(`project:${path.posix.basename(p.path)}`, p);
    const artifact = p.name.split(':').pop();
    if (artifact) byName.set(`:${artifact}`, p);
  }
  for (const p of projects) {
    for (const d of p.dependencies) {
      let target = byName.get(d.name) ?? byName.get(d.name.toLowerCase()) ?? (d.name.includes(':') && p.ecosystem === 'jvm' ? byName.get(`:${d.name.split(':').pop()}`) : undefined);
      if (!target && d.range?.startsWith('path:')) target = projects.find((q) => q.path === path.posix.normalize(join(p.path === '.' ? '' : p.path, d.range!.slice(5))));
      if (!target && p.ecosystem === 'go' && d.range?.startsWith('.')) target = projects.find((q) => q.path === path.posix.normalize(join(p.path === '.' ? '' : p.path, d.range!)));
      if (!target || target === p) continue;
      d.internal = true;
      graph.push({ from: p.id, to: target.id, kind: d.kind, evidence: `${d.evidence.ref.path} declares ${d.name}${d.range ? ` (${d.range})` : ''}` });
    }
  }

  // repositories
  const repositories = tree.gitDirs.map((g) => ({ path: g, hasGit: true }));
  const docSources = detectDocs(c, projects);

  // vaults
  const vaults: ContextReport['vaults'] = [];
  // `.obsidian` entries are recorded as "<dir>/.obsidian" → vault dir; generated vaults are never descended into
  const obsidian = tree.obsidianDirs.map((d) => (d === '.' ? '.' : d));
  const vaultDirs = uniq([...obsidian, ...tree.generatedVaults]);
  for (const v of vaultDirs) {
    const generated = tree.generatedVaults.includes(v);
    let notes = 0;
    if (generated) {
      try {
        notes = countMarkdown(path.join(root, v));
      } catch {
        notes = 0;
      }
    } else notes = filesUnder(c, v === '.' ? '' : v).filter((f) => f.endsWith('.md')).length;
    vaults.push({ path: v, hasObsidianDir: obsidian.includes(v) || fs.existsSync(path.join(root, v, '.obsidian')), hasManifest: generated, notes });
  }

  // version mismatches of shared external dependencies
  const versionMismatches: ContextReport['versionMismatches'] = [];
  const depVers = new Map<string, { value: string; path: string }[]>();
  for (const p of projects)
    for (const d of p.dependencies)
      if (!d.internal && d.range && !/^(workspace:|path:|file:|link:|\*|latest)/.test(d.range) && d.kind !== 'optional') {
        const l = depVers.get(d.name) ?? [];
        l.push({ value: d.range, path: d.evidence.ref.path });
        depVers.set(d.name, l);
      }
  for (const [name, vals] of depVers) {
    const distinct = uniq(vals.map((v) => v.value.replace(/^[\^~=v]/, '').split('.')[0]));
    if (distinct.length > 1) versionMismatches.push({ subject: `dependency:${name}`, values: vals });
  }
  const runtimeDecl = collectRuntimeVersions(c);
  for (const [subject, vals] of runtimeDecl) {
    if (uniq(vals.map((v) => v.value.replace(/^[^\d]*/, '').split('.')[0])).length > 1) versionMismatches.push({ subject, values: vals });
  }

  // parent workspace
  let parentWorkspace: ContextReport['parentWorkspace'];
  if (opts.checkParents !== false) parentWorkspace = findParentWorkspace(root);

  // classify context
  const ambiguities: string[] = [];
  const nestedRepos = repositories.filter((r) => r.path !== '.');
  const rootRepo = repositories.some((r) => r.path === '.');
  const submodules = new Set(workspaces.filter((w) => w.tool === 'git-submodules').flatMap((w) => w.globs));
  const independentRepos = nestedRepos.filter((r) => !submodules.has(r.path));
  const codeProjects = projects.filter((p) => p.kind !== 'docs');
  const realWs = workspaces.filter((w) => w.tool !== 'git-submodules');
  let kind: ContextKind;
  let confidence = 0.9;
  const rootVault = vaults.find((v) => v.path === '.');
  if (rootVault && codeProjects.length === 0) kind = 'existing-vault';
  else if (independentRepos.length >= 2 || (independentRepos.length >= 1 && !rootRepo && codeProjects.some((p) => !independentRepos.some((r) => p.path === r.path || p.path.startsWith(`${r.path}/`))))) {
    kind = 'multi-repo-workspace';
    if (rootRepo) {
      confidence = 0.6;
      ambiguities.push('nested git repositories inside a git repository that are not declared submodules');
    }
  } else if (realWs.length || codeProjects.length >= 2) {
    kind = 'monorepo';
    if (!realWs.length) {
      confidence = rootRepo ? 0.7 : 0.5;
      ambiguities.push(rootRepo ? 'several projects share one repository without a workspace tool' : 'several projects in a folder that is not a repository and has no workspace tool');
      if (!rootRepo) kind = 'mixed';
    }
    if (codeProjects.length === 1 && realWs.length) confidence = 0.6;
  } else if (codeProjects.length === 1) kind = 'single-project';
  else if (projects.length || docFiles) kind = 'docs-only';
  else {
    kind = 'unknown';
    confidence = 0.2;
  }
  if (rootVault && kind !== 'existing-vault') ambiguities.push('the directory is an Obsidian vault and also contains code projects');
  if (vaults.some((v) => v.path !== '.')) ambiguities.push('existing vault(s) found inside the analysed directory');
  if (parentWorkspace) ambiguities.push(`the directory is inside a ${parentWorkspace.tool} workspace rooted at ${parentWorkspace.path}`);
  if (docSources.some((d) => d.version)) ambiguities.push('documentation exists for several versions');

  // workspace-level technologies (infrastructure, CI)
  const infra: Tech[] = [];
  const addInfra = (name: string, ev: string) => !infra.some((i) => i.name === name) && infra.push({ name, evidence: ev });
  for (const f of tree.files) {
    const b = path.posix.basename(f).toLowerCase();
    if (b === 'dockerfile' || b.endsWith('.dockerfile')) addInfra('Docker', f);
    else if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(b)) addInfra('Docker Compose', f);
    else if (f.startsWith('.github/workflows/')) addInfra('GitHub Actions', f);
    else if (b === '.gitlab-ci.yml') addInfra('GitLab CI', f);
    else if (b === 'jenkinsfile') addInfra('Jenkins', f);
    else if (b === 'azure-pipelines.yml') addInfra('Azure Pipelines', f);
    else if (b.endsWith('.tf')) addInfra('Terraform', f);
    else if (b === 'chart.yaml') addInfra('Helm', f);
    else if (b === 'serverless.yml') addInfra('Serverless Framework', f);
  }
  for (const i of infra) evidence.push({ kind: 'infrastructure', path: i.evidence, detail: i.name });

  return {
    rootAbs: root,
    kind,
    confidence,
    repositories,
    workspaces,
    projects,
    docSources,
    vaults,
    graph,
    parentWorkspace,
    rootName,
    evidence,
    versionMismatches,
    ambiguities,
    stats: { files: tree.files.length, sourceFiles, docFiles, dirs: tree.dirs.length },
  };
}

function countMarkdown(dir: string, depth = 0): number {
  if (depth > 12) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) n += countMarkdown(path.join(dir, e.name), depth + 1);
    else if (e.name.endsWith('.md')) n++;
  }
  return n;
}

function collectRuntimeVersions(c: Ctx): Map<string, { value: string; path: string }[]> {
  const out = new Map<string, { value: string; path: string }[]>();
  const add = (s: string, value: string, p: string) => {
    const l = out.get(s) ?? [];
    l.push({ value: value.trim(), path: p });
    out.set(s, l);
  };
  for (const f of c.files) {
    const b = path.posix.basename(f).toLowerCase();
    if (b === '.nvmrc' || b === '.node-version') add('runtime:node', readRel(c, f)?.trim() ?? '', f);
    else if (b === '.python-version') add('runtime:python', readRel(c, f)?.trim() ?? '', f);
    else if (b === 'dockerfile' || b.endsWith('.dockerfile')) {
      for (const m of (readRel(c, f) ?? '').matchAll(/^FROM\s+(?:--platform=\S+\s+)?(node|python|golang|openjdk|eclipse-temurin|ruby|php):(\d+(?:\.\d+)*)/gim)) {
        const rt = { golang: 'go', openjdk: 'java', 'eclipse-temurin': 'java' }[m[1].toLowerCase()] ?? m[1].toLowerCase();
        add(`runtime:${rt}`, m[2], f);
      }
    } else if (f.startsWith('.github/workflows/') && /\.ya?ml$/.test(b)) {
      const t = readRel(c, f) ?? '';
      for (const m of t.matchAll(/node-version:\s*["']?(\d+(?:\.\w+)*)/g)) add('runtime:node', m[1], f);
      for (const m of t.matchAll(/python-version:\s*["']?(\d+(?:\.\d+)*)/g)) add('runtime:python', m[1], f);
    } else if (b === 'package.json') {
      const pj = parseJson(readRel(c, f) ?? '').value as any;
      if (pj?.engines?.node) add('runtime:node', String(pj.engines.node), f);
    }
  }
  return out;
}

const PARENT_MARKERS: { file: string; tool: string; test?: (txt: string) => boolean }[] = [
  { file: 'pnpm-workspace.yaml', tool: 'pnpm' },
  { file: 'package.json', tool: 'npm-workspaces', test: (t) => /"workspaces"\s*:/.test(t) },
  { file: 'lerna.json', tool: 'lerna' },
  { file: 'nx.json', tool: 'nx' },
  { file: 'turbo.json', tool: 'turborepo' },
  { file: 'rush.json', tool: 'rush' },
  { file: 'go.work', tool: 'go-work' },
  { file: 'Cargo.toml', tool: 'cargo-workspace', test: (t) => /^\[workspace\]/m.test(t) },
  { file: 'settings.gradle', tool: 'gradle-multiproject' },
  { file: 'settings.gradle.kts', tool: 'gradle-multiproject' },
];
export function findParentWorkspace(root: string): ContextReport['parentWorkspace'] {
  let cur = path.dirname(root);
  for (let i = 0; i < 8; i++) {
    for (const m of PARENT_MARKERS) {
      const p = path.join(cur, m.file);
      try {
        if (fs.statSync(p).isFile()) {
          if (m.test && !m.test(fs.readFileSync(p, 'utf8'))) continue;
          return { path: toPosix(path.relative(root, cur)) || '.', tool: m.tool };
        }
      } catch {
        /* not present */
      }
    }
    if (fs.existsSync(path.join(cur, '.git'))) return undefined; // stop at the enclosing repository root
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return undefined;
}

/** Name declared by the manifest at a directory root (used as a stable, folder-independent source label). */
export function rootManifestName(root: string): string | undefined {
  const read = (f: string) => {
    try {
      return normalizeText(fs.readFileSync(path.join(root, f), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const pj = read('package.json');
  const fromPkg = pj ? (parseJson(pj).value as { name?: unknown } | undefined)?.name : undefined;
  if (typeof fromPkg === 'string' && fromPkg && !/^(root|workspace|monorepo)$/i.test(fromPkg)) return fromPkg;
  const py = read('pyproject.toml');
  const t = py ? parseToml(py).value : undefined;
  const fromPy = t?.project?.name ?? t?.tool?.poetry?.name;
  if (typeof fromPy === 'string' && fromPy) return fromPy;
  const cargo = read('Cargo.toml');
  const ct = cargo ? parseToml(cargo).value : undefined;
  if (typeof ct?.package?.name === 'string') return ct.package.name;
  const gomod = read('go.mod');
  const mod = gomod ? /^module\s+(\S+)/m.exec(gomod)?.[1] : undefined;
  if (mod) return mod.split('/').pop();
  const pom = read('pom.xml');
  const art = pom ? /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(pom.replace(/<parent>[\s\S]*?<\/parent>/, ''))?.[1] : undefined;
  return art;
}

/** Projects selected by user scope tokens (id, name or path; glob allowed). */
export function selectProjects(report: ContextReport, scope: string[]): { selected: ProjectInfo[]; unknown: string[] } {
  if (!scope.length) return { selected: report.projects, unknown: [] };
  const selected = new Set<ProjectInfo>();
  const unknown: string[] = [];
  for (const s of scope) {
    const tok = s.trim().replace(/^\.\//, '').replace(/\/$/, '');
    const hits = report.projects.filter((p) => p.id === tok || p.name === tok || p.path === tok || matchGlob(tok, p.path) || p.path.startsWith(`${tok}/`));
    if (!hits.length) unknown.push(s);
    hits.forEach((h) => selected.add(h));
  }
  return { selected: [...selected], unknown };
}

/** Expand a selection with its internal dependencies (transitively), so the slice stays coherent. */
export function withInternalDeps(report: ContextReport, selected: ProjectInfo[]): { projects: ProjectInfo[]; added: string[] } {
  const ids = new Set(selected.map((p) => p.id));
  const added: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of report.graph) {
      if (ids.has(e.from) && !ids.has(e.to) && e.kind !== 'dev') {
        ids.add(e.to);
        added.push(e.to);
        changed = true;
      }
    }
  }
  return { projects: report.projects.filter((p) => ids.has(p.id)), added };
}
