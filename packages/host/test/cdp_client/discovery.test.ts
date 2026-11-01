import { describe, it, expect } from 'vitest';
import {
  fetchBrowserVersion,
  listPageTargets,
  normalizeBrowserUrl,
} from '../../src/cdp_client/discovery.js';

const fakeFetch = (status: number, body: string) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('normalizeBrowserUrl', () => {
  it.each([
    ['9222', 'http://127.0.0.1:9222'],
    ['127.0.0.1:9333', 'http://127.0.0.1:9333'],
    ['http://localhost:9222/json/version', 'http://localhost:9222'],
    ['ws://127.0.0.1:9334/devtools/browser', 'http://127.0.0.1:9334'],
    ['  http://10.0.0.2:9229/  ', 'http://10.0.0.2:9229'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBrowserUrl(input)).toBe(expected);
  });

  it.each(['', 'localhost', 'http://localhost', 'not a url ::'])('rejects %j', (input) => {
    expect(normalizeBrowserUrl(input)).toBeNull();
  });
});

describe('fetchBrowserVersion', () => {
  it('parses the Android shape including the package and browser socket', async () => {
    const body = JSON.stringify({
      'Android-Package': 'com.android.chrome',
      Browser: 'Chrome/156.0.8078.73',
      'Protocol-Version': '1.3',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K)',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/browser',
    });
    const r = await fetchBrowserVersion('http://127.0.0.1:9334', { fetchImpl: fakeFetch(200, body) });
    expect(r).toEqual({
      ok: true,
      value: {
        browser: 'Chrome/156.0.8078.73',
        protocolVersion: '1.3',
        userAgent: 'Mozilla/5.0 (Linux; Android 10; K)',
        androidPackage: 'com.android.chrome',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/browser',
      },
    });
  });

  it('turns a plain-text body into bad_body instead of throwing', async () => {
    const r = await fetchBrowserVersion('http://h:1', { fetchImpl: fakeFetch(200, 'Could not create new page') });
    expect(r).toMatchObject({ ok: false, kind: 'bad_body' });
  });

  it('reports HTTP errors and connection failures', async () => {
    expect(await fetchBrowserVersion('http://h:1', { fetchImpl: fakeFetch(500, 'x') })).toMatchObject({ ok: false, kind: 'http' });
    const refusing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchBrowserVersion('http://h:1', { fetchImpl: refusing })).toMatchObject({ ok: false, kind: 'connect_failed' });
  });

  it('reports a timeout when the endpoint hangs', async () => {
    const hanging = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await fetchBrowserVersion('http://h:1', { fetchImpl: hanging, timeoutMs: 10 })).toMatchObject({ ok: false, kind: 'timeout' });
  });
});

describe('listPageTargets', () => {
  it('keeps only page targets with a socket URL', async () => {
    const body = JSON.stringify([
      { id: 'A', type: 'page', title: 'Fixture', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/page/A' },
      { id: 'B', type: 'service_worker', url: 'sw.js', webSocketDebuggerUrl: 'ws://x/B' },
      { id: 'C', type: 'page', url: 'chrome-native://newtab/' },
      'junk',
    ]);
    const r = await listPageTargets('http://127.0.0.1:9334', { fetchImpl: fakeFetch(200, body) });
    expect(r).toEqual({
      ok: true,
      value: [{ id: 'A', type: 'page', title: 'Fixture', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/page/A' }],
    });
  });

  it('rejects a non-array body', async () => {
    expect(await listPageTargets('http://h:1', { fetchImpl: fakeFetch(200, '{}') })).toMatchObject({ ok: false, kind: 'bad_body' });
  });
});
