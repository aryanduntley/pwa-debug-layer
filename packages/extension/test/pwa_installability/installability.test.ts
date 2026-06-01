import { describe, it, expect } from 'vitest';
import {
  summarizeManifest,
  evaluateInstallability,
} from '../../src/pwa_installability/project.js';
import { readInstallability } from '../../src/pwa_installability/read.js';

const goodManifestJson = {
  name: 'Example App',
  short_name: 'Example',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: '#fff',
  background_color: '#000',
  icons: [
    { src: '/i192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/i512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const goodSummary = summarizeManifest(goodManifestJson);

const evalGood = (over: Record<string, unknown> = {}) =>
  evaluateInstallability({
    manifestFound: true,
    manifestParseError: false,
    manifest: goodSummary,
    secureContext: true,
    hasServiceWorker: true,
    ...over,
  });

const codes = (gaps: ReadonlyArray<{ code: string }>) => gaps.map((g) => g.code);

describe('summarizeManifest', () => {
  it('maps snake_case fields and icons', () => {
    expect(goodSummary).toEqual({
      name: 'Example App',
      shortName: 'Example',
      startUrl: '/',
      scope: '/',
      display: 'standalone',
      themeColor: '#fff',
      backgroundColor: '#000',
      icons: [
        { src: '/i192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/i512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    });
  });

  it('tolerates a non-object and drops icons without src', () => {
    const s = summarizeManifest({ icons: [{ sizes: '48x48' }, 42, { src: '/ok.png' }] });
    expect(s.name).toBeNull();
    expect(s.icons).toEqual([{ src: '/ok.png', sizes: null, type: null, purpose: null }]);
  });
});

describe('evaluateInstallability', () => {
  it('passes a complete manifest with no gaps', () => {
    const r = evalGood();
    expect(r.installable).toBe(true);
    expect(r.gaps).toHaveLength(0);
  });

  it('flags insecure context and missing service worker as blocking', () => {
    const r = evalGood({ secureContext: false, hasServiceWorker: false });
    expect(r.installable).toBe(false);
    expect(codes(r.gaps)).toEqual(
      expect.arrayContaining(['not_secure_context', 'no_service_worker']),
    );
  });

  it('returns only no_manifest when the manifest is absent (no icon checks)', () => {
    const r = evaluateInstallability({
      manifestFound: false,
      manifestParseError: false,
      manifest: null,
      secureContext: true,
      hasServiceWorker: true,
    });
    expect(codes(r.gaps)).toEqual(['no_manifest']);
    expect(r.installable).toBe(false);
  });

  it('reports a parse error', () => {
    const r = evaluateInstallability({
      manifestFound: true,
      manifestParseError: true,
      manifest: null,
      secureContext: true,
      hasServiceWorker: true,
    });
    expect(codes(r.gaps)).toEqual(['manifest_parse_error']);
  });

  it('flags missing icon sizes and a non-app display', () => {
    const m = summarizeManifest({
      name: 'X',
      start_url: '/',
      display: 'browser',
      icons: [{ src: '/i.png', sizes: '48x48' }],
    });
    const r = evalGood({ manifest: m });
    expect(codes(r.gaps)).toEqual(
      expect.arrayContaining(['display_not_app', 'no_192_icon', 'no_512_icon', 'no_maskable_icon']),
    );
    expect(r.installable).toBe(false);
  });

  it('treats a missing maskable icon as a warning, not a blocker', () => {
    const m = summarizeManifest({
      name: 'X',
      start_url: '/',
      display: 'standalone',
      icons: [
        { src: '/i192.png', sizes: '192x192' },
        { src: '/i512.png', sizes: '512x512' },
      ],
    });
    const r = evalGood({ manifest: m });
    expect(codes(r.gaps)).toEqual(['no_maskable_icon']);
    expect(r.gaps[0]!.severity).toBe('warning');
    expect(r.installable).toBe(true);
  });

  it("accepts an icon with sizes 'any'", () => {
    const m = summarizeManifest({
      name: 'X',
      start_url: '/',
      display: 'standalone',
      icons: [{ src: '/i.svg', sizes: 'any', purpose: 'any maskable' }],
    });
    const r = evalGood({ manifest: m });
    expect(r.installable).toBe(true);
    expect(r.gaps).toHaveLength(0);
  });

  it('flags a manifest with neither name nor short_name', () => {
    const m = summarizeManifest({ start_url: '/', display: 'standalone', icons: goodManifestJson.icons });
    expect(codes(evalGood({ manifest: m }).gaps)).toContain('no_name');
  });
});

describe('readInstallability', () => {
  const baseEnv = {
    baseUrl: 'https://app.example/',
    secureContext: true,
    hasServiceWorker: true,
  };

  it('reports no_manifest when there is no <link rel=manifest>', async () => {
    const r = await readInstallability({
      ...baseEnv,
      manifestHref: null,
      fetchText: async () => ({ ok: true, status: 200, text: '{}' }),
    });
    expect(r.manifestFound).toBe(false);
    expect(r.gaps.map((g) => g.code)).toContain('no_manifest');
  });

  it('fetches, parses, and evaluates a good manifest', async () => {
    let fetchedUrl = '';
    const r = await readInstallability({
      ...baseEnv,
      manifestHref: '/manifest.webmanifest',
      fetchText: async (url) => {
        fetchedUrl = url;
        return { ok: true, status: 200, text: JSON.stringify(goodManifestJson) };
      },
    });
    expect(fetchedUrl).toBe('https://app.example/manifest.webmanifest');
    expect(r.manifestFound).toBe(true);
    expect(r.installable).toBe(true);
    expect(r.manifest?.name).toBe('Example App');
  });

  it('handles a failed manifest fetch', async () => {
    const r = await readInstallability({
      ...baseEnv,
      manifestHref: '/manifest.webmanifest',
      fetchText: async () => ({ ok: false, status: 404, text: '' }),
    });
    expect(r.manifestFound).toBe(false);
    expect(r.gaps.map((g) => g.code)).toContain('no_manifest');
  });

  it('reports a parse error on invalid JSON', async () => {
    const r = await readInstallability({
      ...baseEnv,
      manifestHref: '/m.json',
      fetchText: async () => ({ ok: true, status: 200, text: 'not json {' }),
    });
    expect(r.manifestFound).toBe(true);
    expect(r.gaps.map((g) => g.code)).toContain('manifest_parse_error');
  });
});
