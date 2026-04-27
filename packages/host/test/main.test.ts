import { describe, it, expect } from 'vitest';
import { detectMode } from '../src/main.js';

describe('detectMode', () => {
  it('detects nmh when argv[1] is a chrome-extension:// origin', () => {
    expect(detectMode(['/usr/bin/node', 'chrome-extension://abcdef/', '/path/to/manifest.json'])).toBe('nmh');
  });
  it('falls back to mcp when argv[1] is missing', () => {
    expect(detectMode(['/usr/bin/node'])).toBe('mcp');
  });
  it('falls back to mcp when argv[1] is an unrelated string', () => {
    expect(detectMode(['/usr/bin/node', '--something', 'else'])).toBe('mcp');
  });
  it('falls back to mcp when argv[1] is a path that just contains chrome-extension', () => {
    expect(detectMode(['/usr/bin/node', '/some/path/chrome-extension'])).toBe('mcp');
  });
});
