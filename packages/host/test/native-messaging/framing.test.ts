import { describe, it, expect } from 'vitest';
import { frameMessage, createFrameReader } from '../../src/native-messaging/framing.js';

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};

describe('frameMessage', () => {
  it('encodes a simple object as 4-byte LE prefix + JSON body', () => {
    const frame = frameMessage({ kind: 'ping', id: 'abc' });
    const view = new DataView(frame.buffer, frame.byteOffset, 4);
    const len = view.getUint32(0, true);
    expect(frame.byteLength).toBe(4 + len);
    const body = new TextDecoder('utf-8').decode(frame.subarray(4));
    expect(JSON.parse(body)).toEqual({ kind: 'ping', id: 'abc' });
  });

  it('encodes primitives', () => {
    for (const v of [42, 'hello', true, false, null]) {
      const frame = frameMessage(v);
      const reader = createFrameReader();
      const [decoded] = reader.push(frame);
      expect(decoded).toEqual(v);
    }
  });

  it('preserves Unicode (emoji + CJK)', () => {
    const v = { greeting: '你好 🌏 안녕' };
    const reader = createFrameReader();
    const [decoded] = reader.push(frameMessage(v));
    expect(decoded).toEqual(v);
  });

  it('throws when value is not JSON-serializable', () => {
    expect(() => frameMessage(() => 1)).toThrow(/not JSON-serializable/);
    expect(() => frameMessage(undefined)).toThrow(/not JSON-serializable/);
  });
});

describe('createFrameReader', () => {
  it('round-trips a single message', () => {
    const reader = createFrameReader();
    const msgs = reader.push(frameMessage({ ok: true }));
    expect(msgs).toEqual([{ ok: true }]);
    expect(reader.bufferedBytes()).toBe(0);
  });

  it('returns empty list and buffers when frame is incomplete', () => {
    const reader = createFrameReader();
    const frame = frameMessage({ a: 1 });
    expect(reader.push(frame.subarray(0, 2))).toEqual([]);
    expect(reader.bufferedBytes()).toBe(2);
    expect(reader.push(frame.subarray(2))).toEqual([{ a: 1 }]);
    expect(reader.bufferedBytes()).toBe(0);
  });

  it('parses two messages delivered in one chunk', () => {
    const reader = createFrameReader();
    const chunk = concat(frameMessage('first'), frameMessage('second'));
    expect(reader.push(chunk)).toEqual(['first', 'second']);
    expect(reader.bufferedBytes()).toBe(0);
  });

  it('parses a frame split across many small chunks', () => {
    const reader = createFrameReader();
    const frame = frameMessage({ payload: 'spread me thin' });
    let yielded: unknown[] = [];
    for (let i = 0; i < frame.byteLength; i += 1) {
      yielded = yielded.concat(reader.push(frame.subarray(i, i + 1)));
    }
    expect(yielded).toEqual([{ payload: 'spread me thin' }]);
    expect(reader.bufferedBytes()).toBe(0);
  });

  it('handles boundary where second frame starts mid-chunk', () => {
    const reader = createFrameReader();
    const a = frameMessage({ n: 1 });
    const b = frameMessage({ n: 2 });
    const combined = concat(a, b);
    const split = Math.floor(a.byteLength + b.byteLength / 2);
    expect(reader.push(combined.subarray(0, split))).toEqual([{ n: 1 }]);
    expect(reader.push(combined.subarray(split))).toEqual([{ n: 2 }]);
  });

  it('returns [] on empty chunk push without disturbing buffer', () => {
    const reader = createFrameReader();
    const partial = frameMessage({}).subarray(0, 3);
    reader.push(partial);
    expect(reader.push(new Uint8Array(0))).toEqual([]);
    expect(reader.bufferedBytes()).toBe(3);
  });

  it('handles a 1MB payload round-trip', () => {
    const big = { blob: 'x'.repeat(1_000_000) };
    const reader = createFrameReader();
    const [decoded] = reader.push(frameMessage(big));
    expect(decoded).toEqual(big);
  });

  it('throws when a length prefix exceeds the max message bytes cap', () => {
    const reader = createFrameReader();
    const oversized = new Uint8Array(4);
    new DataView(oversized.buffer).setUint32(0, 64 * 1024 * 1024 + 1, true);
    expect(() => reader.push(oversized)).toThrow(/exceeds max/);
  });

  it('throws on invalid UTF-8 inside a frame body', () => {
    const reader = createFrameReader();
    const badBody = new Uint8Array([0xff, 0xfe, 0xfd]);
    const frame = new Uint8Array(4 + badBody.byteLength);
    new DataView(frame.buffer).setUint32(0, badBody.byteLength, true);
    frame.set(badBody, 4);
    expect(() => reader.push(frame)).toThrow();
  });

  it('throws on malformed JSON inside a frame body', () => {
    const reader = createFrameReader();
    const badJson = new TextEncoder().encode('{not-json');
    const frame = new Uint8Array(4 + badJson.byteLength);
    new DataView(frame.buffer).setUint32(0, badJson.byteLength, true);
    frame.set(badJson, 4);
    expect(() => reader.push(frame)).toThrow();
  });
});
