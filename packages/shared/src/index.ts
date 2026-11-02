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

export type {
  StorageEntry,
  StorageArea,
  StorageGetResult,
  IdbIndexInfo,
  IdbStoreInfo,
  IdbDatabaseInfo,
  IdbListResult,
  IdbRecord,
  IdbQueryResult,
} from './types/storage.js';

export type {
  PwaPermissionState,
  PwaCapabilities,
  PwaPermissionsSnapshot,
  PwaStatusSnapshot,
} from './types/pwa_status.js';

export type {
  AssetKind,
  CachedAssetAge,
  NetworkFailure,
  UpdateFindingCode,
  UpdateFinding,
  UpdateAnalysisResult,
  UpdateGatherResult,
} from './types/update_analysis.js';

export type {
  RuntimeStoreState,
  RuntimeWebStorage,
  RuntimeSnapshot,
} from './types/runtime_snapshot.js';

export type {
  InstallabilityGapCode,
  InstallabilityGap,
  ManifestIconSummary,
  ManifestSummary,
  InstallabilityResult,
} from './types/installability.js';

export {
  CDP_BRIDGE_VERSION,
  CDP_EMIT_BINDING,
  CDP_GLOBAL,
} from './types/cdp_bridge.js';
export type { CdpEmitPayload, CdpDispatchRequest } from './types/cdp_bridge.js';

export { normalizeUrl } from './types/navigation_url.js';

export {
  matchesAnyGlob,
  eventKindToCaptureKind,
  isKindEnabled,
  isUrlAllowed,
  pickMostSpecificReadControl,
  isKindAllowedByReadControls,
  passesCaptureFilter,
  shouldCaptureEvent,
} from './capture_gate.js';
export type { CaptureGateSettings } from './capture_gate.js';

export type {
  LayoutCheckName,
  LayoutRect,
  ChecksConfig,
  LayoutFinding,
  LayoutMeasureRequest,
  LayoutMeasureResult,
  LayoutColorScheme,
  LayoutViewportSpec,
  LayoutStateDriver,
  LayoutView,
  LocatedFinding,
  LayoutGroup,
  LayoutSummary,
} from './layout_sweep/types.js';

export type { ChecksInput, ChecksResolveResult } from './layout_sweep/checks_config.js';
export {
  DEFAULT_CHECKS,
  DEFAULT_TEXT_PATTERNS,
  resolveChecksConfig,
  findInvalidPattern,
} from './layout_sweep/checks_config.js';

export type { SweepTarget, ViewportInput, SweepPlanInput, SweepPlan, SweepPlanResult } from './layout_sweep/plan.js';
export {
  DEFAULT_MAX_VIEWS,
  HARD_MAX_VIEWS,
  MAX_PAGES,
  resolvePageUrl,
  crossDimensions,
  defaultViewports,
  planSweep,
  pageLabel,
  viewLabel,
  planPageViews,
  viewVars,
  expandTemplate,
} from './layout_sweep/plan.js';

export { normalizeSignature, groupKey, groupFindings, summarizeFindings, capGroups } from './layout_sweep/group.js';
