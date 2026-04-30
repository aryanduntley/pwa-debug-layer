import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installXhrCapture } from '../../src/captures/capture_xhr.js';
import type { FrameMeta } from '../../src/captures/capture_console.js';
import type { XhrCapturedEvent } from '../../src/captures/types.js';

const FRAME: FrameMeta = {
  frameUrl: 'https://example.com/x',
  frameKey: 'top',
};

class FakeXHR extends EventTarget {
  status = 0;
  responseType: XMLHttpRequestResponseType = '';
  responseText = '';
  response: unknown = '';
  lastBody: unknown;
  lastMethod: string | undefined;
  lastUrl: string | undefined;
  lastHeaders: Record<string, string> = {};

  open(method: string, url: string): void {
    this.lastMethod = method;
    this.lastUrl = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.lastHeaders[name] = value;
  }
  send(body?: unknown): void {
    this.lastBody = body;
  }

  resolve(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.response = body;
    this.dispatchEvent(new Event('load'));
  }
  reject(): void {
    this.dispatchEvent(new Event('error'));
  }
  abort(): void {
    this.dispatchEvent(new Event('abort'));
  }
}

describe('installXhrCapture', () => {
  let received: XhrCapturedEvent[];
  let dispose: (() => void) | undefined;
  const realXhr = globalThis.XMLHttpRequest;

  beforeEach(() => {
    received = [];
    dispose = undefined;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    dispose = installXhrCapture(
      (e) => {
        received.push(e);
      },
      FRAME,
    );
  });

  afterEach(() => {
    if (dispose) dispose();
    globalThis.XMLHttpRequest = realXhr;
  });

  it('emits paired request+response with the same captureId on load', () => {
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('POST', 'https://api.example.com/x');
    xhr.setRequestHeader('x-a', '1');
    xhr.send('hello');
    xhr.resolve(200, 'world');

    expect(received).toHaveLength(2);
    const [req, resp] = received;
    expect(req!.phase).toBe('request');
    expect(req!.method).toBe('POST');
    expect(req!.url).toBe('https://api.example.com/x');
    expect(req!.headers).toEqual({ 'x-a': '1' });
    expect(req!.body).toBe('hello');
    expect(resp!.phase).toBe('response');
    expect(resp!.captureId).toBe(req!.captureId);
    expect(resp!.status).toBe(200);
    expect(resp!.body).toBe('world');
    expect(typeof resp!.durationMs).toBe('number');
  });

  it('emits error phase when error event fires', () => {
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('GET', '/fail');
    xhr.send();
    xhr.reject();

    expect(received).toHaveLength(2);
    const errEvt = received[1]!;
    expect(errEvt.phase).toBe('error');
    expect(errEvt.captureId).toBe(received[0]!.captureId);
  });

  it('emits error phase when abort event fires', () => {
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('GET', '/abort');
    xhr.send();
    xhr.abort();

    expect(received).toHaveLength(2);
    expect(received[1]!.phase).toBe('error');
  });

  it('original XHR methods are still invoked (passthrough)', () => {
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('GET', '/x');
    xhr.setRequestHeader('h', 'v');
    xhr.send('body');
    expect(xhr.lastMethod).toBe('GET');
    expect(xhr.lastUrl).toBe('/x');
    expect(xhr.lastHeaders).toEqual({ h: 'v' });
    expect(xhr.lastBody).toBe('body');
  });

  it('tags non-string request bodies as SerializedTag variants', () => {
    const x1 = new XMLHttpRequest() as unknown as FakeXHR;
    x1.open('POST', '/b1');
    const blob = new Blob(['xy'], { type: 'text/plain' });
    x1.send(blob as unknown as XMLHttpRequestBodyInit);

    const x2 = new XMLHttpRequest() as unknown as FakeXHR;
    x2.open('POST', '/b2');
    x2.send(new URLSearchParams({ a: '1' }) as unknown as XMLHttpRequestBodyInit);

    const x3 = new XMLHttpRequest() as unknown as FakeXHR;
    x3.open('POST', '/b3');
    x3.send(new ArrayBuffer(4) as unknown as XMLHttpRequestBodyInit);

    const reqs = received.filter((e) => e.phase === 'request');
    expect((reqs[0]!.body as { __type: string }).__type).toBe('Blob');
    expect((reqs[1]!.body as { __type: string }).__type).toBe('URLSearchParams');
    expect((reqs[1]!.body as { value: string }).value).toBe('a=1');
    expect((reqs[2]!.body as { __type: string }).__type).toBe('ArrayBuffer');
  });

  it('truncates large request bodies to a Truncated tag', () => {
    if (dispose) dispose();
    dispose = installXhrCapture(
      (e) => {
        received.push(e);
      },
      FRAME,
      { maxBytes: 50 },
    );
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.open('POST', '/big');
    xhr.send('x'.repeat(500));

    const req = received.find((e) => e.phase === 'request')!;
    expect((req.body as { __type?: string }).__type).toBe('Truncated');
  });

  it('multiple concurrent XHRs get distinct captureIds', () => {
    const xs = [1, 2, 3].map(() => new XMLHttpRequest() as unknown as FakeXHR);
    xs.forEach((x, i) => {
      x.open('GET', `/u${i}`);
      x.send();
    });

    const reqs = received.filter((e) => e.phase === 'request');
    expect(reqs).toHaveLength(3);
    expect(new Set(reqs.map((e) => e.captureId)).size).toBe(3);
  });

  it('disposer restores the original XMLHttpRequest and is idempotent', () => {
    const wrapped = globalThis.XMLHttpRequest;
    expect(wrapped).not.toBe(FakeXHR);

    dispose!();
    expect(globalThis.XMLHttpRequest).toBe(FakeXHR as unknown as typeof XMLHttpRequest);

    dispose!();
    expect(globalThis.XMLHttpRequest).toBe(FakeXHR as unknown as typeof XMLHttpRequest);
  });

  it('records responseType in response phase', () => {
    const xhr = new XMLHttpRequest() as unknown as FakeXHR;
    xhr.responseType = 'json';
    xhr.open('GET', '/json');
    xhr.send();
    xhr.response = { ok: true };
    xhr.status = 200;
    xhr.dispatchEvent(new Event('load'));

    const resp = received.find((e) => e.phase === 'response')!;
    expect(resp.responseType).toBe('json');
    expect(resp.body).toEqual({ ok: true });
  });
});
