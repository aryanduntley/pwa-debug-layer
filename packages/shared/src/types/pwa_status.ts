/**
 * Wire types for the pwa_status tool — a single snapshot of how the debugged PWA
 * is running right now and what it can do in this browser. Answers the common
 * "is it installed / standalone, is a SW controlling it, can it use push /
 * background sync / badging here" questions that are tedious to assemble by hand.
 *
 * Pure type module. Detection lives in the extension pwa_status module.
 */

/**
 * Normalized permission state. granted/denied/prompt mirror the Permissions
 * API; 'unsupported' = the permission name isn't queryable here; 'unknown' =
 * no Permissions API at all.
 */
export type PwaPermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'unsupported'
  | 'unknown';

/** Live feature-detection matrix of PWA-relevant browser APIs in the page. */
export type PwaCapabilities = {
  readonly serviceWorker: boolean;
  readonly pushManager: boolean;
  readonly backgroundSync: boolean;
  readonly periodicBackgroundSync: boolean;
  readonly badging: boolean;
  readonly fileSystemAccess: boolean;
  readonly windowControlsOverlay: boolean;
  readonly webShare: boolean;
  readonly notifications: boolean;
};

export type PwaPermissionsSnapshot = {
  readonly notifications: PwaPermissionState;
  readonly push: PwaPermissionState;
  readonly periodicBackgroundSync: PwaPermissionState;
};

export type PwaStatusSnapshot = {
  /** Active display mode; 'unknown' when matchMedia is unavailable. */
  readonly displayMode: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser' | 'unknown';
  /** Running as an installed app (display-mode standalone/fullscreen/minimal-ui, or iOS navigator.standalone). */
  readonly standalone: boolean;
  /** Whether a service worker currently controls the page. */
  readonly controlledBySW: boolean;
  readonly controllerScriptURL: string | null;
  readonly permissions: PwaPermissionsSnapshot;
  readonly capabilities: PwaCapabilities;
};
