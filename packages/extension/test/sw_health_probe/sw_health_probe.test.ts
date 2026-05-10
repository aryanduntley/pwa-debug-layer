import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyDispatchFailure,
  classifyRestrictedUrl,
  probeTabScripting,
  selfHealCsAttachment,
} from '../../src/sw_health_probe/sw_health_probe.js';

describe('classifyRestrictedUrl', () => {
  it('flags chrome:// URLs as restricted_url', () => {
    expect(classifyRestrictedUrl('chrome://extensions')).toBe('restricted_url');
    expect(classifyRestrictedUrl('chrome://newtab/')).toBe('restricted_url');
  });

  it('flags about:, file://, devtools://, view-source: URLs', () => {
    expect(classifyRestrictedUrl('about:blank')).toBe('restricted_url');
    expect(classifyRestrictedUrl('file:///tmp/x.html')).toBe('restricted_url');
    expect(classifyRestrictedUrl('devtools://devtools/bundled/')).toBe(
      'restricted_url',
    );
    expect(classifyRestrictedUrl('view-source:https://x')).toBe(
      'restricted_url',
    );
  });

  it('flags chromewebstore.google.com as restricted_url', () => {
    expect(
      classifyRestrictedUrl('https://chromewebstore.google.com/detail/foo'),
    ).toBe('restricted_url');
    expect(
      classifyRestrictedUrl(
        'https://chrome.google.com/webstore/detail/abc',
      ),
    ).toBe('restricted_url');
  });

  it('returns null for normal http(s) URLs', () => {
    expect(classifyRestrictedUrl('https://example.com/')).toBeNull();
    expect(classifyRestrictedUrl('http://localhost:3000/x')).toBeNull();
    expect(classifyRestrictedUrl('https://chainsale.app/')).toBeNull();
  });

  it('returns null for undefined or unparseable URLs', () => {
    expect(classifyRestrictedUrl(undefined)).toBeNull();
    expect(classifyRestrictedUrl('')).toBeNull();
    expect(classifyRestrictedUrl('not a url')).toBeNull();
  });
});

describe('probeTabScripting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'scripts_run' when chrome.scripting.executeScript resolves", async () => {
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec.mockResolvedValueOnce([{ result: '__pwa_debug_probe__' } as never]);
    await expect(probeTabScripting(7)).resolves.toBe('scripts_run');
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 }, world: 'ISOLATED' }),
    );
  });

  it("returns 'scripts_blocked' when chrome.scripting.executeScript throws", async () => {
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec.mockRejectedValueOnce(new Error('Cannot access contents of url'));
    await expect(probeTabScripting(7)).resolves.toBe('scripts_blocked');
  });
});

describe('classifyDispatchFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns restricted_url when the URL is browser-restricted (no probe call)', async () => {
    const exec = vi.mocked(chrome.scripting.executeScript);
    const callsBefore = exec.mock.calls.length;
    const r = await classifyDispatchFailure({
      tabId: 7,
      url: 'chrome://extensions',
      lastErrorMessage: 'Could not establish connection',
    });
    expect(r.code).toBe('restricted_url');
    expect(r.message).toBe('Could not establish connection');
    expect(exec.mock.calls.length).toBe(callsBefore);
  });

  it('returns page_blocks_scripts when probe throws on a normal URL', async () => {
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec.mockRejectedValueOnce(new Error('Cannot access contents of url'));
    const r = await classifyDispatchFailure({
      tabId: 7,
      url: 'https://chainsale.app/',
      lastErrorMessage: 'Could not establish connection',
    });
    expect(r.code).toBe('page_blocks_scripts');
    expect(r.message).toBe('Could not establish connection');
  });

  it('returns cs_not_attached_refresh_tab when probe succeeds on a normal URL', async () => {
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec.mockResolvedValueOnce([{ result: '__pwa_debug_probe__' } as never]);
    const r = await classifyDispatchFailure({
      tabId: 7,
      url: 'https://chainsale.app/',
      lastErrorMessage: 'Could not establish connection',
    });
    expect(r.code).toBe('cs_not_attached_refresh_tab');
  });

  it('falls back to probe when URL is undefined', async () => {
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec.mockResolvedValueOnce([{ result: '__pwa_debug_probe__' } as never]);
    const r = await classifyDispatchFailure({
      tabId: 7,
      url: undefined,
      lastErrorMessage: 'x',
    });
    expect(r.code).toBe('cs_not_attached_refresh_tab');
  });
});

describe('selfHealCsAttachment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects content-script.js (ISOLATED) and page-world.js (MAIN) in order', async () => {
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec.mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never);
    const r = await selfHealCsAttachment(7);
    expect(r.ok).toBe(true);
    expect(exec).toHaveBeenNthCalledWith(1, {
      target: { tabId: 7 },
      world: 'ISOLATED',
      files: ['content-script.js'],
    });
    expect(exec).toHaveBeenNthCalledWith(2, {
      target: { tabId: 7 },
      world: 'MAIN',
      files: ['page-world.js'],
    });
  });

  it('returns ok:false with reason when injection throws', async () => {
    const exec = vi.mocked(chrome.scripting.executeScript);
    exec.mockRejectedValueOnce(new Error('Cannot access contents of url'));
    const r = await selfHealCsAttachment(7);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/Cannot access contents/);
    }
  });
});
