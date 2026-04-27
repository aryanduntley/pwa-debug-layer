import { builtinModules } from 'node:module';
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

const externalPackages = new Set([
  '@modelcontextprotocol/sdk',
  'better-sqlite3',
]);

export default {
  input: 'src/main.ts',
  output: {
    file: 'dist/main.js',
    format: 'esm',
    sourcemap: true,
    banner: '#!/usr/bin/env node',
  },
  external: (id) =>
    nodeBuiltins.has(id) ||
    [...externalPackages].some((pkg) => id === pkg || id.startsWith(`${pkg}/`)),
  plugins: [
    nodeResolve({ preferBuiltins: true, exportConditions: ['node', 'import', 'default'] }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      sourceMap: true,
      declaration: false,
      declarationMap: false,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      outputToFilesystem: true,
    }),
  ],
};
