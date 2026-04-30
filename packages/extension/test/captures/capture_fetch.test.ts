import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchCapture } from '../../src/captures/capture_fetch.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type { FetchCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://example.com/x',
  frameKey: 'top',
};

describe('installFetchCapture', () => {
  let received: FetchCapturedEvent[];
  let dispose: (() => void) | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    received = [];
    dispose = undefined;
  });

  afterEach(() => {
    if (dispose) dispose();
    globalThis.fetch = realFetch;
  });

  const installWith = (
    mockFetch: typeof globalThis.fetch,
    opts?: Parameters<typeof installFetchCapture>[2],
  ): void => {
    globalThis.fetch = mockFetch;
    dispose = installFetchCapture(
      (e) => {
        received.push(e);
      },
      FRAME,
      opts,
    );
  };

  it('emits paired request+response with the same captureId', async () => {
    let ts = 1000;
    const mock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    installWith(mock as typeof globalThis.fetch, {
      now: () => {
        ts += 50;
        return ts;
      },
    });

    const res = await fetch('https://api.example.com/x', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(mock).toHaveBeenCalledOnce();

    expect(received).toHaveLength(2);
    const [req, resp] = received;
    expect(req!.kind).toBe('fetch');
    expect(req!.phase).toBe('request');
    expect(req!.method).toBe('GET');
    expect(req!.url).toBe('https://api.example.com/x');
    expect(resp!.phase).toBe('response');
    expect(resp!.captureId).toBe(req!.captureId);
    expect(resp!.status).toBe(200);
    expect(resp!.headers?.['content-type']).toBe('text/plain');
    expect(resp!.body).toBe('hello');
    expect(typeof resp!.durationMs).toBe('number');
    expect(resp!.durationMs).toBeGreaterThan(0);
  });

  it('emits an error event when the underlying fetch rejects', async () => {
    const err = new TypeError('network down');
    const mock = vi.fn(async () => {
      throw err;
    });
    installWith(mock as typeof globalThis.fetch);

    await expect(fetch('https://api.example.com/x')).rejects.toBe(err);

    expect(received).toHaveLength(2);
    expect(received[0]!.phase).toBe('request');
    const errEvt = received[1]!;
    expect(errEvt.phase).toBe('error');
    expect(errEvt.captureId).toBe(received[0]!.captureId);
    const body = errEvt.body as { __type?: string; name?: string; message?: string };
    expect(body.__type).toBe('Error');
    expect(body.name).toBe('TypeError');
    expect(body.message).toBe('network down');
    expect(typeof errEvt.durationMs).toBe('number');
  });

  it('serializes Headers, plain-object, and array header init', async () => {
    const mock = vi.fn(async () => new Response('ok'));
    installWith(mock as typeof globalThis.fetch);

    await fetch('https://api.example.com/h1', {
      method: 'POST',
      headers: { 'x-a': '1', 'x-b': '2' },
      body: 'hi',
    });
    await fetch('https://api.example.com/h2', {
      method: 'POST',
      headers: new Headers({ 'x-c': '3' }),
      body: 'hi',
    });
    await fetch('https://api.example.com/h3', {
      method: 'POST',
      headers: [['x-d', '4']],
      body: 'hi',
    });

    const requestEvents = received.filter((e) => e.phase === 'request');
    expect(requestEvents).toHaveLength(3);
    expect(requestEvents[0]!.headers).toEqual({ 'x-a': '1', 'x-b': '2' });
    expect(requestEvents[1]!.headers).toEqual({ 'x-c': '3' });
    expect(requestEvents[2]!.headers).toEqual({ 'x-d': '4' });
  });

  it('tags non-string request bodies as SerializedTag variants', async () => {
    const mock = vi.fn(async () => new Response('ok'));
    installWith(mock as typeof globalThis.fetch);

    const blob = new Blob(['abc'], { type: 'text/plain' });
    await fetch('https://api.example.com/b1', { method: 'POST', body: blob });
    await fetch('https://api.example.com/b2', {
      method: 'POST',
      body: new URLSearchParams({ a: '1' }),
    });
    const buf = new ArrayBuffer(8);
    await fetch('https://api.example.com/b3', { method: 'POST', body: buf });

    const reqs = received.filter((e) => e.phase === 'request');
    expect((reqs[0]!.body as { __type: string }).__type).toBe('Blob');
    expect((reqs[0]!.body as { size: number }).size).toBe(3);
    expect((reqs[1]!.body as { __type: string }).__type).toBe('URLSearchParams');
    expect((reqs[1]!.body as { value: string }).value).toBe('a=1');
    expect((reqs[2]!.body as { __type: string }).__type).toBe('ArrayBuffer');
    expect((reqs[2]!.body as { byteLength: number }).byteLength).toBe(8);
  });

  it('truncates large request bodies to a Truncated tag', async () => {
    const mock = vi.fn(async () => new Response('ok'));
    installWith(mock as typeof globalThis.fetch, { maxBytes: 100 });

    const big = 'x'.repeat(500);
    await fetch('https://api.example.com/big', { method: 'POST', body: big });

    const req = received.find((e) => e.phase === 'request')!;
    const body = req.body as { __type?: string; max?: number };
    expect(body.__type).toBe('Truncated');
    expect(body.max).toBe(100);
  });

  it('original fetch return value passes through unmodified', async () => {
    const expected = new Response('payload', { status: 201 });
    const mock = vi.fn(async () => expected);
    installWith(mock as typeof globalThis.fetch);

    const res = await fetch('https://api.example.com/p');
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('payload');
  });

  it('multiple concurrent fetches get distinct captureIds', async () => {
    let n = 0;
    const mock = vi.fn(async () => {
      n += 1;
      return new Response(`r${n}`);
    });
    installWith(mock as typeof globalThis.fetch);

    await Promise.all([
      fetch('https://api.example.com/a'),
      fetch('https://api.example.com/b'),
      fetch('https://api.example.com/c'),
    ]);

    const reqs = received.filter((e) => e.phase === 'request');
    const ids = reqs.map((e) => e.captureId);
    expect(new Set(ids).size).toBe(3);
  });

  it('disposer restores the original fetch and is idempotent', async () => {
    const mock = vi.fn(async () => new Response('ok'));
    installWith(mock as typeof globalThis.fetch);

    const wrapped = globalThis.fetch;
    expect(wrapped).not.toBe(mock);

    dispose!();
    expect(globalThis.fetch).toBe(mock);

    dispose!();
    expect(globalThis.fetch).toBe(mock);
  });

  it('falls back to a ReadableStream tag when response body read times out', async () => {
    const slowResponse: Response = {
      status: 200,
      headers: new Headers(),
      clone: () => ({
        text: () => new Promise<string>(() => {}),
      }) as unknown as Response,
    } as unknown as Response;
    const mock = vi.fn(async () => slowResponse);
    installWith(mock as typeof globalThis.fetch, { responseBodyTimeoutMs: 5 });

    await fetch('https://api.example.com/slow');

    const resp = received.find((e) => e.phase === 'response')!;
    expect((resp.body as { __type?: string }).__type).toBe('ReadableStream');
  });
});
