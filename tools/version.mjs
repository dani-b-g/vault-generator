// Keeps the project version in one place and checks that nothing drifted.
//
//   node tools/version.mjs check [--tag vX.Y.Z]   every file agrees, the installed copies are current,
//                                                 and (with --tag) the version matches the tag
//   node tools/version.mjs set X.Y.Z              rewrite every file, then refresh the installed copies
//   node tools/version.mjs next patch|minor|major [--beta]
//                                                 print the next version (same rules as `npm version`):
//                                                 0.1.0 -> patch 0.1.1, minor 0.2.0, major 1.0.0;
//                                                 with --beta, 0.2.0-beta.1, then 0.2.0-beta.2 …
//
// Zero dependencies: it only needs Node, so CI can run it before `npm ci`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(root, 'skills/vault-generator/scripts/install.ts');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// Each pattern has three groups: text before the version, the version, text after it.
const TARGETS = [
  { file: 'package.json', re: /^(  "version":\s*")([^"]+)(")/m },
  { file: 'package-lock.json', re: /^(  "version":\s*")([^"]+)(")/m },
  { file: 'package-lock.json', re: /("packages":\s*\{\s*"":\s*\{[^}]*?"version":\s*")([^"]+)(")/ },
  { file: 'skills/vault-generator/SKILL.md', re: /^(  version:\s*")([^"]+)(")/m },
  { file: 'skills/vault-generator/scripts/lib/state.ts', re: /(export const TOOL_VERSION = ')([^']+)(')/ },
  { file: 'README.md', re: /(early release \(`)([^`]+)(`\))/ },
  { file: 'README.es.md', re: /(versión inicial \(`)([^`]+)(`\))/ },
];

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function current() {
  return TARGETS.map(({ file, re }) => {
    const m = re.exec(read(file));
    if (!m) throw new Error(`${file}: version not found (pattern ${re})`);
    return { file, version: m[2] };
  });
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function installedCopiesAreCurrent() {
  // The installer's dry run reports "up-to-date" for each copy that matches the skill.
  const r = spawnSync(process.execPath, [INSTALLER, '--target', root, '--agent', 'both', '--dry-run', '--json'], { encoding: 'utf8' });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    fail(`installer dry run produced no JSON:\n${r.stdout}${r.stderr}`);
  }
  return report.results.filter((x) => x.action !== 'up-to-date');
}

function check(tag) {
  const found = current();
  const versions = [...new Set(found.map((f) => f.version))];
  for (const f of found) console.log(`${f.version.padEnd(14)} ${f.file}`);
  if (versions.length !== 1) fail(`files disagree on the version: ${versions.join(', ')}. Run: npm run version:set -- <version>`);
  const [version] = versions;
  if (!SEMVER.test(version)) fail(`"${version}" is not a valid version (expected X.Y.Z or X.Y.Z-prerelease)`);
  if (tag !== undefined && tag !== `v${version}`) fail(`tag "${tag}" does not match version ${version} (expected v${version})`);
  const stale = installedCopiesAreCurrent();
  if (stale.length) {
    fail(`installed copies are out of date (${stale.map((s) => `${s.agent}: ${s.action}`).join(', ')}). Run: npm run install:project`);
  }
  console.log(`ok: version ${version}${tag ? ` matches ${tag}` : ''}, installed copies are current`);
}

function set(raw) {
  const version = (raw ?? '').replace(/^v/, '');
  if (!SEMVER.test(version)) fail(`usage: node tools/version.mjs set X.Y.Z   (got "${raw ?? ''}")`);
  const byFile = new Map();
  for (const t of TARGETS) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t.re]);
  for (const [file, patterns] of byFile) {
    // string replacement keeps each file's formatting and line endings untouched
    let text = read(file);
    for (const re of patterns) {
      if (!re.test(text)) fail(`${file}: version not found (pattern ${re})`);
      text = text.replace(re, `$1${version}$3`);
    }
    fs.writeFileSync(path.join(root, file), text);
  }
  console.log(`version set to ${version} in ${byFile.size} files`);
  const r = spawnSync(process.execPath, [INSTALLER, '--target', root, '--agent', 'both'], { stdio: 'inherit' });
  if (r.status !== 0) fail('refreshing the installed copies failed (see above)');
  check();
}

function next(bump, beta) {
  if (!['patch', 'minor', 'major'].includes(bump)) fail(`usage: node tools/version.mjs next patch|minor|major [--beta]   (got "${bump ?? ''}")`);
  const versions = [...new Set(current().map((f) => f.version))];
  if (versions.length !== 1) fail(`files disagree on the version: ${versions.join(', ')}`);
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(versions[0]);
  if (!m) fail(`"${versions[0]}" is not a valid version`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4];
  // Same rules as `npm version`: bumping a pre-release finishes it when it was already at that level.
  if (bump === 'major') {
    if (minor !== 0 || patch !== 0 || !pre) major++;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    if (patch !== 0 || !pre) minor++;
    patch = 0;
  } else if (!pre) patch++;
  const base = `${major}.${minor}.${patch}`;
  if (!beta) return console.log(base);
  const prev = /^beta\.(\d+)$/.exec(pre ?? '');
  const sameBase = base === `${m[1]}.${m[2]}.${m[3]}`;
  console.log(`${base}-beta.${prev && sameBase ? Number(prev[1]) + 1 : 1}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'check') {
  const i = rest.indexOf('--tag');
  check(i === -1 ? undefined : rest[i + 1]);
} else if (cmd === 'set') {
  set(rest[0]);
} else if (cmd === 'next') {
  next(rest[0], rest.includes('--beta'));
} else {
  fail('usage: node tools/version.mjs check [--tag vX.Y.Z] | set X.Y.Z | next patch|minor|major [--beta]');
}
