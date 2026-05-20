import { describe, it, expect } from 'vitest';
import { compileSourceFilter } from '../src/index.js';

describe('compileSourceFilter — undefined / empty spec', () => {
  it('undefined spec yields an allow-all predicate', () => {
    const r = compileSourceFilter(undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.predicate({ kind: 'console', level: 'log' })).toBe(true);
    expect(r.predicate({})).toBe(true);
  });

  it('empty FilterSpec yields an allow-all predicate', () => {
    const r = compileSourceFilter({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.predicate({ kind: 'console' })).toBe(true);
  });
});

describe('compileSourceFilter — level filter', () => {
  it('accepts events whose level is in the set', () => {
    const r = compileSourceFilter({ level: ['error', 'warn'] });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate({ level: 'error' })).toBe(true);
    expect(r.predicate({ level: 'warn' })).toBe(true);
  });

  it('drops events whose level is absent from the set', () => {
    const r = compileSourceFilter({ level: ['error'] });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate({ level: 'info' })).toBe(false);
    expect(r.predicate({ level: 'log' })).toBe(false);
  });

  it('drops events that have no level field at all', () => {
    const r = compileSourceFilter({ level: ['error'] });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate({ kind: 'network' })).toBe(false);
  });

  it('empty level array = no level restriction (allow-all on level)', () => {
    const r = compileSourceFilter({ level: [] });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate({ level: 'log' })).toBe(true);
    expect(r.predicate({ kind: 'network' })).toBe(true);
  });
});

describe('compileSourceFilter — include pattern', () => {
  it('keeps events whose JSON.stringify matches any include pattern', () => {
    const r = compileSourceFilter({ pattern: { include: ['boom', 'kaboom'] } });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate({ message: 'boom goes the dynamite' })).toBe(true);
    expect(r.predicate({ message: 'kaboom' })).toBe(true);
  });

  it('drops events that match no include pattern', () => {
    const r = compileSourceFilter({ pattern: { include: ['boom'] } });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate({ message: 'all is well' })).toBe(false);
  });
});

describe('compileSourceFilter — exclude pattern', () => {
  it('drops events matching any exclude pattern', () => {
    const r = compileSourceFilter({ pattern: { exclude: ['noisy'] } });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate({ message: 'noisy event' })).toBe(false);
    expect(r.predicate({ message: 'fine' })).toBe(true);
  });

  it('exclude wins over include when both match', () => {
    const r = compileSourceFilter({
      pattern: { include: ['important'], exclude: ['heartbeat'] },
    });
    if (!r.ok) throw new Error('compile failed');
    expect(
      r.predicate({ message: 'important heartbeat' }),
    ).toBe(false);
    expect(r.predicate({ message: 'important alert' })).toBe(true);
  });
});

describe('compileSourceFilter — level + pattern composition', () => {
  it('both must pass', () => {
    const r = compileSourceFilter({
      level: ['error'],
      pattern: { include: ['boom'] },
    });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate({ level: 'error', message: 'boom' })).toBe(true);
    expect(r.predicate({ level: 'info', message: 'boom' })).toBe(false);
    expect(r.predicate({ level: 'error', message: 'fine' })).toBe(false);
  });
});

describe('compileSourceFilter — invalid regex', () => {
  it('returns ok:false with correct fieldPath for malformed include', () => {
    const r = compileSourceFilter({ pattern: { include: ['ok', '[unclosed'] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('pattern_invalid');
    expect(r.error.fieldPath).toBe('pattern.include[1]');
    expect(r.error.error.length).toBeGreaterThan(0);
  });

  it('returns ok:false with correct fieldPath for malformed exclude', () => {
    const r = compileSourceFilter({ pattern: { exclude: ['[unclosed'] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.fieldPath).toBe('pattern.exclude[0]');
  });
});

describe('compileSourceFilter — JSON.stringify edge cases', () => {
  it('events that cannot be stringified yield empty text (pattern misses)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = compileSourceFilter({ pattern: { include: ['anything'] } });
    if (!r.ok) throw new Error('compile failed');
    expect(r.predicate(circular)).toBe(false);
  });
});
