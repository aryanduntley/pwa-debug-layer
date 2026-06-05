import { describe, it, expect } from 'vitest';
import { analyzeUpdateSkew, SKEW_THRESHOLD_SECONDS } from '../../src/update_analysis/analyze.js';
import type {
  CacheEntryRecord,
  SwStatusSnapshot,
  SwWorkerRecord,
} from '@pwa-debug/shared';

type Entry = CacheEntryRecord & { readonly cacheName: string };

const entry = (
  url: string,
  contentType: string | null,
  ageSeconds: number | null,
  cacheName = 'v1',
): Entry => ({
  url,
  method: 'GET',
  status: 200,
  contentType,
  contentLength: null,
  dateHeader: null,
  ageSeconds,
  cacheControl: null,
  cacheName,
});

const worker = (state = 'activated'): SwWorkerRecord => ({
  scriptURL: '/sw.js',
  state: state as SwWorkerRecord['state'],
});

const sw = (over: Partial<SwStatusSnapshot> = {}): SwStatusSnapshot => ({
  supported: true,
  controller: null,
  registrations: [],
  hasWaitingUpdate: false,
  ...over,
});

const codes = (r: ReturnType<typeof analyzeUpdateSkew>) => r.findings.map((f) => f.code);

describe('analyzeUpdateSkew — waiting update', () => {
  it('flags waiting_update_active_client when a waiting worker + active controller coexist', () => {
    const r = analyzeUpdateSkew(sw({ hasWaitingUpdate: true, controller: worker() }), [], []);
    expect(codes(r)).toContain('waiting_update_active_client');
    expect(r.hasWaitingUpdate).toBe(true);
  });

  it('does NOT flag it when there is no controller (page not yet controlled)', () => {
    const r = analyzeUpdateSkew(sw({ hasWaitingUpdate: true, controller: null }), [], []);
    expect(codes(r)).not.toContain('waiting_update_active_client');
  });
});

describe('analyzeUpdateSkew — version skew (html older than js)', () => {
  it('flags html_older_js when cached HTML age exceeds cached JS age past the threshold', () => {
    const r = analyzeUpdateSkew(sw(), [
      entry('https://x/', 'text/html', 7200),
      entry('https://x/app.js', 'application/javascript', 300),
    ], []);
    expect(codes(r)).toContain('html_older_js');
  });

  it('does NOT flag when the age gap is below the threshold', () => {
    const r = analyzeUpdateSkew(sw(), [
      entry('https://x/', 'text/html', 700),
      entry('https://x/app.js', 'application/javascript', 300),
    ], []);
    expect(codes(r)).not.toContain('html_older_js');
  });

  it('respects a custom skew threshold', () => {
    const entries = [
      entry('https://x/', 'text/html', 1000),
      entry('https://x/app.js', 'application/javascript', 300),
    ];
    expect(codes(analyzeUpdateSkew(sw(), entries, [], { skewThresholdSeconds: 500 }))).toContain('html_older_js');
    expect(codes(analyzeUpdateSkew(sw(), entries, [], { skewThresholdSeconds: 5000 }))).not.toContain('html_older_js');
  });

  it('needs both an HTML and a JS entry with ages to compare', () => {
    const r = analyzeUpdateSkew(sw(), [entry('https://x/', 'text/html', 9999)], []);
    expect(codes(r)).not.toContain('html_older_js');
  });

  it('uses the default threshold constant', () => {
    const justOver = [
      entry('https://x/', 'text/html', SKEW_THRESHOLD_SECONDS + 10),
      entry('https://x/app.js', 'application/javascript', 0),
    ];
    expect(codes(analyzeUpdateSkew(sw(), justOver, []))).toContain('html_older_js');
  });
});

describe('analyzeUpdateSkew — chunk 404s', () => {
  it('flags chunk_404 for failed JS/CSS requests and lists them', () => {
    const r = analyzeUpdateSkew(sw(), [], [
      { url: 'https://x/chunk.4f2.js', status: 404 },
      { url: 'https://x/styles.css', status: 404 },
      { url: 'https://x/logo.png', status: 404 },
      { url: 'https://x/app.js', status: 200 },
    ]);
    expect(codes(r)).toContain('chunk_404');
    expect(r.chunk404s.map((f) => f.url)).toEqual([
      'https://x/chunk.4f2.js',
      'https://x/styles.css',
    ]);
  });

  it('does not flag chunk_404 when no JS/CSS failure exists', () => {
    const r = analyzeUpdateSkew(sw(), [], [{ url: 'https://x/logo.png', status: 404 }]);
    expect(codes(r)).not.toContain('chunk_404');
    expect(r.chunk404s).toEqual([]);
  });
});

describe('analyzeUpdateSkew — shaping + summary', () => {
  it('summarizes "no issues" when nothing fires', () => {
    const r = analyzeUpdateSkew(sw(), [], []);
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatch(/no update-propagation/i);
  });

  it('reports unsupported when service workers are unavailable', () => {
    const r = analyzeUpdateSkew(sw({ supported: false }), [], []);
    expect(r.supported).toBe(false);
    expect(r.summary).toMatch(/unavailable/i);
  });

  it('sorts cachedHtml oldest-first and cachedJs newest-first', () => {
    const r = analyzeUpdateSkew(sw(), [
      entry('https://x/a.html', 'text/html', 100),
      entry('https://x/b.html', 'text/html', 900),
      entry('https://x/a.js', 'application/javascript', 800),
      entry('https://x/b.js', 'application/javascript', 200),
    ], []);
    expect(r.cachedHtml.map((a) => a.ageSeconds)).toEqual([900, 100]);
    expect(r.cachedJs.map((a) => a.ageSeconds)).toEqual([200, 800]);
  });
});
