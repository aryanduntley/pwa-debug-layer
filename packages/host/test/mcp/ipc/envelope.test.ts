import { describe, it, expect } from 'vitest';
import {
  createIpcFrameReader,
  encodeIpcEnvelope,
  parseIpcEnvelope,
  type IpcEnvelope,
} from '../../../src/mcp/ipc/envelope.js';

describe('parseIpcEnvelope — register', () => {
  it('accepts a valid register envelope', () => {
    const env = parseIpcEnvelope({ type: 'register', extensionId: 'abc' });
    expect(env).toEqual({ type: 'register', extensionId: 'abc' });
  });

  it('rejects register with non-string extensionId', () => {
    expect(() => parseIpcEnvelope({ type: 'register', extensionId: 42 })).toThrow(
      /register\.extensionId/,
    );
  });

  it('rejects register with missing extensionId', () => {
    expect(() => parseIpcEnvelope({ type: 'register' })).toThrow(/register\.extensionId/);
  });
});

describe('parseIpcEnvelope — request', () => {
  it('accepts a minimal request envelope', () => {
    const env = parseIpcEnvelope({
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    });
    expect(env).toEqual({ type: 'request', requestId: 'r1', tool: 'session_ping' });
  });

  it('accepts request with optional extensionId + payload', () => {
    const env = parseIpcEnvelope({
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
      extensionId: 'ext',
      payload: { foo: 1 },
    });
    expect(env).toEqual({
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
      extensionId: 'ext',
      payload: { foo: 1 },
    });
  });

  it('preserves a null payload as a present field', () => {
    const env = parseIpcEnvelope({
      type: 'request',
      requestId: 'r1',
      tool: 'x',
      payload: null,
    });
    expect((env as Extract<IpcEnvelope, { type: 'request' }>).payload).toBeNull();
  });

  it('rejects request missing requestId', () => {
    expect(() =>
      parseIpcEnvelope({ type: 'request', tool: 'session_ping' }),
    ).toThrow(/request\.requestId/);
  });

  it('rejects request missing tool', () => {
    expect(() => parseIpcEnvelope({ type: 'request', requestId: 'r1' })).toThrow(
      /request\.tool/,
    );
  });

  it('rejects request with non-string extensionId', () => {
    expect(() =>
      parseIpcEnvelope({ type: 'request', requestId: 'r', tool: 't', extensionId: 1 }),
    ).toThrow(/request\.extensionId/);
  });
});

describe('parseIpcEnvelope — response', () => {
  it('accepts success response with payload', () => {
    const env = parseIpcEnvelope({
      type: 'response',
      requestId: 'r1',
      payload: { ok: true },
    });
    expect(env).toEqual({ type: 'response', requestId: 'r1', payload: { ok: true } });
  });

  it('accepts error response', () => {
    const env = parseIpcEnvelope({
      type: 'response',
      requestId: 'r1',
      error: { message: 'boom' },
    });
    expect(env).toEqual({
      type: 'response',
      requestId: 'r1',
      error: { message: 'boom' },
    });
  });

  it('rejects response missing requestId', () => {
    expect(() => parseIpcEnvelope({ type: 'response' })).toThrow(/response\.requestId/);
  });

  it('rejects response with malformed error field', () => {
    expect(() =>
      parseIpcEnvelope({ type: 'response', requestId: 'r1', error: { message: 42 } }),
    ).toThrow(/response\.error/);
  });
});

describe('parseIpcEnvelope — event', () => {
  it('accepts a minimal event envelope', () => {
    const env = parseIpcEnvelope({ type: 'event' });
    expect(env).toEqual({ type: 'event' });
  });

  it('accepts event with optional fields', () => {
    const env = parseIpcEnvelope({
      type: 'event',
      extensionId: 'ext',
      tool: 'sw_hello',
      payload: { v: '1.0.0' },
    });
    expect(env).toEqual({
      type: 'event',
      extensionId: 'ext',
      tool: 'sw_hello',
      payload: { v: '1.0.0' },
    });
  });
});

describe('parseIpcEnvelope — invalid', () => {
  it('rejects non-object root', () => {
    expect(() => parseIpcEnvelope('hello')).toThrow(/root is not an object/);
    expect(() => parseIpcEnvelope(null)).toThrow(/root is not an object/);
    expect(() => parseIpcEnvelope(42)).toThrow(/root is not an object/);
  });

  it('rejects unknown discriminator', () => {
    expect(() => parseIpcEnvelope({ type: 'nope' })).toThrow(/unknown type/);
    expect(() => parseIpcEnvelope({})).toThrow(/unknown type/);
  });
});

describe('encodeIpcEnvelope', () => {
  it('produces a 4-byte LE length prefix + JSON body', () => {
    const env: IpcEnvelope = { type: 'register', extensionId: 'abc' };
    const out = encodeIpcEnvelope(env);
    const view = new DataView(out.buffer, out.byteOffset, 4);
    const len = view.getUint32(0, true);
    expect(len).toBe(out.byteLength - 4);
    const body = new TextDecoder().decode(out.subarray(4));
    expect(JSON.parse(body)).toEqual(env);
  });
});

describe('createIpcFrameReader', () => {
  it('parses a single complete frame', () => {
    const reader = createIpcFrameReader();
    const env: IpcEnvelope = {
      type: 'request',
      requestId: 'r1',
      tool: 'session_ping',
    };
    const out = reader.push(encodeIpcEnvelope(env));
    expect(out).toEqual([env]);
    expect(reader.bufferedBytes()).toBe(0);
  });

  it('parses multiple frames in one push', () => {
    const reader = createIpcFrameReader();
    const a: IpcEnvelope = { type: 'register', extensionId: 'a' };
    const b: IpcEnvelope = { type: 'register', extensionId: 'b' };
    const ea = encodeIpcEnvelope(a);
    const eb = encodeIpcEnvelope(b);
    const merged = new Uint8Array(ea.byteLength + eb.byteLength);
    merged.set(ea, 0);
    merged.set(eb, ea.byteLength);
    expect(reader.push(merged)).toEqual([a, b]);
  });

  it('buffers partial frames across pushes', () => {
    const reader = createIpcFrameReader();
    const env: IpcEnvelope = { type: 'register', extensionId: 'abc' };
    const buf = encodeIpcEnvelope(env);
    const split = Math.floor(buf.byteLength / 2);
    expect(reader.push(buf.subarray(0, split))).toEqual([]);
    expect(reader.bufferedBytes()).toBe(split);
    expect(reader.push(buf.subarray(split))).toEqual([env]);
    expect(reader.bufferedBytes()).toBe(0);
  });

  it('throws on a frame whose body is malformed JSON-but-not-an-envelope', () => {
    const reader = createIpcFrameReader();
    const body = new TextEncoder().encode('{"type":"nope"}');
    const frame = new Uint8Array(4 + body.byteLength);
    new DataView(frame.buffer).setUint32(0, body.byteLength, true);
    frame.set(body, 4);
    expect(() => reader.push(frame)).toThrow(/unknown type/);
  });
});
