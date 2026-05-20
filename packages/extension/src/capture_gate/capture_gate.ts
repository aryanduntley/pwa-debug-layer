/**
 * Pure-FP SW-side capture gating.
 *
 * Single chokepoint that decides — per event, per call — whether the capture
 * pipeline should record. Consumed by sw_event_sink as a `shouldRecord`
 * callback; service-worker.ts wires that callback to read from the
 * ext_settings_cache singleton so live host pushes (T3 `settings_changed`)
 * take effect on the very next event, no reload.
 *
 * Plug-ability invariant: the gate consumes a Pick<SettingsRecord,...>; adding
 * a future setting (sites.readControls, capture.filters, ...) leaves these
 * functions untouched.
 */
import type { CaptureKind, SettingsRecord } from '@pwa-debug/shared';

const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;

const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern.replace(REGEX_SPECIALS, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
};

export const matchesAnyGlob = (
  value: string,
  patterns: readonly string[],
): boolean => patterns.some((p) => globToRegex(p).test(value));

/**
 * Raw captured-event kinds (6) -> M7 capture categories (4).
 * The union side reflects the captured_event.ts kind discriminants.
 */
const KIND_MAP: Readonly<Record<string, CaptureKind>> = Object.freeze({
  console: 'console',
  fetch: 'network',
  xhr: 'network',
  websocket: 'network',
  dom_mutation: 'dom_mutations',
  lifecycle: 'lifecycle',
});

export const eventKindToCaptureKind = (
  rawKind: string,
): CaptureKind | null => KIND_MAP[rawKind] ?? null;

export const isKindEnabled = (
  rawKind: string,
  enabledKinds: readonly CaptureKind[],
): boolean => {
  const ck = eventKindToCaptureKind(rawKind);
  if (ck === null) return true; // unknown raw kinds default-allow (future-compat)
  return enabledKinds.includes(ck);
};

export const isUrlAllowed = (
  url: string,
  allowlist: readonly string[],
  blocklist: readonly string[],
): boolean => {
  if (matchesAnyGlob(url, blocklist)) return false; // blocklist wins
  if (allowlist.length === 0) return false; // explicit opt-in model
  return matchesAnyGlob(url, allowlist);
};

type CaptureGateSettings = Pick<
  SettingsRecord,
  'sites.allowlist' | 'sites.blocklist' | 'capture.enabledKinds'
>;

export const shouldCaptureEvent = (
  event: { readonly kind: string; readonly frameUrl: string },
  settings: CaptureGateSettings,
): boolean => {
  if (!isKindEnabled(event.kind, settings['capture.enabledKinds'])) {
    return false;
  }
  return isUrlAllowed(
    event.frameUrl,
    settings['sites.allowlist'],
    settings['sites.blocklist'],
  );
};
