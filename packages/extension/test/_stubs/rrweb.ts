// Test-only stub for rrweb. The real package's npm-published CJS entry trips
// Node's "type: module" enforcement in vitest. Production builds use rollup
// which resolves the ESM entry directly. The page-world recorder accepts an
// injected `recorder` option for unit tests, so the stub's `record` only
// needs to satisfy the type signature — it is never called in practice.
export const record = (_opts: unknown): (() => void) | undefined => {
  void _opts;
  return undefined;
};

export default { record };
