/**
 * Cross-package settings vocabulary — the single source of truth for every
 * user-tunable setting in pwa-debug.
 *
 * Plug-ability invariant (M7): adding a new setting is exactly ONE line in
 * {@link SettingTypeMap} + ONE entry in {@link SETTINGS_SCHEMA}. The host
 * settings store, the settings.* MCP tools, and the extension settings cache
 * all iterate {@link settingKeys} / {@link getSettingEntry} — no key is ever
 * hardcoded — so a new key needs zero changes to any consumer's shape.
 *
 * Lives in @pwa-debug/shared so the host store and the (T3) extension cache
 * enforce identical key/value shapes at compile time via getSetting<K>.
 */

import type { ConsoleLevel } from './captured_event.js';
import type { FilterSpec } from './filter_spec.js';

/** Which runtime(s) consume a setting. */
export type SettingScope = 'host' | 'extension' | 'both';

/** Capture-pipeline event kinds. M11 T3 added 'store_change'; M12 T1 added 'replay' (rrweb). */
export type CaptureKind =
  | 'console'
  | 'network'
  | 'dom_mutations'
  | 'lifecycle'
  | 'store_change'
  | 'replay';

/** Runtime tuple of every {@link CaptureKind}, for validation and introspection. */
export const CAPTURE_KINDS: readonly CaptureKind[] = [
  'console',
  'network',
  'dom_mutations',
  'lifecycle',
  'store_change',
  'replay',
] as const;

/**
 * Per-kind read-permission flags for a single glob match. Missing flag = allowed
 * (no restriction); `false` denies that kind for matching URLs. Used as the
 * record value of `sites.readControls`.
 */
export type ReadControlValue = Partial<Readonly<Record<CaptureKind, boolean>>>;

/**
 * The single source of truth mapping every setting key to its value type.
 * Add a setting = add one line here + one {@link SETTINGS_SCHEMA} entry; the
 * type system then forces every getSetting<K>/setSetting<K> call site (host
 * and extension) to use the correct value shape.
 *
 * Future keys deliberately accommodated as one-line additions (NOT shipped in
 * M7): `capture.filters`, `ui.preferences`. `sites.readControls` shipped in
 * M10 T1 as the first plug-ability proof-point.
 */
export type SettingTypeMap = {
  readonly 'capture.memoryCutoffPerKind': number;
  readonly 'capture.diskSpill.enabled': boolean;
  readonly 'capture.diskSpill.archiveLongevityDays': number;
  readonly 'capture.diskSpill.maxBytes': number;
  readonly 'sites.allowlist': readonly string[];
  readonly 'sites.blocklist': readonly string[];
  readonly 'capture.enabledKinds': readonly CaptureKind[];
  readonly 'sites.readControls': Readonly<Record<string, ReadControlValue>>;
  readonly 'capture.filters': Readonly<Partial<Record<CaptureKind, FilterSpec>>>;
  readonly 'capture.stores.allowDispatch': boolean;
  readonly 'capture.sourceMap.enabled': boolean;
};

/** Union of every valid setting key, derived so it can never drift from the value map. */
export type SettingKey = keyof SettingTypeMap;

/** Coarse runtime type tag carried per entry purely for AI/UI introspection. */
export type SettingTypeTag =
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'enum[]'
  | 'record';

/** One schema-as-data entry: key, introspection tag, default, scope, description, pure validator. */
export type SettingSchemaEntry<K extends SettingKey = SettingKey> = {
  readonly key: K;
  readonly type: SettingTypeTag;
  readonly default: SettingTypeMap[K];
  readonly scope: SettingScope;
  readonly description: string;
  readonly validate: (value: unknown) => value is SettingTypeMap[K];
  /** Present only for 'enum[]' tags — the allowed element values, for introspection. */
  readonly enumValues?: readonly string[];
};

/** The frozen schema map: every key to its per-key entry. */
export type SettingsSchema = {
  readonly [K in SettingKey]: SettingSchemaEntry<K>;
};

/** A fully-materialized settings object: every key present with a concrete typed value. */
export type SettingsRecord = {
  readonly [K in SettingKey]: SettingTypeMap[K];
};

/**
 * Discriminated-by-key change payload delivered to host_settings subscribers
 * and (T3) pushed over IPC to the extension cache. Switching on `.key`
 * narrows `.value` to the exact per-key type.
 */
export type SettingChange = {
  readonly [K in SettingKey]: { readonly key: K; readonly value: SettingTypeMap[K] };
}[SettingKey];

/**
 * IPC event-tool discriminants for settings traffic. Carried on
 * IpcEventEnvelope.tool when host pushes settings to the extension SW.
 *   • 'settings_snapshot' — full SettingsRecord on register/rehydrate.
 *   • 'settings_changed'  — single SettingChange on each store update.
 */
export type SettingsEventTool = 'settings_snapshot' | 'settings_changed';

/** Payload of an event envelope when tool === 'settings_snapshot'. */
export type SettingsSnapshotPayload = {
  readonly values: SettingsRecord;
};

/**
 * Discriminated-by-tool union of every settings IPC event payload. The
 * extension cache narrows incoming envelopes by `.tool` and routes the
 * correctly-typed payload to applySnapshot / applyChange. Adding a future
 * settings event tool = one variant here + one handler branch.
 */
export type SettingsIpcEventPayload =
  | {
      readonly tool: 'settings_snapshot';
      readonly payload: SettingsSnapshotPayload;
    }
  | { readonly tool: 'settings_changed'; readonly payload: SettingChange };

// --- internal primitive guards (not exported; not part of the public surface) ---

const isNonNegInt = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  Number.isInteger(v) &&
  v >= 0;

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const isCaptureKindSubset = (v: unknown): v is readonly CaptureKind[] =>
  Array.isArray(v) &&
  new Set(v).size === v.length &&
  v.every((x): x is CaptureKind =>
    (CAPTURE_KINDS as readonly string[]).includes(x as string),
  );

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isReadControlValue = (v: unknown): v is ReadControlValue => {
  if (!isPlainObject(v)) return false;
  const allowed = CAPTURE_KINDS as readonly string[];
  for (const [k, flag] of Object.entries(v)) {
    if (!allowed.includes(k)) return false;
    if (typeof flag !== 'boolean') return false;
  }
  return true;
};

const isReadControlsRecord = (
  v: unknown,
): v is Readonly<Record<string, ReadControlValue>> => {
  if (!isPlainObject(v)) return false;
  for (const value of Object.values(v)) {
    if (!isReadControlValue(value)) return false;
  }
  return true;
};

const CONSOLE_LEVELS: readonly ConsoleLevel[] = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
];

const isFilterPattern = (v: unknown): boolean => {
  if (!isPlainObject(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (k !== 'include' && k !== 'exclude') return false;
    if (val === undefined) continue;
    if (!Array.isArray(val)) return false;
    if (!val.every((x) => typeof x === 'string')) return false;
  }
  return true;
};

const FILTER_SPEC_SOURCE_KEYS: readonly string[] = ['level', 'pattern'];

const isSourceFilterSpec = (v: unknown): v is FilterSpec => {
  if (!isPlainObject(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (!FILTER_SPEC_SOURCE_KEYS.includes(k)) return false;
    if (val === undefined) continue;
    if (k === 'level') {
      if (!Array.isArray(val)) return false;
      if (!val.every((x): x is ConsoleLevel =>
          typeof x === 'string' && (CONSOLE_LEVELS as readonly string[]).includes(x),
        )) return false;
    } else if (k === 'pattern') {
      if (!isFilterPattern(val)) return false;
    }
  }
  return true;
};

const isCaptureFiltersRecord = (
  v: unknown,
): v is Readonly<Partial<Record<CaptureKind, FilterSpec>>> => {
  if (!isPlainObject(v)) return false;
  const allowed = CAPTURE_KINDS as readonly string[];
  for (const [k, val] of Object.entries(v)) {
    if (!allowed.includes(k)) return false;
    if (val === undefined) continue;
    if (!isSourceFilterSpec(val)) return false;
  }
  return true;
};

/**
 * The schema as data. Frozen. THIS is the single const instance; every
 * consumer reaches it through {@link settingKeys} / {@link getSettingEntry}.
 */
export const SETTINGS_SCHEMA: SettingsSchema = Object.freeze({
  'capture.memoryCutoffPerKind': {
    key: 'capture.memoryCutoffPerKind',
    type: 'number',
    default: 5000,
    scope: 'host',
    description:
      'Max events retained in memory per capture kind before eviction (overflow goes to disk when capture.diskSpill.enabled).',
    validate: isNonNegInt,
  },
  'capture.diskSpill.enabled': {
    key: 'capture.diskSpill.enabled',
    type: 'boolean',
    default: false,
    scope: 'host',
    description:
      'When true, events evicted from the in-memory ring buffer are written to on-disk jsonl archives instead of dropped.',
    validate: isBoolean,
  },
  'capture.diskSpill.archiveLongevityDays': {
    key: 'capture.diskSpill.archiveLongevityDays',
    type: 'number',
    default: 7,
    scope: 'host',
    description:
      'Age in days after which a disk archive file is pruned on the next pruner tick.',
    validate: isNonNegInt,
  },
  'capture.diskSpill.maxBytes': {
    key: 'capture.diskSpill.maxBytes',
    type: 'number',
    default: 100_000_000,
    scope: 'host',
    description:
      'Total disk-archive byte cap; oldest archive files are evicted first when exceeded.',
    validate: isNonNegInt,
  },
  'sites.allowlist': {
    key: 'sites.allowlist',
    type: 'string[]',
    default: ['*'],
    scope: 'both',
    description:
      'Glob patterns of origins/URLs the capture pipeline is permitted to record. Default ["*"] = all sites.',
    validate: isStringArray,
  },
  'sites.blocklist': {
    key: 'sites.blocklist',
    type: 'string[]',
    default: [],
    scope: 'both',
    description:
      'Glob patterns of origins/URLs never captured; takes precedence over sites.allowlist.',
    validate: isStringArray,
  },
  'capture.enabledKinds': {
    key: 'capture.enabledKinds',
    type: 'enum[]',
    default: [
      'console',
      'network',
      'dom_mutations',
      'lifecycle',
      'store_change',
      'replay',
    ],
    scope: 'both',
    description:
      'Subset of capture kinds actively recorded. Empty = capture nothing.',
    validate: isCaptureKindSubset,
    enumValues: CAPTURE_KINDS,
  },
  'sites.readControls': {
    key: 'sites.readControls',
    type: 'record',
    default: Object.freeze({}) as Readonly<Record<string, ReadControlValue>>,
    scope: 'both',
    description:
      'Per-site, per-kind read-permission overrides. Keys are glob patterns (same matcher as sites.allowlist); values are objects of CaptureKind→boolean flags. Missing flag = allowed; false denies that kind for matching URLs. Most-specific (longest) pattern wins per URL; ties broken lexicographically. Only DENIES events otherwise allowed by sites.allowlist + capture.enabledKinds — cannot re-enable what allowlist already rejected.',
    validate: isReadControlsRecord,
  },
  'capture.filters': {
    key: 'capture.filters',
    type: 'record',
    default: Object.freeze({}) as Readonly<Partial<Record<CaptureKind, FilterSpec>>>,
    scope: 'both',
    description:
      'Per-kind source-side capture filters. Keys are CaptureKinds; values are wire FilterSpecs (level + pattern only — cursors and limit are seq-based, meaningful only on the host). When set, the capture chokepoint applies the compiled predicate BEFORE the event reaches the host buffer; rejected events are dropped at the source. Validation tightens the wire shape to source-applicable fields only.',
    validate: isCaptureFiltersRecord,
  },
  'capture.stores.allowDispatch': {
    key: 'capture.stores.allowDispatch',
    type: 'boolean',
    default: false,
    scope: 'both',
    description:
      'When true, redux_dispatch (and forthcoming store-system dispatch tools) may write to the page-world store; when false (default), the dispatch tool rejects with an actionable next_steps[] hint. Gates the only write surface in the store-introspection family — reads (redux_get_state, redux_subscribe, redux_tail) are unaffected.',
    validate: isBoolean,
  },
  'capture.sourceMap.enabled': {
    key: 'capture.sourceMap.enabled',
    type: 'boolean',
    default: true,
    scope: 'both',
    description:
      'When true (default), source_map_resolve fetches and resolves source maps to translate generated stack frames into original-source coordinates. When false, the tool returns errorResponse with a hint. M13 ships query-time resolution only; capture-time auto-annotation is deferred to M13.5.',
    validate: isBoolean,
  },
}) as SettingsSchema;

/**
 * All setting keys in stable schema-declaration order — the canonical
 * iteration order for defaults-merge and settings.list_schema.
 */
export const settingKeys = (): readonly SettingKey[] =>
  Object.keys(SETTINGS_SCHEMA) as SettingKey[];

/**
 * Typed accessor for a single schema entry — the one DRY lookup point so a
 * future key change is a single schema edit, never a consumer change.
 */
export const getSettingEntry = <K extends SettingKey>(
  key: K,
): SettingSchemaEntry<K> => SETTINGS_SCHEMA[key];

/**
 * Central pure type-guard: validate an unknown value against a key's schema
 * validator. Single validation path shared by the host_settings store and the
 * settings.set MCP tool. Narrows `value` to SettingTypeMap[K] on true.
 */
export const validateSettingValue = <K extends SettingKey>(
  key: K,
  value: unknown,
): value is SettingTypeMap[K] => getSettingEntry(key).validate(value);

/**
 * Factory producing a fresh fully-materialized {@link SettingsRecord} of every
 * key's default. Array and plain-object defaults are cloned so the result
 * never aliases the frozen SETTINGS_SCHEMA. The base the host_settings store
 * merges over.
 */
export const defaultSettings = (): SettingsRecord =>
  Object.fromEntries(
    settingKeys().map((k) => {
      const d = getSettingEntry(k).default;
      if (Array.isArray(d)) return [k, [...d]];
      if (isPlainObject(d)) return [k, { ...d }];
      return [k, d];
    }),
  ) as SettingsRecord;
