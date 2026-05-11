import { describe, it, expect } from 'vitest';
import { attachFrameId } from '../../src/frame_meta/attach_frame_id.js';
import type { CapturedEvent } from '../../src/captures/types.js';

const baseEvent = (): CapturedEvent =>
  ({
    kind: 'console',
    ts: 1000,
    frameUrl: 'https://example.com/',
    frameKey: 'top',
    level: 'log',
    args: ['hi'],
  }) as unknown as CapturedEvent;

const asRecord = (e: CapturedEvent): Record<string, unknown> =>
  e as unknown as Record<string, unknown>;

describe('attachFrameId', () => {
  it('returns the same event reference when frameId is undefined', () => {
    const event = baseEvent();
    const out = attachFrameId(event, undefined);
    expect(out).toBe(event);
  });

  it('sets frameId when frameId is a number (top frame = 0)', () => {
    const event = baseEvent();
    const out = attachFrameId(event, 0);
    expect(asRecord(out)['frameId']).toBe(0);
  });

  it('sets frameId when frameId is a positive number (subframe)', () => {
    const event = baseEvent();
    const out = attachFrameId(event, 3);
    expect(asRecord(out)['frameId']).toBe(3);
  });

  it('preserves existing frameUrl and frameKey', () => {
    const event = baseEvent();
    const out = attachFrameId(event, 7);
    const r = asRecord(out);
    expect(r['frameUrl']).toBe('https://example.com/');
    expect(r['frameKey']).toBe('top');
    expect(r['frameId']).toBe(7);
  });

  it('returns a NEW event reference when frameId is set (immutable)', () => {
    const event = baseEvent();
    const out = attachFrameId(event, 1);
    expect(out).not.toBe(event);
    expect(asRecord(event)['frameId']).toBeUndefined();
  });

  it('preserves event fields (kind, ts, payload)', () => {
    const event = baseEvent();
    const out = attachFrameId(event, 2);
    const r = asRecord(out);
    expect(r['kind']).toBe('console');
    expect(r['ts']).toBe(1000);
    expect(r['level']).toBe('log');
    expect(r['args']).toEqual(['hi']);
  });

  it('handles events that omit some optional fields', () => {
    const event = {
      kind: 'console',
      ts: 1,
      frameUrl: 'a',
      frameKey: 'top',
      level: 'log',
      args: [],
    } as unknown as CapturedEvent;
    const out = attachFrameId(event, 4);
    expect(asRecord(out)['frameId']).toBe(4);
  });
});
