import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { pwaStatusHandler, pwaStatusTool } from '../../../src/mcp/tools/pwa_status.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const snapshot = {
  displayMode: 'standalone',
  standalone: true,
  controlledBySW: true,
  controllerScriptURL: 'https://app.example/sw.js',
  permissions: { notifications: 'granted', push: 'prompt', periodicBackgroundSync: 'unsupported' },
  capabilities: {
    serviceWorker: true,
    pushManager: true,
    backgroundSync: true,
    periodicBackgroundSync: false,
    badging: false,
    fileSystemAccess: false,
    windowControlsOverlay: false,
    webShare: true,
    notifications: true,
  },
};

const buildCtx = (connections?: readonly IpcConnectionInfo[]): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () => Object.freeze({ payload: snapshot }),
    listConnections: () =>
      connections ?? [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore: mockSettingsStore(),
  });
};

describe('pwaStatusTool', () => {
  it('exposes the pwa_status name', () => {
    expect(pwaStatusTool.name).toBe('pwa_status');
  });

  it('errors when no NMH is connected', async () => {
    expect((await pwaStatusHandler({}, buildCtx([]))).ok).toBe(false);
  });

  it('returns the runtime status + capability matrix', async () => {
    const r = await pwaStatusHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    const data = r.data as {
      standalone: boolean;
      capabilities: { pushManager: boolean };
      permissions: { notifications: string };
    };
    expect(data.standalone).toBe(true);
    expect(data.capabilities.pushManager).toBe(true);
    expect(data.permissions.notifications).toBe('granted');
  });
});
