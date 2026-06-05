import { describe, it, expect } from 'vitest';
import { classifyAsset } from '../../src/update_analysis/classify.js';

describe('classifyAsset', () => {
  it('prefers content-type when it maps to a known kind', () => {
    expect(classifyAsset('/whatever', 'text/html; charset=utf-8')).toBe('html');
    expect(classifyAsset('/whatever', 'application/javascript')).toBe('js');
    expect(classifyAsset('/whatever', 'text/css')).toBe('css');
    expect(classifyAsset('/whatever', 'application/ecmascript')).toBe('js');
  });

  it('falls back to the URL extension when content-type is null or unknown', () => {
    expect(classifyAsset('https://x/app.abc123.js', null)).toBe('js');
    expect(classifyAsset('https://x/styles.css', null)).toBe('css');
    expect(classifyAsset('https://x/index.html', null)).toBe('html');
    expect(classifyAsset('https://x/main.mjs', 'application/octet-stream')).toBe('js');
  });

  it('ignores query + fragment when reading the extension', () => {
    expect(classifyAsset('https://x/chunk.4f2.js?v=9#x', null)).toBe('js');
  });

  it('treats a bare navigation path (no file extension) as HTML', () => {
    expect(classifyAsset('https://x/', null)).toBe('html');
    expect(classifyAsset('https://x/app/dashboard', null)).toBe('html');
  });

  it('returns other for an unrecognized extension', () => {
    expect(classifyAsset('https://x/logo.png', null)).toBe('other');
  });
});
