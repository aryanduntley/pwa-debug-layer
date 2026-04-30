import { describe, it, expect } from 'vitest';
import {
  isInternalLog,
  stripExtensionFrames,
} from '../../src/captures/filter.js';

describe('isInternalLog', () => {
  it('returns true for [pwa-debug/...] string args', () => {
    expect(isInternalLog(['[pwa-debug/page] foo'])).toBe(true);
    expect(isInternalLog(['[pwa-debug/cs] attached'])).toBe(true);
    expect(isInternalLog(['[pwa-debug/sw] up'])).toBe(true);
  });

  it('returns true even when only the prefix is present', () => {
    expect(isInternalLog(['[pwa-debug/'])).toBe(true);
  });

  it('returns false for normal log args', () => {
    expect(isInternalLog(['hello world'])).toBe(false);
    expect(isInternalLog(['[other-tag] foo'])).toBe(false);
    expect(isInternalLog(['pwa-debug/page'])).toBe(false);
  });

  it('returns false for empty args', () => {
    expect(isInternalLog([])).toBe(false);
  });

  it('returns false when first arg is not a string', () => {
    expect(isInternalLog([{ msg: '[pwa-debug/page]' }])).toBe(false);
    expect(isInternalLog([42])).toBe(false);
    expect(isInternalLog([null])).toBe(false);
    expect(isInternalLog([undefined])).toBe(false);
    expect(isInternalLog([['[pwa-debug/'] as unknown])).toBe(false);
  });

  it('only inspects args[0] (later args ignored)', () => {
    expect(isInternalLog(['plain', '[pwa-debug/page] hidden'])).toBe(false);
  });
});

describe('stripExtensionFrames', () => {
  it('drops leading chrome-extension:// frames and keeps the first user frame', () => {
    const input = [
      'Error',
      '    at captureStack (chrome-extension://aaa/page-world.js:155:23)',
      '    at buildConsoleEvent (chrome-extension://aaa/page-world.js:164:35)',
      '    at console.warn (chrome-extension://aaa/page-world.js:194:30)',
      '    at <anonymous>:1:9',
      '    at userFn (https://example.com/app.js:42:7)',
    ].join('\n');
    const out = stripExtensionFrames(input);
    expect(out).toBe(
      ['    at <anonymous>:1:9', '    at userFn (https://example.com/app.js:42:7)'].join('\n'),
    );
  });

  it('keeps user-only stacks unchanged (just drops the header line)', () => {
    const input = [
      'Error',
      '    at userFn (https://example.com/app.js:42:7)',
      '    at app (https://example.com/app.js:1:1)',
    ].join('\n');
    expect(stripExtensionFrames(input)).toBe(
      ['    at userFn (https://example.com/app.js:42:7)', '    at app (https://example.com/app.js:1:1)'].join('\n'),
    );
  });

  it('falls back to the header-skipped form when all frames are extension frames', () => {
    const input = [
      'Error',
      '    at f1 (chrome-extension://aaa/page-world.js:1:1)',
      '    at f2 (chrome-extension://aaa/page-world.js:2:2)',
    ].join('\n');
    expect(stripExtensionFrames(input)).toBe(
      ['    at f1 (chrome-extension://aaa/page-world.js:1:1)', '    at f2 (chrome-extension://aaa/page-world.js:2:2)'].join('\n'),
    );
  });

  it('handles single-line stacks (header only) gracefully', () => {
    expect(stripExtensionFrames('Error')).toBe('');
  });

  it('handles empty stacks gracefully', () => {
    expect(stripExtensionFrames('')).toBe('');
  });
});
