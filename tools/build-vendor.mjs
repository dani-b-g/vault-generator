// Bundles the small third-party parsers shipped inside the skill, so the skill
// needs no `npm install` when copied into another project.
// Usage: npm run vendor   (requires devDependencies: esbuild, yaml, smol-toml)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'skills/vault-generator/scripts/vendor');
mkdirSync(out, { recursive: true });

const libs = [
  { name: 'yaml', entry: 'node_modules/yaml/dist/index.js', license: 'node_modules/yaml/LICENSE' },
  { name: 'smol-toml', entry: 'node_modules/smol-toml/dist/index.js', license: 'node_modules/smol-toml/LICENSE' },
];
const manifest = [];
for (const lib of libs) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'node_modules', lib.name, 'package.json'), 'utf8'));
  await build({
    entryPoints: [path.join(root, lib.entry)],
    outfile: path.join(out, `${lib.name}.mjs`),
    bundle: true, format: 'esm', platform: 'node', target: 'node22', minify: true, legalComments: 'none',
    // CJS sources bundled to ESM still call require() for node builtins: provide one.
    banner: {
      js: `// ${lib.name}@${pkg.version} (${pkg.license}) - vendored by tools/build-vendor.mjs. See LICENSE-${lib.name}.txt\nimport { createRequire as __vgCreateRequire } from 'node:module'; const require = __vgCreateRequire(import.meta.url);`,
    },
  });
  copyFileSync(path.join(root, lib.license), path.join(out, `LICENSE-${lib.name}.txt`));
  manifest.push({ name: lib.name, version: pkg.version, license: pkg.license });
}
writeFileSync(path.join(out, 'vendor.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('vendored:', manifest.map((m) => `${m.name}@${m.version}`).join(', '));
