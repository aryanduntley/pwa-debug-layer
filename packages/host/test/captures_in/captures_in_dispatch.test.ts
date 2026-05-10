import { describe, it, expect, vi } from 'vitest';
import {
  createCapturesRegistry,
  dispatchCapturesEvent,
  CAPTURES_EVENT_TOOL,
  type HostCapturedEvent,
} from '../../src/captures_in/captures_in.js';
import type { IpcEventEnvelope } from '../../src/mcp/ipc/envelope.js';

const env = (overrides: Partial<IpcEventEnvelope> = {}): IpcEventEnvelope =>
  Object.freeze({
    type: 'event' as const,
    tool: CAPTURES_EVENT_TOOL,
    extensionId: 'ext-aaa',
    payload: {
      events: [{ kind: 'console', ts: 1, level: 'log' }] as readonly HostCapturedEvent[],
    },
    ...overrides,
  });

describe('createCapturesRegistry', () => {
  it('getOrCreate returns the same CapturesIn instance for repeat calls with same extId', () => {
    const reg = createCapturesRegistry();
    const a = reg.getOrCreate('ext-1');
    const b = reg.getOrCreate('ext-1');
    expect(a).toBe(b);
  });

  it('different extensionIds get distinct CapturesIn instances', () => {
    const reg = createCapturesRegistry();
    const a = reg.getOrCreate('ext-1');
    const b = reg.getOrCreate('ext-2');
    expect(a).not.toBe(b);
    expect(a.getStats().extensionId).toBe('ext-1');
    expect(b.getStats().extensionId).toBe('ext-2');
  });

  it('get() is non-allocating — returns undefined before getOrCreate', () => {
    const reg = createCapturesRegistry();
    expect(reg.get('ext-1')).toBeUndefined();
    reg.getOrCreate('ext-1');
    expect(reg.get('ext-1')).toBeDefined();
  });

  it('list() returns all registered entries', () => {
    const reg = createCapturesRegistry();
    reg.getOrCreate('ext-1');
    reg.getOrCreate('ext-2');
    const entries = reg.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.extensionId).sort()).toEqual(['ext-1', 'ext-2']);
  });

  it('clear() drops all entries', () => {
    const reg = createCapturesRegistry();
    reg.getOrCreate('ext-1');
    reg.getOrCreate('ext-2');
    reg.clear();
    expect(reg.list()).toHaveLength(0);
    expect(reg.get('ext-1')).toBeUndefined();
  });

  it('forwards capacityPerKind + getNow to createCapturesIn', () => {
    const fixedNow = 7777;
    const reg = createCapturesRegistry({ capacityPerKind: 2, getNow: () => fixedNow });
    const captures = reg.getOrCreate('ext-1');
    captures.receive({
      events: [
        { kind: 'console', ts: 1 },
        { kind: 'console', ts: 2 },
        { kind: 'console', ts: 3 },
      ] as readonly HostCapturedEvent[],
    });
    const tail = captures.tail('console');
    expect(tail).toHaveLength(2);
    expect(tail.every((e) => e.receivedAt === fixedNow)).toBe(true);
  });
});

describe('dispatchCapturesEvent — happy path + tool gating', () => {
  it('routes captures-flavor envelopes to registry.getOrCreate(extId).receive', () => {
    const reg = createCapturesRegistry();
    dispatchCapturesEvent(reg, 'ext-aaa', env());
    expect(reg.get('ext-aaa')?.tail('console')).toHaveLength(1);
  });

  it('ignores envelopes with non-captures tool (no-op)', () => {
    const reg = createCapturesRegistry();
    dispatchCapturesEvent(reg, 'ext-aaa', env({ tool: 'something_else' }));
    expect(reg.get('ext-aaa')).toBeUndefined();
  });

  it('ignores envelopes with undefined tool', () => {
    const reg = createCapturesRegistry();
    dispatchCapturesEvent(reg, 'ext-aaa', env({ tool: undefined }));
    expect(reg.get('ext-aaa')).toBeUndefined();
  });

  it('lazy-creates CapturesIn on first captures-flavor event', () => {
    const reg = createCapturesRegistry();
    expect(reg.get('ext-aaa')).toBeUndefined();
    dispatchCapturesEvent(reg, 'ext-aaa', env());
    expect(reg.get('ext-aaa')).toBeDefined();
  });

  it('reuses the same CapturesIn across multiple events from the same extensionId', () => {
    const reg = createCapturesRegistry();
    dispatchCapturesEvent(reg, 'ext-aaa', env());
    const after1 = reg.get('ext-aaa');
    dispatchCapturesEvent(reg, 'ext-aaa', env());
    const after2 = reg.get('ext-aaa');
    expect(after1).toBe(after2);
    expect(after1?.tail('console')).toHaveLength(2);
  });
});

describe('dispatchCapturesEvent — extensionId validation', () => {
  it('allows envelope.extensionId === connection extensionId', () => {
    const reg = createCapturesRegistry();
    const onMismatch = vi.fn();
    dispatchCapturesEvent(reg, 'ext-aaa', env({ extensionId: 'ext-aaa' }), { onMismatch });
    expect(onMismatch).not.toHaveBeenCalled();
    expect(reg.get('ext-aaa')?.tail('console')).toHaveLength(1);
  });

  it('allows envelope.extensionId === undefined (uses connection extensionId)', () => {
    const reg = createCapturesRegistry();
    const onMismatch = vi.fn();
    dispatchCapturesEvent(reg, 'ext-aaa', env({ extensionId: undefined }), { onMismatch });
    expect(onMismatch).not.toHaveBeenCalled();
    expect(reg.get('ext-aaa')?.tail('console')).toHaveLength(1);
  });

  it('drops + fires onMismatch when envelope.extensionId disagrees with connection', () => {
    const reg = createCapturesRegistry();
    const onMismatch = vi.fn();
    dispatchCapturesEvent(
      reg,
      'ext-aaa',
      env({ extensionId: 'ext-bbb' }),
      { onMismatch },
    );
    expect(onMismatch).toHaveBeenCalledOnce();
    expect(onMismatch.mock.calls[0]![0]).toMatch(/ext-bbb/);
    expect(onMismatch.mock.calls[0]![0]).toMatch(/ext-aaa/);
    expect(reg.get('ext-aaa')).toBeUndefined();
    expect(reg.get('ext-bbb')).toBeUndefined();
  });
});

describe('dispatchCapturesEvent — payload validation', () => {
  it('drops + fires onInvalid when payload is undefined', () => {
    const reg = createCapturesRegistry();
    const onInvalid = vi.fn();
    dispatchCapturesEvent(reg, 'ext-aaa', env({ payload: undefined }), { onInvalid });
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(reg.get('ext-aaa')).toBeUndefined();
  });

  it('drops + fires onInvalid when payload is null', () => {
    const reg = createCapturesRegistry();
    const onInvalid = vi.fn();
    dispatchCapturesEvent(reg, 'ext-aaa', env({ payload: null }), { onInvalid });
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(reg.get('ext-aaa')).toBeUndefined();
  });

  it('drops + fires onInvalid when payload is not an object', () => {
    const reg = createCapturesRegistry();
    const onInvalid = vi.fn();
    dispatchCapturesEvent(reg, 'ext-aaa', env({ payload: 'oops' }), { onInvalid });
    expect(onInvalid).toHaveBeenCalledOnce();
  });

  it('drops + fires onInvalid when payload.events is missing', () => {
    const reg = createCapturesRegistry();
    const onInvalid = vi.fn();
    dispatchCapturesEvent(reg, 'ext-aaa', env({ payload: {} }), { onInvalid });
    expect(onInvalid).toHaveBeenCalledOnce();
  });

  it('drops + fires onInvalid when payload.events is not an array', () => {
    const reg = createCapturesRegistry();
    const onInvalid = vi.fn();
    dispatchCapturesEvent(
      reg,
      'ext-aaa',
      env({ payload: { events: 'not-an-array' } }),
      { onInvalid },
    );
    expect(onInvalid).toHaveBeenCalledOnce();
  });

  it('hooks are optional — drops silently when no hooks provided', () => {
    const reg = createCapturesRegistry();
    expect(() =>
      dispatchCapturesEvent(reg, 'ext-aaa', env({ payload: null })),
    ).not.toThrow();
    expect(reg.get('ext-aaa')).toBeUndefined();
  });
});
