#!/usr/bin/env node
/**
 * Interactive version bump — prints the current version, asks for the new one,
 * and sets it in lockstep across EVERY manifest (the npm packages, the MCP
 * registry server.json + its nested package entry, and the Claude Code
 * plugin/marketplace files), then syncs the pnpm lockfile.
 *
 * No git operations — pair it with gitpush.sh, which handles commit + tag +
 * push. Typical release:  node scripts/bump-version.mjs  →  gitpush.sh
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Each manifest + how to set its version. server.json carries it twice (the
// top-level version AND packages[0].version) — both must move together.
const FILES = [
  ['package.json', (j, v) => { j.version = v; }],
  ['packages/host/package.json', (j, v) => { j.version = v; }],
  ['packages/shared/package.json', (j, v) => { j.version = v; }],
  ['packages/extension/package.json', (j, v) => { j.version = v; }],
  ['server.json', (j, v) => { j.version = v; if (j.packages?.[0]) j.packages[0].version = v; }],
  ['.claude-plugin/plugin.json', (j, v) => { j.version = v; }],
  ['.claude-plugin/marketplace.json', (j, v) => { j.version = v; }],
];

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

// Current version comes from the root manifest; flag any file that disagrees so
// a prior drift gets noticed (the bump unifies them regardless).
const current = readJson('package.json').version;
const drift = FILES
  .map(([f]) => [f, readJson(f).version])
  .filter(([, v]) => v !== current);

console.log(`Current version: ${current}`);
if (drift.length) {
  console.log('  (these differ and will be unified:)');
  for (const [f, v] of drift) console.log(`    ${f} = ${v}`);
}

const rl = createInterface({ input, output });
const answer = (await rl.question('Enter new version (blank = cancel): ')).trim();
rl.close();

if (!answer) {
  console.log('Cancelled — nothing changed.');
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(answer)) {
  console.error(`✗ "${answer}" is not a valid semver version (expected e.g. 0.1.2).`);
  process.exit(1);
}

for (const [rel, mutate] of FILES) {
  const abs = join(root, rel);
  const j = JSON.parse(readFileSync(abs, 'utf8'));
  mutate(j, answer);
  writeFileSync(abs, JSON.stringify(j, null, 2) + '\n');
  console.log(`  set ${rel} → ${answer}`);
}

try {
  execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });
  console.log('✓ lockfile synced');
} catch {
  console.warn('! pnpm install --lockfile-only failed — sync the lockfile manually if needed.');
}

console.log(`
✓ All manifests set to ${answer}.

Next steps:
  1. Release to npm:
       gitpush.sh   → pick this repo, enter ${answer} as the version
       (tags v${answer} → the publish workflow builds + publishes to npm)

  2. Update the MCP registry — AFTER ${answer} is live on npm:
       mcp-publisher login github
       mcp-publisher publish        # reads ./server.json (now at ${answer})
`);
