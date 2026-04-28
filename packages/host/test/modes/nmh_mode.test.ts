import { describe, it, expect } from 'vitest';
import { extensionIdFromOrigin } from '../../src/modes/nmh_mode.js';

describe('extensionIdFromOrigin', () => {
  it('extracts id from a typical chrome-extension origin', () => {
    expect(extensionIdFromOrigin('chrome-extension://abcdefghijklmnop/')).toBe(
      'abcdefghijklmnop',
    );
  });

  it('accepts an origin without a trailing slash', () => {
    expect(extensionIdFromOrigin('chrome-extension://abcdef')).toBe('abcdef');
  });

  it('rejects an origin missing the chrome-extension scheme', () => {
    expect(() => extensionIdFromOrigin('https://example.com/')).toThrow(
      /cannot derive extensionId/,
    );
  });

  it('rejects an empty origin', () => {
    expect(() => extensionIdFromOrigin('')).toThrow(/cannot derive extensionId/);
  });

  it('rejects an origin with a path beyond the id', () => {
    expect(() =>
      extensionIdFromOrigin('chrome-extension://abc/extra/path'),
    ).toThrow(/cannot derive extensionId/);
  });

  it('rejects an origin with port-style colon in the id position', () => {
    expect(() => extensionIdFromOrigin('chrome-extension://host:8080/')).toThrow(
      /cannot derive extensionId/,
    );
  });
});
