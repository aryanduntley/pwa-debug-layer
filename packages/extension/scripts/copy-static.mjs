import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const dist = resolve(pkgRoot, 'dist');

await mkdir(dist, { recursive: true });
await copyFile(resolve(pkgRoot, 'manifest.json'), resolve(dist, 'manifest.json'));
console.log('[copy-static] manifest.json -> dist/');
