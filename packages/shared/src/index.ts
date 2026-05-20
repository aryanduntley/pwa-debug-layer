export type {
  HostToExtensionMessage,
  ExtensionToHostMessage,
  AnyProtocolMessage,
} from './protocol.js';

export type {
  CaptureMeta,
  ConsoleLevel,
  ConsoleCapturedEvent,
  FetchCapturedEvent,
  XhrCapturedEvent,
  WebSocketCapturedEvent,
  NodeSummary,
  DomMutationPatch,
  DomMutationCapturedEvent,
  DomMutationCaptureOptions,
  PageLifecycleSubkind,
  PageLifecyclePayload,
  SwLifecycleSubkind,
  SwLifecyclePayload,
  CsLifecycleSubkind,
  CsLifecyclePayload,
  LifecycleSubkind,
  LifecycleCapturedEvent,
  LifecycleCaptureOptions,
  StoreChangeAction,
  StoreChangeDiff,
  StoreChangeCapturedEvent,
  ReplayCapturedEvent,
  CapturedEvent,
} from './types/captured_event.js';

export type {
  Cursor,
  CursorParts,
  CursorDecodeResult,
  FilterPattern,
  FilterSpec,
} from './types/filter_spec.js';

export { encodeCursor, decodeCursor } from './types/filter_spec.js';

export type {
  SourceFilterError,
  SourceFilterPredicate,
  SourceFilterCompileResult,
} from './types/source_filter.js';

export { compileSourceFilter } from './types/source_filter.js';

export type {
  EntryEnvelope,
  ConsoleEntry,
  NetworkEntry,
  StoreChangeEntry,
  ReplayEntry,
} from './types/wire_entries.js';

export type {
  SettingScope,
  CaptureKind,
  ReadControlValue,
  SettingTypeMap,
  SettingKey,
  SettingTypeTag,
  SettingSchemaEntry,
  SettingsSchema,
  SettingsRecord,
  SettingChange,
  SettingsEventTool,
  SettingsSnapshotPayload,
  SettingsIpcEventPayload,
} from './types/settings_schema.js';

export {
  CAPTURE_KINDS,
  SETTINGS_SCHEMA,
  settingKeys,
  getSettingEntry,
  validateSettingValue,
  defaultSettings,
} from './types/settings_schema.js';
