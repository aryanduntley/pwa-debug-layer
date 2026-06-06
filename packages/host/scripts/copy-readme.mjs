// Copy the repo-root README into this package right before it's packed, so the
// published npm tarball carries it (npm always includes a README that exists in
// the package dir, but our single source of truth lives at the repo root and
// pnpm only auto-copies LICENSE, not README). Run via the `prepack` lifecycle.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // packages/host/scripts
const pkg = join(here, '..'); // packages/host
const root = join(pkg, '..', '..'); // repo root

copyFileSync(join(root, 'README.md'), join(pkg, 'README.md'));
console.log('[copy-readme] root README.md → packages/host/ (for the published tarball)');
