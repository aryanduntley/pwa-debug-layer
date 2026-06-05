#!/usr/bin/env node
/**
 * Version push script — the trigger half of the tag-driven publish flow
 * (.github/workflows/publish.yml fires on a vX.Y.Z tag). Mirrors py-trkpac's
 * bump-version-then-push pattern, adapted to this Node monorepo: it sets EVERY
 * version field in lockstep so the npm packages, the MCP registry server.json,
 * and the Claude Code plugin/marketplace manifests never drift apart.
 *
 *   node scripts/release.mjs <version> [--no-push]
 *   node scripts/release.mjs 0.2.0
 *
 * Steps: validate (clean tree, semver, tag is free) -> rewrite versions ->
 * sync lockfile -> commit "release: vX.Y.Z" -> tag vX.Y.Z -> push --follow-tags.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noPush = args.includes('--no-push');
const version = args.find((a) => !a.startsWith('--'));

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

if (!version) die('usage: node scripts/release.mjs <version> [--no-push]');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die(`not a semver version: ${version}`);

const tag = `v${version}`;

// ── Guards ───────────────────────────────────────────────────────────────────
if (git('status', '--porcelain')) die('working tree is not clean — commit or stash first.');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') console.warn(`! on branch "${branch}", not main — continuing.`);
const tags = git('tag', '--list', tag);
if (tags) die(`tag ${tag} already exists.`);

// ── Version edits ────────────────────────────────────────────────────────────
// Each entry: file path + a mutator that sets the version field(s) on the parsed
// JSON. Re-serialized as 2-space JSON (matches the existing files → tiny diffs).
const edits = [
  ['package.json', (j) => { j.version = version; }],
  ['packages/host/package.json', (j) => { j.version = version; }],
  ['packages/shared/package.json', (j) => { j.version = version; }],
  ['packages/extension/package.json', (j) => { j.version = version; }],
  ['server.json', (j) => { j.version = version; if (j.packages?.[0]) j.packages[0].version = version; }],
  ['.claude-plugin/plugin.json', (j) => { j.version = version; }],
  ['.claude-plugin/marketplace.json', (j) => { j.version = version; }],
];

const changed = [];
for (const [rel, mutate] of edits) {
  const abs = join(root, rel);
  const json = JSON.parse(readFileSync(abs, 'utf8'));
  mutate(json);
  writeFileSync(abs, JSON.stringify(json, null, 2) + '\n');
  changed.push(rel);
  console.log(`  set ${rel} → ${version}`);
}

// Keep the lockfile's versions in sync (no install, just metadata).
try {
  execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });
  changed.push('pnpm-lock.yaml');
} catch {
  console.warn('! pnpm install --lockfile-only failed (skipping lockfile sync).');
}

// ── Commit, tag, push ────────────────────────────────────────────────────────
git('add', ...changed);
git('commit', '-m', `release: ${tag}`);
git('tag', '-a', tag, '-m', `release ${tag}`);
console.log(`✓ committed + tagged ${tag}`);

if (noPush) {
  console.log(`\nSkipped push (--no-push). When ready:\n  git push origin ${branch} --follow-tags`);
} else {
  git('push', 'origin', branch, '--follow-tags');
  console.log(`✓ pushed ${branch} + ${tag} — the publish workflow will run on the tag.`);
}
