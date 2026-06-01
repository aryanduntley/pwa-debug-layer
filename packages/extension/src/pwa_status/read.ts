/**
 * Async edge that assembles the full PwaStatusSnapshot from injected
 * window/navigator: composes the pure detectors with the SW controller read and
 * a Permissions-API snapshot. Injected objects keep it unit-testable; the
 * page-world handler passes the real window + navigator.
 */

import type {
  PwaStatusSnapshot,
  PwaPermissionState,
  PwaPermissionsSnapshot,
} from '@pwa-debug/shared';
import {
  detectPwaCapabilities,
  resolveDisplayMode,
  mapPermissionState,
} from './project.js';

type PermissionQuery = (descriptor: {
  readonly name: string;
}) => Promise<{ readonly state: string }>;

export type WinLike = {
  readonly matchMedia?: (q: string) => { readonly matches: boolean };
};

export type NavLike = {
  readonly serviceWorker?: {
    readonly controller?: { readonly scriptURL?: string } | null;
  };
  readonly standalone?: boolean;
  readonly permissions?: { readonly query?: PermissionQuery };
};

const queryPermission = async (
  nav: NavLike,
  name: string,
  extra?: Record<string, unknown>,
): Promise<PwaPermissionState> => {
  const query = nav.permissions?.query;
  if (typeof query !== 'function') return 'unknown';
  try {
    const status = await query({ name, ...(extra ?? {}) });
    return mapPermissionState(status.state);
  } catch {
    // Unknown permission name (e.g. 'push' / 'periodic-background-sync' on
    // browsers that don't support querying it) rejects — report unsupported.
    return 'unsupported';
  }
};

export const readPwaStatus = async (
  win: WinLike,
  nav: NavLike,
): Promise<PwaStatusSnapshot> => {
  const displayMode = resolveDisplayMode(win.matchMedia);
  const installedByDisplay =
    displayMode === 'standalone' ||
    displayMode === 'fullscreen' ||
    displayMode === 'minimal-ui';
  const standalone = installedByDisplay || nav.standalone === true;

  const controller = nav.serviceWorker?.controller ?? null;

  const [notifications, push, periodicBackgroundSync] = await Promise.all([
    queryPermission(nav, 'notifications'),
    queryPermission(nav, 'push', { userVisibleOnly: true }),
    queryPermission(nav, 'periodic-background-sync'),
  ]);
  const permissions: PwaPermissionsSnapshot = {
    notifications,
    push,
    periodicBackgroundSync,
  };

  return {
    displayMode,
    standalone,
    controlledBySW: controller !== null,
    controllerScriptURL: controller?.scriptURL ?? null,
    permissions,
    capabilities: detectPwaCapabilities(win, nav),
  };
};
