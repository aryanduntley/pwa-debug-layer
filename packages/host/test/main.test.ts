import { describe, it, expect } from 'vitest';
import { detectMode } from '../src/main.js';

// detectMode receives userArgs (process.argv.slice(2)) — origin URL is at index 0.
describe('detectMode', () => {
  it('detects nmh when userArgs[0] is a chrome-extension:// origin', () => {
    expect(detectMode(['chrome-extension://abcdef/'])).toBe('nmh');
  });
  it('detects nmh when a --parent-window arg follows (Windows shape)', () => {
    expect(detectMode(['chrome-extension://abcdef/', '--parent-window=12345'])).toBe('nmh');
  });
  it('falls back to mcp when userArgs is empty', () => {
    expect(detectMode([])).toBe('mcp');
  });
  it('falls back to mcp when userArgs[0] is an unrelated string', () => {
    expect(detectMode(['--something', 'else'])).toBe('mcp');
  });
  it('falls back to mcp when userArgs[0] is a path that just contains chrome-extension', () => {
    expect(detectMode(['/some/path/chrome-extension'])).toBe('mcp');
  });
});
