import { describe, it, expect } from 'vitest';
import {
  detectPwaCapabilities,
  resolveDisplayMode,
  mapPermissionState,
} from '../../src/pwa_status/project.js';
import { readPwaStatus, type WinLike, type NavLike } from '../../src/pwa_status/read.js';

describe('detectPwaCapabilities', () => {
  it('detects present APIs on window/navigator', () => {
    const win = { PushManager: 1, SyncManager: 1, PeriodicSyncManager: 1, showOpenFilePicker: 1, Notification: 1 };
    const nav = { serviceWorker: {}, setAppBadge: () => {}, windowControlsOverlay: {}, share: () => {} };
    expect(detectPwaCapabilities(win, nav)).toEqual({
      serviceWorker: true,
      pushManager: true,
      backgroundSync: true,
      periodicBackgroundSync: true,
      badging: true,
      fileSystemAccess: true,
      windowControlsOverlay: true,
      webShare: true,
      notifications: true,
    });
  });

  it('is all-false on empty objects', () => {
    const caps = detectPwaCapabilities({}, {});
    expect(Object.values(caps).every((v) => v === false)).toBe(true);
  });
});

describe('resolveDisplayMode', () => {
  it('returns the first matching installed mode', () => {
    expect(resolveDisplayMode((q) => ({ matches: q.includes('standalone') }))).toBe('standalone');
    expect(resolveDisplayMode((q) => ({ matches: q.includes('minimal-ui') }))).toBe('minimal-ui');
  });
  it('returns browser when nothing matches', () => {
    expect(resolveDisplayMode(() => ({ matches: false }))).toBe('browser');
  });
  it('returns unknown when matchMedia is unavailable', () => {
    expect(resolveDisplayMode(undefined)).toBe('unknown');
  });
});

describe('mapPermissionState', () => {
  it('passes through known states and maps default->prompt', () => {
    expect(mapPermissionState('granted')).toBe('granted');
    expect(mapPermissionState('denied')).toBe('denied');
    expect(mapPermissionState('prompt')).toBe('prompt');
    expect(mapPermissionState('default')).toBe('prompt');
    expect(mapPermissionState(null)).toBe('unknown');
    expect(mapPermissionState('weird')).toBe('unknown');
  });
});

describe('readPwaStatus', () => {
  it('assembles a standalone, controlled snapshot with permissions', async () => {
    const win = {
      matchMedia: (q: string) => ({ matches: q.includes('standalone') }),
      PushManager: 1,
      Notification: 1,
    };
    const nav = {
      serviceWorker: { controller: { scriptURL: 'https://app.example/sw.js' } },
      permissions: {
        query: async (d: { name: string }) => ({
          state: d.name === 'notifications' ? 'granted' : 'prompt',
        }),
      },
    };
    const snap = await readPwaStatus(win as WinLike, nav as NavLike);
    expect(snap.displayMode).toBe('standalone');
    expect(snap.standalone).toBe(true);
    expect(snap.controlledBySW).toBe(true);
    expect(snap.controllerScriptURL).toBe('https://app.example/sw.js');
    expect(snap.permissions.notifications).toBe('granted');
    expect(snap.permissions.push).toBe('prompt');
    expect(snap.capabilities.pushManager).toBe(true);
  });

  it('reports browser/uncontrolled + unknown permissions without a Permissions API', async () => {
    const win = { matchMedia: () => ({ matches: false }) };
    const nav = { standalone: false };
    const snap = await readPwaStatus(win as WinLike, nav as NavLike);
    expect(snap.standalone).toBe(false);
    expect(snap.controlledBySW).toBe(false);
    expect(snap.controllerScriptURL).toBeNull();
    expect(snap.permissions.push).toBe('unknown');
  });

  it('marks a permission unsupported when its query rejects', async () => {
    const nav = {
      permissions: {
        query: async (d: { name: string }) => {
          if (d.name === 'periodic-background-sync') throw new Error('not queryable');
          return { state: 'granted' };
        },
      },
    };
    const snap = await readPwaStatus({ matchMedia: () => ({ matches: false }) } as WinLike, nav as NavLike);
    expect(snap.permissions.periodicBackgroundSync).toBe('unsupported');
    expect(snap.permissions.notifications).toBe('granted');
  });

  it('treats iOS navigator.standalone as installed', async () => {
    const snap = await readPwaStatus(
      { matchMedia: () => ({ matches: false }) } as WinLike,
      { standalone: true } as NavLike,
    );
    expect(snap.standalone).toBe(true);
  });
});
