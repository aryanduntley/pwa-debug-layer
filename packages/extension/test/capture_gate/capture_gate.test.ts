import { describe, it, expect } from 'vitest';
import {
  defaultSettings,
  type FilterSpec,
  type ReadControlValue,
} from '@pwa-debug/shared';
import {
  eventKindToCaptureKind,
  isKindAllowedByReadControls,
  isKindEnabled,
  isUrlAllowed,
  matchesAnyGlob,
  passesCaptureFilter,
  pickMostSpecificReadControl,
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

describe('pickMostSpecificReadControl', () => {
  it('returns undefined for an empty record', () => {
    expect(pickMostSpecificReadControl('https://x.com/', {})).toBeUndefined();
  });

  it('returns undefined when no pattern matches', () => {
    expect(
      pickMostSpecificReadControl('https://x.com/', {
        'https://other.com/*': { console: false },
      }),
    ).toBeUndefined();
  });

  it('returns the single matching entry', () => {
    const value: ReadControlValue = { console: false };
    expect(
      pickMostSpecificReadControl('https://ok.com/a', {
        'https://ok.com/*': value,
      }),
    ).toEqual(value);
  });

  it('picks the longest-pattern winner among multiple matches', () => {
    const short: ReadControlValue = { console: false };
    const long: ReadControlValue = { network: false };
    const winner = pickMostSpecificReadControl(
      'https://shop.ok.com/cart',
      {
        'https://*.com/*': short, // matches (15 chars)
        'https://*.ok.com/*': long, // matches (18 chars) — longer wins
      },
    );
    expect(winner).toEqual(long);
  });

  it('breaks length-ties lexicographically (smaller pattern wins)', () => {
    // Both patterns are length 15 and both match 'https://x.com/y':
    //   'http*://x.com/*' — pos 4 is '*' (ASCII 42)
    //   'https://x.*om/*' — pos 4 is 's' (ASCII 115)
    // Lex-smaller = 'http*...' wins.
    const a: ReadControlValue = { console: false };
    const b: ReadControlValue = { network: false };
    const winner = pickMostSpecificReadControl('https://x.com/y', {
      'https://x.*om/*': a,
      'http*://x.com/*': b,
    });
    expect(winner).toEqual(b);
  });
});

describe('isKindAllowedByReadControls', () => {
  it('undefined control = allowed (no matching readControls)', () => {
    expect(isKindAllowedByReadControls('console', undefined)).toBe(true);
  });

  it('missing flag defaults to allowed', () => {
    expect(isKindAllowedByReadControls('console', {})).toBe(true);
    expect(isKindAllowedByReadControls('console', { network: false })).toBe(true);
  });

  it('explicit false denies', () => {
    expect(isKindAllowedByReadControls('console', { console: false })).toBe(false);
    expect(isKindAllowedByReadControls('network', { network: false })).toBe(false);
  });

  it('explicit true is allowed (same as missing)', () => {
    expect(isKindAllowedByReadControls('console', { console: true })).toBe(true);
  });

  it('per-kind isolation: denying one kind does not affect others', () => {
    const control: ReadControlValue = { console: false };
    expect(isKindAllowedByReadControls('console', control)).toBe(false);
    expect(isKindAllowedByReadControls('network', control)).toBe(true);
    expect(isKindAllowedByReadControls('dom_mutations', control)).toBe(true);
    expect(isKindAllowedByReadControls('lifecycle', control)).toBe(true);
  });
});

describe('shouldCaptureEvent — readControls integration', () => {
  const base = defaultSettings();

  it('readControls absent (empty {}) = no change vs M9 behavior', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x' },
        base,
      ),
    ).toBe(true);
  });

  it('denies the matched kind while letting other kinds through for the same URL', () => {
    const settings = {
      ...base,
      'sites.readControls': {
        '*.tracking.com/*': { console: false } as ReadControlValue,
      },
    };
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://sub.tracking.com/x' },
        settings,
      ),
    ).toBe(false);
    expect(
      shouldCaptureEvent(
        { kind: 'fetch', frameUrl: 'https://sub.tracking.com/x' },
        settings,
      ),
    ).toBe(true);
  });

  it('non-matching URL is unaffected by readControls', () => {
    const settings = {
      ...base,
      'sites.readControls': {
        '*.tracking.com/*': { console: false } as ReadControlValue,
      },
    };
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x' },
        settings,
      ),
    ).toBe(true);
  });

  it('readControls applied AFTER enabledKinds — kind disabled globally still drops', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x' },
        {
          ...base,
          'capture.enabledKinds': ['network'],
          'sites.readControls': {
            '*': { console: true } as ReadControlValue, // re-enable attempt — must NOT lift the kind ban
          },
        },
      ),
    ).toBe(false);
  });

  it('readControls cannot re-enable what allowlist already rejected', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://other.com/x' },
        {
          ...base,
          'sites.allowlist': ['https://ok.com/*'],
          'sites.readControls': {
            '*': { console: true } as ReadControlValue,
          },
        },
      ),
    ).toBe(false);
  });

  it('most-specific pattern wins when multiple readControls entries match', () => {
    // Broad pattern allows console; specific pattern denies console for one URL
    const settings = {
      ...base,
      'sites.readControls': {
        '*': { console: true } as ReadControlValue,
        '*.tracker.com/*': { console: false } as ReadControlValue,
      },
    };
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://x.tracker.com/path' },
        settings,
      ),
    ).toBe(false);
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://other.com/path' },
        settings,
      ),
    ).toBe(true);
  });
});

describe('passesCaptureFilter', () => {
  it('no filter for the kind = allow', () => {
    expect(
      passesCaptureFilter({ level: 'log' }, 'console', {}),
    ).toBe(true);
  });

  it('level filter drops mismatched levels', () => {
    const filters = { console: { level: ['error'] } as FilterSpec };
    expect(
      passesCaptureFilter({ level: 'log' }, 'console', filters),
    ).toBe(false);
    expect(
      passesCaptureFilter({ level: 'error' }, 'console', filters),
    ).toBe(true);
  });

  it('pattern filter applies to JSON.stringify of event', () => {
    const filters = {
      console: { pattern: { include: ['boom'] } } as FilterSpec,
    };
    expect(
      passesCaptureFilter({ args: ['boom!'] }, 'console', filters),
    ).toBe(true);
    expect(
      passesCaptureFilter({ args: ['quiet'] }, 'console', filters),
    ).toBe(false);
  });

  it('only applies the filter for the matching kind', () => {
    const filters = { console: { level: ['error'] } as FilterSpec };
    expect(
      passesCaptureFilter({ url: '/api/x' }, 'network', filters),
    ).toBe(true);
  });

  it('fail-open when filter compile fails (defensive)', () => {
    // schema validator should reject this; the runtime guards anyway.
    const filters = {
      console: { pattern: { include: ['[unclosed'] } } as FilterSpec,
    };
    expect(
      passesCaptureFilter({ level: 'log' }, 'console', filters),
    ).toBe(true);
  });
});

describe('shouldCaptureEvent — capture.filters integration', () => {
  const base = defaultSettings();

  it('absent filter for a kind = no change', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x' },
        base,
      ),
    ).toBe(true);
  });

  it('filters.console = {level:["error"]} drops non-error console', () => {
    const settings = {
      ...base,
      'capture.filters': {
        console: { level: ['error'] } as FilterSpec,
      },
    };
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x', level: 'log' } as {
          kind: string;
          frameUrl: string;
        },
        settings,
      ),
    ).toBe(false);
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x', level: 'error' } as {
          kind: string;
          frameUrl: string;
        },
        settings,
      ),
    ).toBe(true);
  });

  it('filters.network with include pattern applies to JSON.stringify', () => {
    const settings = {
      ...base,
      'capture.filters': {
        network: { pattern: { include: ['/api/'] } } as FilterSpec,
      },
    };
    expect(
      shouldCaptureEvent(
        { kind: 'fetch', frameUrl: 'https://ok.com/', url: '/api/users' } as {
          kind: string;
          frameUrl: string;
        },
        settings,
      ),
    ).toBe(true);
    expect(
      shouldCaptureEvent(
        { kind: 'fetch', frameUrl: 'https://ok.com/', url: '/health' } as {
          kind: string;
          frameUrl: string;
        },
        settings,
      ),
    ).toBe(false);
  });

  it('filter applies AFTER enabledKinds — kind disabled still drops', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://ok.com/x', level: 'error' } as {
          kind: string;
          frameUrl: string;
        },
        {
          ...base,
          'capture.enabledKinds': ['network'],
          'capture.filters': {
            console: { level: ['error'] } as FilterSpec,
          },
        },
      ),
    ).toBe(false);
  });

  it('filter applies AFTER readControls — readControls denial wins over filter allow', () => {
    expect(
      shouldCaptureEvent(
        { kind: 'console', frameUrl: 'https://x.tracker.com/y', level: 'error' } as {
          kind: string;
          frameUrl: string;
        },
        {
          ...base,
          'sites.readControls': {
            '*.tracker.com/*': { console: false } as ReadControlValue,
          },
          'capture.filters': {
            console: { level: ['error'] } as FilterSpec,
          },
        },
      ),
    ).toBe(false);
  });
});
