import type { ChecksConfig } from './types.js';

/** Built-in unresolved-copy patterns (spec §6.1 text_patterns). */
export const DEFAULT_TEXT_PATTERNS: readonly string[] = Object.freeze([
  '\\{\\{\\s*\\w+\\s*\\}\\}',
  '\\bundefined\\b',
  '\\bNaN\\b',
  '\\[object Object\\]',
]);

export const DEFAULT_CHECKS: ChecksConfig = Object.freeze({
  page_overflow_x: { enabled: true },
  offscreen: { enabled: true },
  // WCAG 2.2 AA 2.5.8 target size (minimum). 44/48 = platform guidelines.
  tap_target: { enabled: true, min: 24 },
  pinned_visible: { enabled: true, pinned_selectors: [] },
  text_clipped: { enabled: true },
  edge_contact: { enabled: true, min_inset: 4 },
  text_patterns: { enabled: true, extra: [] },
  errors: { enabled: true },
  // Off: gradients and images make the effective background approximate.
  contrast: { enabled: false },
});

/** Caller-facing partial config: a check is a boolean switch or a partial of its knobs. */
export type ChecksInput = {
  readonly [K in keyof ChecksConfig]?: boolean | Partial<ChecksConfig[K]>;
};

export type ChecksResolveResult =
  | { readonly ok: true; readonly config: ChecksConfig }
  | { readonly ok: false; readonly error: string };

const mergeCheck = <K extends keyof ChecksConfig>(
  key: K,
  input: ChecksInput,
): ChecksConfig[K] => {
  const base = DEFAULT_CHECKS[key];
  const given = input[key];
  if (given === undefined) return base;
  if (typeof given === 'boolean') return { ...base, enabled: given };
  return { ...base, enabled: true, ...(given as object) } as ChecksConfig[K];
};

/** Returns the first regex source that does not compile, or null. */
const compiles = (source: string): boolean => {
  try {
    new RegExp(source, 'g');
    return true;
  } catch {
    return false;
  }
};

export const findInvalidPattern = (sources: readonly string[]): string | null =>
  sources.find((s) => !compiles(s)) ?? null;

const inRange = (n: unknown, lo: number, hi: number): boolean =>
  typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

/**
 * Merge a caller's partial check config over DEFAULT_CHECKS and validate the
 * knobs (tap min 1..200 px, edge inset 0..64 px, extra patterns compile,
 * pinned selectors are strings). Pure: same input, same result.
 */
export const resolveChecksConfig = (input: ChecksInput | undefined): ChecksResolveResult => {
  const src = input ?? {};
  const config: ChecksConfig = Object.freeze({
    page_overflow_x: mergeCheck('page_overflow_x', src),
    offscreen: mergeCheck('offscreen', src),
    tap_target: mergeCheck('tap_target', src),
    pinned_visible: mergeCheck('pinned_visible', src),
    text_clipped: mergeCheck('text_clipped', src),
    edge_contact: mergeCheck('edge_contact', src),
    text_patterns: mergeCheck('text_patterns', src),
    errors: mergeCheck('errors', src),
    contrast: mergeCheck('contrast', src),
  });
  if (!inRange(config.tap_target.min, 1, 200)) {
    return { ok: false, error: 'checks.tap_target.min must be a number from 1 to 200 (CSS px)' };
  }
  if (!inRange(config.edge_contact.min_inset, 0, 64)) {
    return { ok: false, error: 'checks.edge_contact.min_inset must be a number from 0 to 64 (CSS px)' };
  }
  const extra = config.text_patterns.extra;
  if (!Array.isArray(extra) || extra.some((p) => typeof p !== 'string')) {
    return { ok: false, error: 'checks.text_patterns.extra must be an array of regex source strings' };
  }
  const bad = findInvalidPattern(extra);
  if (bad !== null) {
    return { ok: false, error: `checks.text_patterns.extra: invalid regex ${JSON.stringify(bad)}` };
  }
  const pinned = config.pinned_visible.pinned_selectors;
  if (!Array.isArray(pinned) || pinned.some((p) => typeof p !== 'string')) {
    return { ok: false, error: 'checks.pinned_visible.pinned_selectors must be an array of CSS selectors' };
  }
  return { ok: true, config };
};
