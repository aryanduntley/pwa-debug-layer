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

/** Which runtime(s) consume a setting. */
export type SettingScope = 'host' | 'extension' | 'both';

/** The four capture-pipeline event kinds. */
export type CaptureKind = 'console' | 'network' | 'dom_mutations' | 'lifecycle';

/** Runtime tuple of every {@link CaptureKind}, for validation and introspection. */
export const CAPTURE_KINDS: readonly CaptureKind[] = [
  'console',
  'network',
  'dom_mutations',
  'lifecycle',
] as const;

/**
 * The single source of truth mapping every setting key to its value type.
 * Add a setting = add one line here + one {@link SETTINGS_SCHEMA} entry; the
 * type system then forces every getSetting<K>/setSetting<K> call site (host
 * and extension) to use the correct value shape.
 *
 * Future keys deliberately accommodated as one-line additions (NOT shipped in
 * M7): `sites.readControls`, `capture.filters`, `ui.preferences`.
 */
export type SettingTypeMap = {
  readonly 'capture.memoryCutoffPerKind': number;
  readonly 'capture.diskSpill.enabled': boolean;
  readonly 'capture.diskSpill.archiveLongevityDays': number;
  readonly 'capture.diskSpill.maxBytes': number;
  readonly 'sites.allowlist': readonly string[];
  readonly 'sites.blocklist': readonly string[];
  readonly 'capture.enabledKinds': readonly CaptureKind[];
};

/** Union of every valid setting key, derived so it can never drift from the value map. */
export type SettingKey = keyof SettingTypeMap;

/** Coarse runtime type tag carried per entry purely for AI/UI introspection. */
export type SettingTypeTag = 'number' | 'boolean' | 'string[]' | 'enum[]';

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
    default: ['console', 'network', 'dom_mutations', 'lifecycle'],
    scope: 'both',
    description:
      'Subset of capture kinds actively recorded. Empty = capture nothing.',
    validate: isCaptureKindSubset,
    enumValues: CAPTURE_KINDS,
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
 * key's default. Array defaults are cloned so the result never aliases the
 * frozen SETTINGS_SCHEMA. The base the host_settings store merges over.
 */
export const defaultSettings = (): SettingsRecord =>
  Object.fromEntries(
    settingKeys().map((k) => {
      const d = getSettingEntry(k).default;
      return [k, Array.isArray(d) ? [...d] : d];
    }),
  ) as SettingsRecord;
