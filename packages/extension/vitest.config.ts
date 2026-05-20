import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    name: 'extension',
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    alias: {
      // rrweb 2.0.0-alpha.4 ships a CJS "main" that Node's ESM loader chokes
      // on under "type: module". Tests don't need rrweb's real implementation
      // — the rrweb_record manager accepts an injected recorder — so we alias
      // it to a tiny stub here. Production builds via rollup resolve the ESM
      // "module" entry directly and import the real package.
      rrweb: fileURLToPath(new URL('./test/_stubs/rrweb.ts', import.meta.url)),
    },
  },
});
