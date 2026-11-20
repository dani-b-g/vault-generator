#!/usr/bin/env node
// vault-generator CLI entry point. Requires Node >= 22.18 (native TypeScript type stripping and node:sqlite).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`vault-generator requires Node.js >= 22.18 (found ${process.versions.node}).\n`);
  process.exit(1);
}
// keep stdout clean for JSON consumers: node:sqlite may emit an ExperimentalWarning on some versions
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite|Type Stripping/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});
const { main } = await import('./lib/cli.ts');
process.exitCode = await main(process.argv.slice(2));
