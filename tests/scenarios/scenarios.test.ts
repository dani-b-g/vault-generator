// End-to-end scenarios (the 20 mandatory cases of the specification). Every scenario runs the engine
// through the same entry point the CLI uses, on an isolated temporary fixture.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fixture, json, tmpDir, writeTree } from '../fixtures.ts';
import { generate, noteByTitle, notes, read, snapshot, vaultOf, vg } from '../helpers.ts';
import { validateVault } from '../../skills/vault-generator/scripts/lib/validate.ts';
import { loadManifest, loadState } from '../../skills/vault-generator/scripts/lib/state.ts';
import { parseNote } from '../../skills/vault-generator/scripts/lib/vault.ts';
import { slugify } from '../../skills/vault-generator/scripts/lib/util.ts';

const dirs: string[] = [];
const fx = (name: Parameters<typeof fixture>[0]) => {
  const d = fixture(name);
  dirs.push(d);
  return d;
};
after(() => dirs.forEach(cleanup));

/** Invariants every generated vault must satisfy. */
function assertHealthyVault(vault: string) {
  const rep = validateVault(vault);
  const errors = rep.issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], `validation errors:\n${errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('\n')}`);
  for (const n of notes(vault).filter((x) => x.hasVg)) {
    const vgm = n.fm.vg as Record<string, unknown>;
    assert.ok(typeof vgm.id === 'string' && /^vg-[0-9a-f]{10}$/.test(vgm.id as string), `stable id in ${n.path}`);
    assert.ok(Array.isArray(vgm.sources), `provenance in ${n.path}`);
    assert.ok(!/[A-Za-z]:\\Users\\|\/home\/[^/]+\//.test(read(vault, n.path)), `no private absolute path in ${n.path}`);
  }
  const m = JSON.stringify(loadManifest(vault));
  assert.ok(!/[A-Za-z]:\\\\Users|\/home\/[^/]+\//.test(m), 'manifest has no private absolute paths');
}

test('01 small project with README → single-project vault with project note as home', async () => {
  const dir = fx('small-readme');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const p = noteByTitle(v, 'tiny-lib');
  assert.equal(p.type, 'project');
  assert.match(p.body, /A tiny string utility library/);
  assert.match(p.body, /#### slug · function/);
  assert.match(p.body, /Convert text to a URL slug/);
  assert.ok(!notes(v).some((n) => n.type === 'moc' && n.title === 'tiny-lib'), 'no separate home note for a single project');
  assert.equal(loadManifest(v)!.context.kind, 'single-project');
});

test('02 application with docs and examples → links rewritten, images copied, secrets skipped, contradictions none', async () => {
  const dir = fx('app-docs-examples');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const guide = noteByTitle(v, 'User guide');
  assert.match(guide.body, /\[\[[^\]]*\|the router\]\]|the router\]\]/, 'link to source file becomes a module/project wikilink');
  assert.match(guide.body, /> \[!WARNING\]/);
  assert.match(guide.body, /```mermaid/);
  const img = /!\[diagram\]\(([^)]+)\)/.exec(guide.body)?.[1];
  assert.ok(img && fs.existsSync(path.resolve(v, path.dirname(guide.path), decodeURIComponent(img))), `image copied and linked (${img})`);
  const api = noteByTitle(v, 'API reference');
  assert.match(api.body, /\[\[User guide#Getting started\|the guide\]\]/, 'anchor link rewritten to heading link');
  const all = notes(v).map((n) => read(v, n.path)).join('\n');
  assert.ok(!all.includes('hunter2-very-secret'), '.env content never reaches the vault');
  assert.ok(notes(v).some((n) => n.title.startsWith('Basic example')), 'example documentation imported');
  const proj = noteByTitle(v, 'notes-app');
  assert.match(proj.body, /\[\[notes-app — Operations\]\]/, 'project links to its operations note');
  const ops = noteByTitle(v, 'notes-app — Operations');
  assert.match(ops.body, /node:20-alpine/, 'Dockerfile summarised');
  assert.match(ops.body, /`DATABASE_PASSWORD`/, 'env template lists variable names');
  assert.ok(!/DATABASE_PASSWORD=\S/.test(ops.body), 'env values never copied');
  assert.ok((r.data.skipped as Record<string, unknown>)['sensitive-file'], 'skipped secrets reported');
});

test('03 monorepo with several libraries → per-package notes, dependency relations, no duplicated common docs', async () => {
  const dir = fx('monorepo-libs');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const http = noteByTitle(v, '@acme/http');
  assert.deepEqual(http.fm.depends_on, ['[[acme-utils]]']);
  const utils = noteByTitle(v, '@acme/utils');
  assert.deepEqual(utils.fm.used_by, ['[[acme-http]]']);
  assert.match(utils.body, /#### retry · function/);
  const home = noteByTitle(v, 'acme-libs');
  assert.match(home.body, /```mermaid\ngraph LR/);
  const keys = notes(v).filter((n) => n.hasVg).map((n) => n.key);
  assert.equal(new Set(keys).size, keys.length, 'one note per knowledge unit');
});

test('04 monorepo with apps and shared packages → kinds, partial scope with dependency closure', async () => {
  const dir = fx('monorepo-apps');
  const r = await vg(dir, '--mode', 'generate', '--answer', 'destination=default', '--scope', '@shop/api-client');
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const titles = notes(v).map((n) => n.title);
  assert.ok(titles.includes('@shop/api-client') && titles.includes('@shop/models'), 'selected project + its dependency');
  assert.ok(!titles.includes('@shop/web') && !titles.includes('@shop/api') && !titles.includes('@shop/ui'), 'unrelated apps excluded');
  assert.equal(loadManifest(v)!.scopeSelection.mode, 'projects');
  // a later sync keeps the recorded scope
  const s = await vg(dir, '--mode', 'sync');
  assert.equal(s.status, 'done');
  assert.ok(!notes(v).some((n) => n.title === '@shop/web'));
});

test('05 frontend and backend in different repositories → separate projects, API spec, inferred cross-repo relation asked', async () => {
  const dir = fx('multi-repo');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  assert.equal(loadManifest(v)!.context.kind, 'multi-repo-workspace');
  const api = noteByTitle(v, 'Pet Store API');
  assert.equal(api.type, 'api');
  assert.match(api.body, /### GET \/pets\/\{petId\}/);
  const backend = noteByTitle(v, 'petstore-api');
  assert.ok((backend.fm.exposes as string[]).some((l) => l.includes('Pet Store API')), 'backend exposes the API (verified: spec in its repo)');
  const relQ = r.questions.find((q) => q.kind === 'relation' && /"storefront" consumes "Pet Store API"/.test(q.prompt));
  assert.ok(relQ, `frontend → API relation is only inferred, so the user is asked (${r.questions.map((q) => q.prompt).join(' | ')})`);
  const front = noteByTitle(v, 'storefront');
  assert.ok(!front.fm.consumes, 'inferred relation is not written as a property');
  assert.match(front.body, /Possible relations \(unverified\)/);
  // confirm it
  const s = await vg(dir, '--mode', 'sync', '--answer', `${relQ!.id}=confirm`);
  assert.equal(s.status, 'done');
  assert.ok((noteByTitle(v, 'storefront').fm.consumes as string[] | undefined)?.length, 'confirmed relation becomes a property');
});

test('06 Markdown documentation without code → doc tree preserved, ADRs, supersedes, callouts', async () => {
  const dir = fx('docs-only');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  assert.equal(loadManifest(v)!.context.kind, 'docs-only');
  const first = noteByTitle(v, 'First week');
  assert.match(first.body, /\[\[Laptop#Setup\|tools\]\]/);
  assert.deepEqual((first.fm.tags as string[]).includes('onboarding'), true, 'source frontmatter tags kept');
  const laptop = noteByTitle(v, 'Laptop');
  assert.match(laptop.body, /> \[!tip\] Pro tip/);
  const adr2 = noteByTitle(v, 'ADR 0002: Use Obsidian');
  assert.equal(adr2.type, 'decision');
  assert.ok((adr2.fm.supersedes as string[]).some((l) => l.includes('ADR 0001')));
  assert.ok(notes(v).some((n) => n.title === 'Decisions' && n.type === 'moc'), 'decision index for ≥ 3 ADRs');
});

test('07 HTML and generated documentation → TypeDoc content extracted, chrome removed, loss reported', async () => {
  const dir = fx('html-generated');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const w = noteByTitle(v, 'Widgets');
  assert.match(w.body, /```sh\nnpm i widgets\n```/);
  assert.match(w.body, /\[\[Class Widget\|Widget\]\]/, 'links between generated pages rewritten');
  assert.ok(!w.body.includes('toolbar') && !w.body.includes('var x=1'));
  assert.ok((w.fm.tags as string[]).includes('generated-docs/typedoc'));
  assert.ok(!notes(v).some((n) => /search page/.test(n.body)), 'search pages skipped');
  const manual = noteByTitle(v, 'Manual');
  assert.match(manual.body, /Conversion notes: inline (data-URI images|SVG)/);
});

test('08 existing vault with manual notes → asks placement, never modifies manual notes', async () => {
  const dir = fx('existing-vault');
  const before = snapshot(dir);
  const q = await vg(dir, '--mode', 'generate', '--source', 'project', '--vault', '.');
  assert.equal(q.status, 'needs_input');
  assert.ok(q.questions.some((x) => x.id === 'vault-placement'));
  assert.deepEqual(snapshot(dir), before, 'nothing written before answering');
  const r = await vg(dir, '--mode', 'generate', '--source', 'project', '--vault', '.', '--answer', 'vault-placement=subfolder');
  assert.equal(r.status, 'done', r.summary);
  for (const f of ['Home.md', 'Ideas.md']) assert.equal(read(dir, f), before[f], `${f} untouched`);
  assert.ok(notes(dir).filter((n) => n.hasVg).every((n) => n.path.startsWith('vault-generator/')), 'generated notes isolated in a subfolder');
  const rep = validateVault(dir);
  assert.deepEqual(rep.issues.filter((i) => i.level === 'error'), []);
});

test('09 contradictory documentation → contradictions detected, flagged, resolvable', async () => {
  const dir = fx('contradictory');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const contra = r.data.contradictions as { id: string; detail: string }[];
  assert.ok(contra.some((c) => /node version/.test(c.detail) && /README\.md/.test(c.detail)), 'Node 16 (README) vs >=20 (package.json/.nvmrc)');
  assert.ok(contra.some((c) => /script "serve"/.test(c.detail)), 'documented script missing from manifest');
  const readme = notes(v).find((n) => n.title.includes('README'))!;
  assert.match(readme.body, /> \[!warning\] Contradiction detected/);
  assert.equal((readme.fm.vg as Record<string, unknown>).status, 'needs-review');
  assert.ok(notes(v).some((n) => n.title === 'Open questions'));
  const nodeC = contra.find((c) => /node version/.test(c.detail))!;
  const scriptC = contra.find((c) => /script "serve"/.test(c.detail))!;
  await vg(dir, '--mode', 'sync', '--answer', `${nodeC.id}=>=20 (package.json)`, '--answer', `${scriptC.id}=package.json (manifest)`);
  const after = notes(v).find((n) => n.title.includes('README'))!;
  assert.match(after.body, /> \[!check\] Resolved by user decision/);
  assert.equal((after.fm.vg as Record<string, unknown>).status, 'current');
});

test('10 several versions → version tags, default version asked and applied to search', async () => {
  const dir = fx('multi-version');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  assert.ok(r.questions.some((q) => q.id === 'default-version'));
  assert.equal(loadManifest(v)!.decisions['default-version'].answer, 'v2', 'latest assumed and recorded');
  const v1 = noteByTitle(v, 'API v1');
  assert.equal(v1.fm.version, 'v1');
  const s = await vg(dir, '--mode', 'search', 'getting started client');
  const hits = (s.data.hits as { title: string; version?: string }[]);
  assert.ok(hits.length && hits.every((h) => !h.version || h.version === 'v2'), 'default version filter');
  const all = await vg(dir, '--mode', 'search', 'getting started', '--version', 'any');
  assert.ok((all.data.hits as { version?: string }[]).some((h) => h.version === 'v1'));
});

test('11 source code without documentation → projects, modules, symbols from Python and Go', async () => {
  const dir = fx('code-only');
  // two unrelated projects in a plain folder: the scope is ambiguous, so it is asked first
  const q = await generate(dir);
  assert.equal(q.status, 'needs_input');
  const r = await generate(dir, '--answer', 'scope=all');
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const calc = noteByTitle(v, 'calc');
  assert.match(calc.body, /#### add · function/);
  assert.match(calc.body, /def add\(a: int, b: int\) -> int/);
  assert.ok(!calc.body.includes('_private'), 'private symbols omitted');
  const greeter = noteByTitle(v, 'example.com/greeter');
  assert.match(greeter.body, /Hello returns a greeting/);
  assert.match(greeter.body, /\*No description is declared in the sources\.\*/, 'missing info is stated, not invented');
});

test('12 multiple applications without a common architecture → asks scope, no invented relations', async () => {
  const dir = fx('unrelated-apps');
  const q = await generate(dir);
  assert.equal(q.status, 'needs_input');
  assert.ok(q.questions.some((x) => x.id === 'scope'));
  const r = await vg(dir, '--mode', 'generate', '--answer', 'destination=default', '--answer', 'scope=all');
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const projectNotes = notes(v).filter((n) => n.type === 'project');
  assert.equal(projectNotes.length, 3);
  for (const n of projectNotes) assert.ok(!n.fm.depends_on && !n.fm.consumes, `no invented relation on ${n.title}`);
  const inv = noteByTitle(v, 'com.example:inventory');
  assert.match(inv.body, /Spring Boot/);
  assert.match(inv.body, /`\/items`/);
});

test('13 restricted documents → decision required, excluded by default, hidden from search when included', async () => {
  const dir = fx('restricted');
  const q = await generate(dir);
  assert.equal(q.status, 'needs_input');
  assert.ok(q.questions.some((x) => x.id === 'restricted-docs'));
  const r = await vg(dir, '--mode', 'generate', '--answer', 'destination=default', '--answer', 'restricted-docs=restricted');
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const all = notes(v).map((n) => read(v, n.path)).join('\n');
  assert.ok(!all.includes('s3cr3t-value-123') && !all.includes('SuperSecretPassw0rd!') && !all.includes('OPENSSH PRIVATE KEY'), 'secrets never copied');
  const sal = noteByTitle(v, 'Salaries');
  assert.equal(sal.access, 'restricted');
  const s = await vg(dir, '--mode', 'search', 'compensation bands');
  assert.equal((s.data.hits as unknown[]).length, 0, 'restricted notes hidden by default');
  assert.ok(s.warnings.some((w) => /restricted/.test(w)));
  const s2 = await vg(dir, '--mode', 'search', 'compensation bands', '--include-restricted');
  assert.ok((s2.data.hits as { title: string }[]).some((h) => h.title === 'Salaries'));
  const exp = await vg(dir, '--mode', 'export', '--to', 'html');
  assert.equal(exp.status, 'done', exp.summary);
  const site = path.join(v, '.vault-generator', 'exports', 'site');
  const html = fs.readdirSync(site, { recursive: true }).map(String).filter((f) => f.endsWith('.html')).map((f) => fs.readFileSync(path.join(site, f), 'utf8')).join('');
  assert.ok(!html.includes('Confidential compensation'), 'restricted content not exported');
});

test('14 sources with broken references → reported, valid vault', async () => {
  const dir = fx('broken-refs');
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const v = vaultOf(dir);
  assertHealthyVault(v);
  const readme = notes(v).find((n) => n.title.includes('README') || n.title === 'Broken')!;
  assert.match(readme.body, /missing page ⚠️`docs\/missing\.md`/);
  const oq = noteByTitle(v, 'Open questions');
  assert.match(oq.body, /Broken references in sources/);
  assert.match(oq.body, /docs\/missing\.md/);
});

test('15 incremental update → only changed notes, new/removed/renamed sources, contract changes, manual edits kept', async () => {
  const dir = fx('app-docs-examples');
  await generate(dir);
  const v = vaultOf(dir);
  const guideBefore = noteByTitle(v, 'User guide');
  // user edits: inside region of guide, outside region of api note
  const gp = path.join(v, guideBefore.path);
  fs.writeFileSync(gp, read(v, guideBefore.path).replace('Notes are stored in memory and lost on restart.', 'Notes are stored in memory and lost on restart. (MY NOTE)'));
  const apiNote = noteByTitle(v, 'API reference');
  fs.appendFileSync(path.join(v, apiNote.path), '\nMANUAL APPENDIX\n');
  // source changes
  fs.writeFileSync(path.join(dir, 'docs/new-page.md'), '# New page\n\nBrand new content.\n');
  fs.renameSync(path.join(dir, 'examples/basic/README.md'), path.join(dir, 'examples/basic/GUIDE.md'));
  fs.appendFileSync(path.join(dir, 'docs/guide.md'), '\n## Troubleshooting\n\nRestart the server.\n');
  fs.appendFileSync(path.join(dir, 'src/store.ts'), '\n/** Remove all notes. */\nexport function clearAll(): void {}\n');
  const r = await vg(dir, '--mode', 'sync');
  assert.equal(r.status, 'done', r.summary);
  const c = r.data.counts as Record<string, number>;
  assert.ok(c.create >= 1, 'new page created');
  assert.equal(c.merged, 1, 'guide: user edit + source change merged');
  const guide = read(v, guideBefore.path);
  assert.match(guide, /\(MY NOTE\)/);
  assert.match(guide, /## Troubleshooting/);
  assert.match(read(v, apiNote.path), /MANUAL APPENDIX/);
  const renamed = notes(v).find((n) => n.title === 'Basic example');
  const st = loadState(v);
  assert.ok(renamed && st.notes[renamed.id], 'renamed doc keeps its note id');
  assert.ok((r.data.contracts as { added: string[] }).added.some((x) => x.includes('clearAll')), 'contract change reported');
  // deleting a source marks the note stale (not deleted)
  fs.rmSync(path.join(dir, 'docs/new-page.md'));
  const r2 = await vg(dir, '--mode', 'sync');
  assert.equal((r2.data.counts as Record<string, number>).stale, 1);
  const np = noteByTitle(v, 'New page');
  assert.equal((np.fm.vg as Record<string, unknown>).status, 'stale');
  assertHealthyVault(v);
});

test('16 repeated run without changes → idempotent (no file changes, no duplicates)', async () => {
  const dir = fx('monorepo-libs');
  await generate(dir);
  const v = vaultOf(dir);
  const before = snapshot(v);
  const r = await vg(dir, '--mode', 'sync');
  const c = r.data.counts as Record<string, number>;
  assert.equal(Object.keys(c).filter((k) => k !== 'unchanged').reduce((n, k) => n + c[k], 0), 0, `only unchanged: ${JSON.stringify(c)}`);
  const after = snapshot(v);
  const changed = Object.keys(after).filter((k) => after[k] !== before[k] && !k.endsWith('state.json') && !k.endsWith('manifest.json'));
  assert.deepEqual(changed, [], 'no note or base file changed');
  // reproducible: a fresh generation from the same sources produces the same notes
  const dir2 = tmpDir();
  dirs.push(dir2);
  fs.cpSync(dir, dir2, { recursive: true });
  fs.rmSync(path.join(dir2, 'knowledge-vault'), { recursive: true });
  await generate(dir2);
  const a = snapshot(v);
  const b = snapshot(vaultOf(dir2));
  const notesA = Object.keys(a).filter((k) => k.endsWith('.md') && !k.startsWith('.vault-generator'));
  assert.deepEqual(notesA.sort(), Object.keys(b).filter((k) => k.endsWith('.md') && !k.startsWith('.vault-generator')).sort());
  for (const k of notesA) assert.equal(b[k], a[k], `reproducible ${k}`);
});

test('17 context for a concrete task → cited fragments, relations, uncertainties', async () => {
  const dir = fx('monorepo-apps');
  await generate(dir);
  const r = await vg(dir, '--mode', 'context', 'add a getProduct function to the api client');
  assert.equal(r.status, 'done', r.summary);
  const pkg = r.data.package as { fragments: { notePath: string; sources: string[]; title: string }[]; related: unknown[]; uncertainties: string[] };
  assert.ok(pkg.fragments.length > 0);
  assert.equal(pkg.fragments[0].title, '@shop/api-client');
  assert.ok(pkg.fragments.every((f) => f.notePath.endsWith('.md')));
  assert.ok(pkg.related.length > 0, 'related notes through verified relations');
  assert.match(String(r.data.markdown), /## Relevant knowledge/);
  const full = r.data.package as { constraints: string[]; fragments: { notePath: string; lines: [number, number]; heading: string }[] };
  assert.ok(full.constraints.every((c) => !c.includes('<!--')), 'skill boilerplate is not a documented constraint');
  for (const f of full.fragments) {
    const fileLine = read(vaultOf(dir), f.notePath).split('\n')[f.lines[0] - 1] ?? '';
    assert.match(fileLine, /^#{1,6} /, `fragment line ${f.lines[0]} of ${f.notePath} points at its heading in the file`);
  }
  const none = await vg(dir, '--mode', 'context', 'kubernetes helm deployment rollback');
  const p2 = none.data.package as { uncertainties: string[] };
  assert.ok(p2.uncertainties.length > 0, 'gaps are stated');
});

test('18 transformation to an output format → HTML→MD, OpenAPI→MD, vault→site, vault→skill with validations', async () => {
  const dir = fx('multi-repo');
  const t1 = await vg(dir, '--mode', 'transform', '--input', 'backend/openapi.json', '--output', 'out/petstore.md');
  assert.equal(t1.status, 'done', t1.summary);
  assert.ok((t1.data.validations as { passed: boolean }[]).every((x) => x.passed));
  assert.match(fs.readFileSync(path.join(dir, 'out/petstore.md'), 'utf8'), /### POST \/pets/);
  const again = await vg(dir, '--mode', 'transform', '--input', 'backend/openapi.json', '--output', 'out/petstore.md');
  assert.equal(again.status, 'error', 'never overwrites without --force');
  const h = fx('html-generated');
  const t2 = await vg(h, '--mode', 'transform', '--input', 'site', '--output', 'md');
  assert.equal(t2.status, 'done', t2.summary);
  assert.ok(fs.existsSync(path.join(h, 'md/classes/Widget.md')));
  await generate(dir);
  const e = await vg(dir, '--mode', 'export', '--to', 'skill', '--name', 'petstore-knowledge', '--output', 'petstore-knowledge');
  assert.equal(e.status, 'done', e.summary);
  const { validateSkillDir } = await import('../../skills/vault-generator/scripts/lib/skillcheck.ts');
  assert.ok(validateSkillDir(path.join(dir, 'petstore-knowledge')).ok, 'exported skill is spec-valid');
  const site = await vg(dir, '--mode', 'export', '--to', 'html');
  assert.equal(site.status, 'done', site.summary);
  assert.ok((site.data.validations as { name: string; passed: boolean }[]).find((x) => x.name === 'internal links resolve')!.passed);
});

test('19 executable example → grounded in documented symbols, syntax-checked, not stored in the vault', async () => {
  const dir = fx('monorepo-libs');
  await generate(dir);
  const q = await vg(dir, '--mode', 'examples');
  assert.equal(q.status, 'needs_input');
  assert.deepEqual(q.questions.map((x) => x.id).sort(), ['example-goal', 'example-kind', 'example-project']);
  const r = await vg(dir, '--mode', 'examples', '--project', 'acme-utils', '--goal', 'retry a flaky call', '--kind', 'app');
  assert.equal(r.status, 'done', r.summary);
  const used = (r.data.usedSymbols as { name: string }[]).map((s) => s.name);
  assert.ok(used.includes('retry'));
  const out = path.join(dir, String(r.data.outDir));
  assert.ok(!out.startsWith(vaultOf(dir)), 'example lives outside the vault');
  assert.ok(fs.existsSync(path.join(out, 'package.json')) && fs.existsSync(path.join(out, 'README.md')));
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'vg-example.json'), 'utf8'));
  assert.equal(meta.validated, false, 'not validated without running it');
  assert.ok((r.data.validation as { step: string; passed?: boolean }[]).some((x) => x.step.startsWith('node --check') && x.passed), 'syntax check executed and passed');
  assert.ok(r.warnings.some((w) => /NOT validated/.test(w)));
});

test('20 the skill must ask → ambiguous structure, destination, parent workspace; nothing written before answers', async () => {
  const dir = fx('ambiguous');
  const before = snapshot(dir);
  const r = await vg(dir, '--mode', 'generate');
  assert.equal(r.status, 'needs_input');
  assert.equal(r.exitCode, 10);
  const ids = r.questions.map((q) => q.id);
  assert.ok(ids.includes('destination') && ids.includes('scope'), ids.join(','));
  for (const q of r.questions) assert.ok(q.prompt && q.why && (q.options.length || q.freeText), `well-formed question ${q.id}`);
  assert.deepEqual(snapshot(dir), before, 'nothing written');
  const libs = fx('monorepo-libs');
  const inner = await vg(path.join(libs, 'packages', 'http'), '--mode', 'generate', '--answer', 'destination=default');
  assert.ok(inner.questions.some((q) => q.id === 'parent-workspace'), 'inside a workspace package → asks');
  const a = await vg(dir, '--mode', 'analyze');
  assert.equal(a.status, 'done');
  assert.ok(a.questions.some((q) => q.id === 'scope'), 'analyze previews the questions without writing');
  assert.deepEqual(snapshot(dir), before);
});

test('extra: conflicting edits → conflict recorded, resolvable, restorable', async () => {
  const dir = fx('docs-only');
  await generate(dir);
  const v = vaultOf(dir);
  const n = noteByTitle(v, 'Second week');
  fs.writeFileSync(path.join(v, n.path), read(v, n.path).replace('Ship a first change.', 'Ship a first change TODAY.'));
  fs.writeFileSync(path.join(dir, 'onboarding/second-week.md'), '# Second week\n\nShip two changes.\n');
  const r = await vg(dir, '--mode', 'sync');
  assert.equal((r.data.conflicts as unknown[]).length, 1);
  assert.match(read(v, n.path), /TODAY/, 'user version stays in the note');
  assert.equal((noteByTitle(v, 'Second week').fm.vg as Record<string, unknown>).status, 'conflict');
  const list = await vg(dir, '--mode', 'conflicts');
  const c = (list.data.conflicts as { id: string; diff: string }[])[0];
  assert.match(c.diff, /two changes/);
  const res = await vg(dir, '--mode', 'conflicts', '--resolve', c.id, '--take', 'source');
  assert.equal(res.status, 'done', res.summary);
  assert.match(read(v, n.path), /Ship two changes/);
  assert.doesNotMatch(read(v, n.path), /<<<<<<<|TODAY/);
  assert.equal(loadManifest(v)!.conflicts.length, 0);
  const again = await vg(dir, '--mode', 'sync');
  assert.equal((again.data.counts as Record<string, number>).conflict ?? 0, 0, 'resolved conflict does not come back');
  const runs = await vg(dir, '--mode', 'restore');
  assert.ok((runs.data.runs as unknown[]).length >= 1);
  const backupRun = String(res.data.backupRun);
  const rest = await vg(dir, '--mode', 'restore', '--run', backupRun);
  assert.equal(rest.status, 'done', rest.summary);
  assert.match(read(v, n.path), /TODAY/, 'restored the version before resolution');
});

test('extra: instruction-like content is flagged as data', async () => {
  const dir = fx('injection');
  const r = await generate(dir);
  assert.equal(r.status, 'done');
  const v = vaultOf(dir);
  const readme = notes(v).find((n) => n.type === 'document')!;
  assert.match(readme.body, /> \[!danger\]/);
  assert.equal((readme.fm.vg as Record<string, unknown>).status, 'needs-review');
});

test('extra: reorganize proposes, applies with backups, keeps links valid', async () => {
  const dir = tmpDir();
  dirs.push(dir);
  writeTree(dir, {
    '.obsidian/app.json': '{}',
    'Index.md': '# Index\n\n[[deep/one/Lonely]] and [[Other]].\n',
    'deep/one/Lonely.md': '# Lonely\n\nBack to [[Index]].\n',
    'Other.md': '# Other\n',
  });
  const p = await vg(dir, '--mode', 'reorganize', '--vault', '.');
  assert.equal(p.status, 'dry_run');
  assert.ok((p.data.moves as { from: string }[]).some((m) => m.from === 'deep/one/Lonely.md'));
  const ask = await vg(dir, '--mode', 'reorganize', '--vault', '.', '--apply');
  assert.equal(ask.status, 'needs_input');
  const r = await vg(dir, '--mode', 'reorganize', '--vault', '.', '--apply', '--answer', 'reorganize-confirm=yes');
  assert.equal(r.status, 'done', r.summary);
  assert.ok(!fs.existsSync(path.join(dir, 'deep/one/Lonely.md')));
  assert.deepEqual(validateVault(dir).issues.filter((i) => i.code === 'broken-link'), []);
});

test('extra: plugins load only when trusted', async () => {
  const dir = tmpDir();
  dirs.push(dir);
  writeTree(dir, {
    'vault-generator.config.json': json({ plugins: ['plugins/adoc.mjs'] }),
    'plugins/adoc.mjs': "export default { analyzers: [{ id: 'adoc', version: '1', description: 'AsciiDoc test analyzer', handles: ['.adoc'], limitations: [], match: (f) => (f.ext === '.adoc' ? 30 : 0), analyze(f, ctx) { const body = ctx.read(f).replace(/^= (.*)$/m, '# $1'); return { documents: [{ key: `doc:${f.source}:${f.path}`, file: { source: f.source, path: f.path }, title: 'From AsciiDoc', kind: 'adoc', category: 'document', body, sections: [], links: [], codeBlocks: [], mermaid: 0, tables: 0, admonitions: [], lossy: [] }], entities: [], relations: [], facts: [], limitations: [], warnings: [] }; } }] };\n",
    'docs/page.adoc': '= Title\n\nHello from AsciiDoc.\n',
    'README.md': '# Plug\n\nTest.\n',
  });
  const r1 = await generate(dir);
  assert.ok(r1.warnings.some((w) => /untrusted plugin/.test(w)));
  assert.ok(!notes(vaultOf(dir)).some((n) => n.title === 'From AsciiDoc'));
  const r2 = await vg(dir, '--mode', 'sync', '--trust-plugins');
  assert.equal(r2.status, 'done');
  assert.ok(notes(vaultOf(dir)).some((n) => n.title === 'From AsciiDoc'), 'trusted plugin analyzer used');
  const caps = await vg(dir, '--mode', 'capabilities');
  assert.ok((caps.data.analyzers as { id: string; plugin?: boolean }[]).some((a) => a.id === 'adoc' && a.plugin));
});

test('extra: installer installs for both agents, is idempotent and never clobbers foreign skills', async () => {
  const target = tmpDir();
  dirs.push(target);
  const { spawnSync } = await import('node:child_process');
  const script = path.resolve(import.meta.dirname, '../../skills/vault-generator/scripts/install.ts');
  const run = (...a: string[]) => spawnSync(process.execPath, [script, '--target', target, '--json', ...a], { encoding: 'utf8' });
  const r1 = JSON.parse(run().stdout);
  assert.ok(r1.ok, JSON.stringify(r1));
  for (const d of ['.claude/skills/vault-generator', '.agents/skills/vault-generator']) {
    assert.ok(fs.existsSync(path.join(target, d, 'SKILL.md')), d);
    assert.ok(fs.existsSync(path.join(target, d, 'scripts/vendor/yaml.mjs')), `${d} vendored deps`);
  }
  const r2 = JSON.parse(run().stdout);
  assert.ok(r2.results.every((x: { action: string }) => x.action === 'up-to-date'));
  fs.appendFileSync(path.join(target, '.claude/skills/vault-generator/SKILL.md'), '\nlocal change\n');
  const r3 = JSON.parse(run().stdout);
  assert.ok(!r3.ok && r3.results.some((x: { action: string }) => x.action === 'refused'), 'locally modified copy is not overwritten');
  const r4 = JSON.parse(run('--force').stdout);
  assert.ok(r4.ok, JSON.stringify(r4));
  const backup = r4.results.find((x: { backup?: string }) => x.backup)?.backup as string;
  assert.ok(backup && fs.readFileSync(path.join(backup, 'SKILL.md'), 'utf8').includes('local change'), '--force keeps a backup of the modified copy');
  assert.deepEqual(fs.readdirSync(path.join(target, '.claude', 'skills')), ['vault-generator'], 'no backup folder inside the skills directory');
  assert.ok(fs.existsSync(path.join(target, '.claude/skills/vault-generator/LICENSE.txt')), 'licence travels with the installed skill');
  // the installed copy runs on its own (no repository files needed)
  const cli = path.join(target, '.agents/skills/vault-generator/scripts/vg.mjs');
  const caps = spawnSync(process.execPath, [cli, '--mode', 'capabilities', '--json'], { encoding: 'utf8', cwd: target });
  assert.equal(caps.status, 0, caps.stderr);
  assert.ok(JSON.parse(caps.stdout).data.sqliteFts5);
});

test('extra: an installed copy of the skill is not documented as part of the project', async () => {
  const dir = fx('small-readme');
  const { spawnSync } = await import('node:child_process');
  const script = path.resolve(import.meta.dirname, '../../skills/vault-generator/scripts/install.ts');
  assert.equal(spawnSync(process.execPath, [script, '--target', dir, '--agent', 'both'], { encoding: 'utf8' }).status, 0);
  const a = await vg(dir, '--mode', 'analyze');
  assert.equal((a.data.sources as { kind: string }[])[0].kind, 'single-project');
  assert.deepEqual((a.data.projects as { name: string }[]).map((p) => p.name), ['tiny-lib']);
  const r = await generate(dir);
  assert.equal(r.status, 'done', r.summary);
  const all = notes(vaultOf(dir)).map((n) => `${n.title} ${read(vaultOf(dir), n.path)}`).join('\n');
  assert.ok(!/SKILL\.md|vault-generator-scripts|Golden rules/.test(all), 'no note comes from .claude/ or .agents/');
});

test('extra: exports keep every note when several notes slugify to the same name', async () => {
  const dir = tmpDir('vg-slug-clash-');
  dirs.push(dir);
  writeTree(dir, {
    'package.json': json({ name: 'demo-orders', version: '1.0.0', main: 'src/index.ts' }),
    // the project note quotes only the README's first paragraph, so the marker lives in a later section
    'README.md': '# Demo Orders\n\nSmall orders service.\n\n## Getting started\nReadme marker alpha-readme.\n',
    'docs/index.md': '# Index\n\nIndex doc marker alpha-index.\n',
    'src/index.ts': '/** Starts the service. */\nexport function start(): void {}\n',
  });
  assert.equal((await generate(dir)).status, 'done');
  const v = vaultOf(dir);
  const all = notes(v);
  const slugs = all.map((n) => slugify(n.title));
  assert.ok(new Set(slugs).size < slugs.length, `fixture must contain colliding titles: ${all.map((n) => n.title).join(', ')}`);
  assert.ok(slugs.includes('index'), 'fixture must contain a note that would overwrite the site index page');
  const markers = ['alpha-readme', 'alpha-index'];
  const filesWith = (files: string[], dirPath: string, marker: string) => files.filter((f) => fs.readFileSync(path.join(dirPath, f), 'utf8').includes(marker));

  // static site: one page per note, plus the generated index/search page, nothing overwritten
  const site = await vg(dir, '--mode', 'export', '--to', 'html', '--output', 'site');
  assert.equal(site.status, 'done', site.summary);
  const siteChecks = site.data.validations as { name: string; passed: boolean }[];
  assert.ok(siteChecks.every((c) => c.passed), JSON.stringify(siteChecks));
  const pages = fs.readdirSync(path.join(dir, 'site')).filter((f) => f.endsWith('.html'));
  assert.equal(pages.length, all.length + 1, `pages: ${pages.join(', ')}`);
  assert.match(fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8'), /id="q"/, 'index.html is still the search page');
  for (const m of markers) assert.equal(filesWith(pages, path.join(dir, 'site'), m).length, 1, `${m} appears in exactly one page`);

  // exported skill: one reference per note, spec-valid, every link resolves
  const sk = await vg(dir, '--mode', 'export', '--to', 'skill', '--name', 'clash-skill', '--output', 'clash-skill');
  assert.equal(sk.status, 'done', sk.summary);
  assert.ok((sk.data.validations as { passed: boolean }[]).every((c) => c.passed), JSON.stringify(sk.data.validations));
  const refs = fs.readdirSync(path.join(dir, 'clash-skill/references'));
  assert.equal(refs.length, all.length, `references: ${refs.join(', ')}`);
  for (const m of markers) assert.equal(filesWith(refs.map((f) => `references/${f}`), path.join(dir, 'clash-skill'), m).length, 1, `${m} appears in exactly one reference`);
  const { validateSkillDir } = await import('../../skills/vault-generator/scripts/lib/skillcheck.ts');
  assert.ok(validateSkillDir(path.join(dir, 'clash-skill')).ok, 'exported skill is spec-valid');

  // bundle: every note has its own anchor, so links cannot jump to the wrong note
  const b = await vg(dir, '--mode', 'export', '--to', 'bundle', '--output', 'bundle.md');
  assert.equal(b.status, 'done', b.summary);
  const ids = [...fs.readFileSync(path.join(dir, 'bundle.md'), 'utf8').matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]);
  assert.equal(ids.length, all.length);
  assert.equal(new Set(ids).size, ids.length, `anchors are unique: ${ids.join(', ')}`);
});

test('extra: note region parsing survives in every generated note', async () => {
  const dir = fx('app-docs-examples');
  await generate(dir);
  const v = vaultOf(dir);
  for (const n of notes(v).filter((x) => x.hasVg)) assert.ok(parseNote(read(v, n.path)).hasMarkers, n.path);
});
