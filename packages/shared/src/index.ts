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
  PopupHostSummary,
  PopupPhase,
  PopupDetection,
  PopupRole,
  PopupActionButton,
  PopupFailure,
  PopupState,
  PopupCapturedEvent,
  PageErrorCapturedEvent,
  SwStateSubkind,
  SwStateCapturedEvent,
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
  PopupEntry,
  PageErrorEntry,
  SwStateEntry,
  PopupConsoleError,
  PopupNetworkError,
  PopupPageError,
  PopupFailureWindow,
  PopupFailureReport,
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

export type {
  ActionParamType,
  ActionParamDef,
  ActionToolSpec,
} from './types/interaction_actions.js';

export { ACTION_TOOL_SPECS } from './types/interaction_actions.js';

export type {
  SwWorkerState,
  SwUpdateViaCache,
  SwWorkerRecord,
  SwRegistrationRecord,
  SwStatusSnapshot,
} from './types/sw_status.js';

export type {
  CacheEntryRecord,
  CacheListItem,
  CacheListResult,
  CacheInspectResult,
  CacheMatchResult,
} from './types/cache_storage.js';
