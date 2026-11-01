#!/usr/bin/env node
/**
 * Interactive version bump — prints the current version, asks for the new one,
 * and sets it in lockstep across EVERY manifest (the npm packages, the MCP
 * registry server.json + its nested package entry, and the Claude Code
 * plugin/marketplace files) after a y/N confirmation, then syncs the pnpm
 * lockfile and, unless you decline at the [Y/n] prompt, rebuilds every package
 * (pnpm -r build) so the committed build output matches. Same flow as
 * aimfp's dev/bump-version.py.
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

// One line iterator for every prompt: rl.question() can drop lines that arrive
// before it is called (piped input), which hangs the second prompt.
const rl = createInterface({ input, output, terminal: input.isTTY === true });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => {
  output.write(q);
  const next = await lines.next();
  if (!input.isTTY) output.write('\n');
  return next.done ? '' : String(next.value).trim();
};
const quit = (msg, code = 0) => {
  rl.close();
  if (code === 0) console.log(msg);
  else console.error(msg);
  process.exit(code);
};

const answer = await ask('Enter new version (blank = cancel): ');
if (!answer) quit('Cancelled — nothing changed.');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(answer)) {
  quit(`✗ "${answer}" is not a valid semver version (expected e.g. 0.1.2).`, 1);
}

console.log(`\nWill set every manifest to: ${answer}`);
const confirm = (await ask('Proceed? [y/N]: ')).toLowerCase();
if (confirm !== 'y' && confirm !== 'yes') quit('Aborted — nothing changed.');

console.log();
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

// Rebuild so the committed build output (packages/host/dist, packages/host/extension)
// matches the source and carries the new version before gitpush commits it.
const build = (await ask('\nRun build? [Y/n]: ')).toLowerCase();
rl.close();
let built = false;
if (build === '' || build === 'y' || build === 'yes') {
  console.log('\nBuilding (pnpm -r build)…');
  try {
    execFileSync('pnpm', ['-r', 'build'], { cwd: root, stdio: 'inherit' });
    console.log('✓ build complete');
    built = true;
  } catch {
    console.error(`✗ Build failed. Versions are set to ${answer}, but fix the build and run \`pnpm -r build\` before gitpush.`);
    process.exit(1);
  }
} else {
  console.log('Skipped build — run `pnpm -r build` before gitpush so the committed build output matches.');
}

console.log(`
✓ All manifests set to ${answer}${built ? ' and rebuilt' : ' (not rebuilt)'}.

Next steps:
  1. Release to npm:
       gitpush.sh   → pick this repo, enter ${answer} as the version
       (tags v${answer} → the publish workflow builds + publishes to npm)

  2. Update the MCP registry — AFTER ${answer} is live on npm:
       mcp-publisher login github
       mcp-publisher publish        # reads ./server.json (now at ${answer})
`);
