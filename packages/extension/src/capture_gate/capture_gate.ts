// The gate lives in @pwa-debug/shared so the host applies the same rules to
// CDP (phone) connections. Re-exported here for the SW and existing importers.
export {
  matchesAnyGlob,
  eventKindToCaptureKind,
  isKindEnabled,
  isUrlAllowed,
  pickMostSpecificReadControl,
  isKindAllowedByReadControls,
  passesCaptureFilter,
  shouldCaptureEvent,
} from '@pwa-debug/shared';
export type { CaptureGateSettings } from '@pwa-debug/shared';
