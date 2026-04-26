import nodeResolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const tsPlugin = () =>
  typescript({
    tsconfig: './tsconfig.json',
    sourceMap: true,
    declaration: false,
    declarationMap: false,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    outputToFilesystem: true,
  });

const resolvePlugin = () =>
  nodeResolve({ browser: true, exportConditions: ['browser', 'import', 'default'] });

export default [
  {
    input: 'src/service-worker.ts',
    output: { file: 'dist/service-worker.js', format: 'esm', sourcemap: true },
    plugins: [resolvePlugin(), tsPlugin()],
  },
  {
    input: 'src/content-script.ts',
    output: { file: 'dist/content-script.js', format: 'iife', sourcemap: true },
    plugins: [resolvePlugin(), tsPlugin()],
  },
  {
    input: 'src/page-world.ts',
    output: {
      file: 'dist/page-world.js',
      format: 'iife',
      name: 'PwaDebugPageWorld',
      sourcemap: true,
    },
    plugins: [resolvePlugin(), tsPlugin()],
  },
];
