/**
 * Pure PWA feature-detection: capability matrix, display mode, and permission
 * normalization. All deterministic over the supplied window/navigator-like
 * objects (no globals, no I/O) so they unit-test with plain fakes. The async
 * edge (SW controller + Permissions API) lives in read.ts.
 */

import type {
  PwaCapabilities,
  PwaPermissionState,
} from '@pwa-debug/shared';

/** `key in obj` guarded against null/non-objects. */
const has = (obj: unknown, key: string): boolean =>
  obj !== null && typeof obj === 'object' && key in obj;

export const detectPwaCapabilities = (
  win: object,
  nav: object,
): PwaCapabilities => ({
  serviceWorker: has(nav, 'serviceWorker'),
  pushManager: has(win, 'PushManager'),
  backgroundSync: has(win, 'SyncManager'),
  periodicBackgroundSync: has(win, 'PeriodicSyncManager'),
  badging: has(nav, 'setAppBadge'),
  fileSystemAccess: has(win, 'showOpenFilePicker'),
  windowControlsOverlay: has(nav, 'windowControlsOverlay'),
  webShare: has(nav, 'share'),
  notifications: has(win, 'Notification'),
});

const INSTALLED_MODES = ['standalone', 'fullscreen', 'minimal-ui'] as const;

export const resolveDisplayMode = (
  matchMedia: ((q: string) => { readonly matches: boolean }) | undefined,
): PwaStatusDisplayMode => {
  if (typeof matchMedia !== 'function') return 'unknown';
  for (const mode of INSTALLED_MODES) {
    if (matchMedia(`(display-mode: ${mode})`).matches) return mode;
  }
  return 'browser';
};

type PwaStatusDisplayMode =
  | 'standalone'
  | 'fullscreen'
  | 'minimal-ui'
  | 'browser'
  | 'unknown';

export const mapPermissionState = (
  raw: string | null | undefined,
): PwaPermissionState => {
  switch (raw) {
    case 'granted':
    case 'denied':
    case 'prompt':
      return raw;
    case 'default':
      return 'prompt';
    default:
      return 'unknown';
  }
};
