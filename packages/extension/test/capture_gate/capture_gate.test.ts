import { describe, it, expect } from 'vitest';
import { defaultSettings } from '@pwa-debug/shared';
import {
  eventKindToCaptureKind,
  isKindEnabled,
  isUrlAllowed,
  matchesAnyGlob,
  shouldCaptureEvent,
} from '../../src/capture_gate/capture_gate.js';

describe('matchesAnyGlob', () => {
  it('returns false for an empty pattern list', () => {
    expect(matchesAnyGlob('https://x.com', [])).toBe(false);
  });

  it('"*" matches anything (including empty)', () => {
    expect(matchesAnyGlob('https://x.com/path', ['*'])).toBe(true);
    expect(matchesAnyGlob('', ['*'])).toBe(true);
  });

  it('exact match', () => {
    expect(matchesAnyGlob('https://ok.com/', ['https://ok.com/'])).toBe(true);
    expect(matchesAnyGlob('https://no.com/', ['https://ok.com/'])).toBe(false);
  });

  it('prefix glob: pattern*', () => {
    expect(matchesAnyGlob('https://ok.com/a/b', ['https://ok.com/*'])).toBe(true);
    expect(matchesAnyGlob('https://elsewhere.com/', ['https://ok.com/*'])).toBe(false);
  });

  it('suffix glob: *.tld', () => {
    expect(matchesAnyGlob('https://sub.tracking.com/x', ['*.tracking.com/*'])).toBe(true);
    expect(matchesAnyGlob('https://safe.com/x', ['*.tracking.com/*'])).toBe(false);
  });

  it('any-of semantics across multiple patterns', () => {
    expect(matchesAnyGlob('https://b.com/x', ['https://a.com/*', 'https://b.com/*'])).toBe(true);
  });

  it('does not partially-match without wildcards', () => {
    // pattern 'b.com' must equal value exactly when no '*' is used
    expect(matchesAnyGlob('https://b.com/x', ['b.com'])).toBe(false);
  });
});

describe('eventKindToCaptureKind', () => {
  it('maps the six raw kinds to four M7 categories', () => {
    expect(eventKindToCaptureKind('console')).toBe('console');
    expect(eventKindToCaptureKind('fetch')).toBe('network');
    expect(eventKindToCaptureKind('xhr')).toBe('network');
    expect(eventKindToCaptureKind('websocket')).toBe('network');
    expect(eventKindToCaptureKind('dom_mutation')).toBe('dom_mutations');
    expect(eventKindToCaptureKind('lifecycle')).toBe('lifecycle');
  });

  it('returns null for unknown kinds (forward-compat sentinel)', () => {
    expect(eventKindToCaptureKind('not-a-known-kind')).toBeNull();
  });
});

describe('isKindEnabled', () => {
  it('allows kinds whose category is in the enabledKinds subset', () => {
    expect(isKindEnabled('console', ['console', 'network'])).toBe(true);
    expect(isKindEnabled('xhr', ['console', 'network'])).toBe(true);
    expect(isKindEnabled('fetch', ['console', 'network'])).toBe(true);
  });
  it('denies kinds whose category is absent', () => {
    expect(isKindEnabled('console', ['network'])).toBe(false);
    expect(isKindEnabled('dom_mutation', [])).toBe(false);
  });
  it('default-allows unknown raw kinds (forward-compat)', () => {
    expect(isKindEnabled('future-kind', [])).toBe(true);
  });
});

describe('isUrlAllowed', () => {
  it('"*" allowlist allows every URL when blocklist is empty', () => {
    expect(isUrlAllowed('https://anywhere.com/x', ['*'], [])).toBe(true);
  });

  it('empty allowlist denies everything', () => {
    expect(isUrlAllowed('https://anywhere.com/', [], [])).toBe(false);
    expect(isUrlAllowed('https://anywhere.com/', [], ['*'])).toBe(false);
  });

  it('blocklist wins over allowlist when both match', () => {
    expect(
      isUrlAllowed('https://tracker.com/x', ['*'], ['https://tracker.com/*']),
    ).toBe(false);
  });

  it('allowlist subset works', () => {
    expect(
      isUrlAllowed('https://ok.com/a', ['https://ok.com/*'], []),
    ).toBe(true);
    expect(
      isUrlAllowed('https://other.com/', ['https://ok.com/*'], []),
    ).toBe(false);
  });
});

describe('shouldCaptureEvent (composite)', () => {
  const base = defaultSettings(); // ['*'] allow, [] block, all kinds

  it('default settings allow a normal event', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x' },
        base,
      ),
    ).toBe(true);
  });

  it('drops events whose URL is blocked', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://tracker.com/x' },
        { ...base, 'sites.blocklist': ['https://tracker.com/*'] },
      ),
    ).toBe(false);
  });

  it('drops events whose URL is outside an explicit allowlist', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://other.com/' },
        { ...base, 'sites.allowlist': ['https://ok.com/*'] },
      ),
    ).toBe(false);
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x' },
        { ...base, 'sites.allowlist': ['https://ok.com/*'] },
      ),
    ).toBe(true);
  });

  it('drops events whose category is disabled', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'fetch', frameUrl: 'https://ok.com/x' },
        { ...base, 'capture.enabledKinds': ['console'] },
      ),
    ).toBe(false);
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x' },
        { ...base, 'capture.enabledKinds': ['console'] },
      ),
    ).toBe(true);
  });

  it('blocklist trumps allowlist match', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://both.com/x' },
        {
          ...base,
          'sites.allowlist': ['https://both.com/*'],
          'sites.blocklist': ['https://both.com/*'],
        },
      ),
    ).toBe(false);
  });
});
