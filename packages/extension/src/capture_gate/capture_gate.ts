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
import type {
  CaptureKind,
  FilterSpec,
  ReadControlValue,
  SettingsRecord,
} from '@pwa-debug/shared';
import { compileSourceFilter } from '@pwa-debug/shared';

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
  store_change: 'store_change',
  replay: 'replay',
  library_popup: 'library_popup',
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

/**
 * Pick the most-specific readControls entry whose glob pattern matches `url`.
 * Specificity = longest pattern string; ties broken by lexicographic order of
 * the pattern so the choice is deterministic. Returns undefined when no
 * pattern matches (caller treats as no restriction).
 */
export const pickMostSpecificReadControl = (
  url: string,
  controls: Readonly<Record<string, ReadControlValue>>,
): ReadControlValue | undefined => {
  let winnerPattern: string | undefined;
  let winnerValue: ReadControlValue | undefined;
  for (const [pattern, value] of Object.entries(controls)) {
    if (!matchesAnyGlob(url, [pattern])) continue;
    if (winnerPattern === undefined) {
      winnerPattern = pattern;
      winnerValue = value;
      continue;
    }
    if (
      pattern.length > winnerPattern.length ||
      (pattern.length === winnerPattern.length && pattern < winnerPattern)
    ) {
      winnerPattern = pattern;
      winnerValue = value;
    }
  }
  return winnerValue;
};

/**
 * True iff the resolved readControls entry permits the given CaptureKind.
 * Missing flag = allowed (no restriction); explicit `false` denies. Undefined
 * control (no matching readControls entry) = allowed.
 */
export const isKindAllowedByReadControls = (
  kind: CaptureKind,
  control: ReadControlValue | undefined,
): boolean => control?.[kind] !== false;

/**
 * True iff the per-kind capture.filters predicate (if configured) accepts the
 * event. No filter for the resolved kind => allow. compileSourceFilter ok:false
 * (malformed regex despite the schema validator) => fail-open (allow) so a
 * single bad filter cannot suppress all events of a kind.
 */
export const passesCaptureFilter = (
  event: unknown,
  captureKind: CaptureKind,
  filters: Readonly<Partial<Record<CaptureKind, FilterSpec>>>,
): boolean => {
  const spec = filters[captureKind];
  if (spec === undefined) return true;
  const compiled = compileSourceFilter(spec);
  if (!compiled.ok) return true;
  return compiled.predicate(event);
};

type CaptureGateSettings = Pick<
  SettingsRecord,
  | 'sites.allowlist'
  | 'sites.blocklist'
  | 'capture.enabledKinds'
  | 'sites.readControls'
  | 'capture.filters'
>;

export const shouldCaptureEvent = (
  event: { readonly kind: string; readonly frameUrl: string },
  settings: CaptureGateSettings,
): boolean => {
  if (!isKindEnabled(event.kind, settings['capture.enabledKinds'])) {
    return false;
  }
  if (
    !isUrlAllowed(
      event.frameUrl,
      settings['sites.allowlist'],
      settings['sites.blocklist'],
    )
  ) {
    return false;
  }
  const captureKind = eventKindToCaptureKind(event.kind);
  if (captureKind === null) return true; // unknown raw kinds default-allow
  const control = pickMostSpecificReadControl(
    event.frameUrl,
    settings['sites.readControls'],
  );
  if (!isKindAllowedByReadControls(captureKind, control)) return false;
  return passesCaptureFilter(event, captureKind, settings['capture.filters']);
};
