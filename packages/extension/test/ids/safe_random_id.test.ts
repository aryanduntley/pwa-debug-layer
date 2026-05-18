import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeRandomId, safeUuid } from '../../src/ids/safe_random_id.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safeRandomId', () => {
  it('returns crypto.randomUUID() verbatim when available (no prefix applied)', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-uuid-1234' });
    expect(safeRandomId()).toBe('fixed-uuid-1234');
    expect(safeRandomId('f_')).toBe('fixed-uuid-1234');
  });

  it('falls back to a prefixed ts+random id when crypto.randomUUID is absent', () => {
    vi.stubGlobal('crypto', {});
    expect(safeRandomId('f_')).toMatch(/^f_[0-9a-z]+_[0-9a-z]+$/);
    expect(safeRandomId('x_')).toMatch(/^x_[0-9a-z]+_[0-9a-z]+$/);
    expect(safeRandomId('w_')).toMatch(/^w_[0-9a-z]+_[0-9a-z]+$/);
  });

  it('falls back with no leading separator when prefix is omitted', () => {
    vi.stubGlobal('crypto', {});
    expect(safeRandomId()).toMatch(/^[0-9a-z]+_[0-9a-z]+$/);
  });

  it('falls back when crypto exists but randomUUID is not a function (robust guard)', () => {
    vi.stubGlobal('crypto', { randomUUID: 'not-a-function' });
    expect(safeRandomId('f_')).toMatch(/^f_[0-9a-z]+_[0-9a-z]+$/);
  });

  it('falls back when crypto itself is undefined', () => {
    vi.stubGlobal('crypto', undefined);
    expect(safeRandomId('w_')).toMatch(/^w_[0-9a-z]+_[0-9a-z]+$/);
  });

  it('produces distinct ids on successive fallback calls', () => {
    vi.stubGlobal('crypto', {});
    expect(safeRandomId('x_')).not.toBe(safeRandomId('x_'));
  });
});

describe('safeUuid', () => {
  it('delegates to crypto.randomUUID() when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-abc' });
    expect(safeUuid()).toBe('uuid-abc');
  });

  it('returns an unprefixed fallback when crypto.randomUUID is absent', () => {
    vi.stubGlobal('crypto', {});
    expect(safeUuid()).toMatch(/^[0-9a-z]+_[0-9a-z]+$/);
  });
});
