import { access, cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundles the built extension into the host package so the published tarball
// is self-contained: resolveExtensionPath() looks for <hostPkgRoot>/extension
// (sandbox_paths.defaultExtensionCandidates candidate #2). Without this step
// only the monorepo dev sibling or PWA_DEBUG_EXTENSION_PATH override resolves.

const here = dirname(fileURLToPath(import.meta.url));
const hostRoot = resolve(here, '..');
const src = resolve(hostRoot, '..', 'extension', 'dist');
const dest = resolve(hostRoot, 'extension');

try {
  await access(resolve(src, 'manifest.json'));
} catch {
  console.error(
    `[bundle-extension] extension dist not found at ${src}\n` +
      '  Build the extension first (pnpm --filter @pwa-debug/extension build).\n' +
      '  In a workspace build the extension devDependency forces this order.',
  );
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await cp(src, dest, {
  recursive: true,
  // Skip TS incremental-build metadata — not part of the loadable extension.
  filter: (path) => !path.endsWith('.tsbuildinfo'),
});
console.log(`[bundle-extension] ${src} -> ${dest}`);
