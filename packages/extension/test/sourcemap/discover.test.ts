import { describe, it, expect } from 'vitest';
import { discoverSourceMapUrl } from '../../src/sourcemap/discover.js';

describe('discoverSourceMapUrl', () => {
  it('finds //# sourceMappingURL=relative.js.map and resolves against script URL', () => {
    const r = discoverSourceMapUrl(
      'https://x.com/dist/bundle.js',
      'console.log(1);\n//# sourceMappingURL=bundle.js.map\n',
    );
    expect(r).toBe('https://x.com/dist/bundle.js.map');
  });

  it('finds //# sourceMappingURL with absolute URL and returns it as-is', () => {
    const r = discoverSourceMapUrl(
      'https://x.com/dist/bundle.js',
      '//# sourceMappingURL=https://maps.example.com/bundle.js.map\n',
    );
    expect(r).toBe('https://maps.example.com/bundle.js.map');
  });

  it('accepts the legacy //@ sourceMappingURL form', () => {
    const r = discoverSourceMapUrl(
      'https://x.com/dist/bundle.js',
      'whatever\n//@ sourceMappingURL=bundle.js.map\n',
    );
    expect(r).toBe('https://x.com/dist/bundle.js.map');
  });

  it('returns null when no comment is present', () => {
    expect(
      discoverSourceMapUrl('https://x.com/bundle.js', 'console.log(1);\n'),
    ).toBeNull();
  });

  it('returns data: URLs as-is without resolving against script URL', () => {
    const r = discoverSourceMapUrl(
      'https://x.com/bundle.js',
      '//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n',
    );
    expect(r).toBe('data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==');
  });

  it('only scans the script tail (large prefix ignored)', () => {
    const head = 'x'.repeat(100_000);
    const tail = '\n//# sourceMappingURL=tail.js.map\n';
    const r = discoverSourceMapUrl('https://x.com/big.js', head + tail);
    expect(r).toBe('https://x.com/tail.js.map');
  });
});
