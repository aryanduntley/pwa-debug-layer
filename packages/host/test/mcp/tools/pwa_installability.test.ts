import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  pwaInstallabilityHandler,
  pwaInstallabilityTool,
} from '../../../src/mcp/tools/pwa_installability.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const result = {
  supported: true,
  manifestUrl: 'https://app.example/manifest.webmanifest',
  manifestFound: true,
  secureContext: true,
  hasServiceWorker: false,
  manifest: { name: 'X', shortName: null, startUrl: '/', scope: null, display: 'standalone', themeColor: null, backgroundColor: null, icons: [] },
  installable: false,
  gaps: [
    { code: 'no_service_worker', severity: 'error', message: 'No service worker.', fix: 'Register a SW.' },
    { code: 'no_192_icon', severity: 'error', message: 'No 192 icon.', fix: 'Add a 192x192 icon.' },
    { code: 'no_maskable_icon', severity: 'warning', message: 'No maskable icon.', fix: 'Add a maskable icon.' },
  ],
};

const buildCtx = (connections?: readonly IpcConnectionInfo[]): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () => Object.freeze({ payload: result }),
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

describe('pwaInstallabilityTool', () => {
  it('exposes the pwa_installability name', () => {
    expect(pwaInstallabilityTool.name).toBe('pwa_installability');
  });

  it('errors when no NMH is connected', async () => {
    expect((await pwaInstallabilityHandler({}, buildCtx([]))).ok).toBe(false);
  });

  it('returns the verdict and surfaces each gap fix in next_steps', async () => {
    const r = await pwaInstallabilityHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    expect((r.data as { installable: boolean }).installable).toBe(false);
    const steps = r.next_steps.join(' ');
    expect(steps).toMatch(/no_service_worker/);
    expect(steps).toMatch(/Add a 192x192 icon/);
    expect(steps).toMatch(/BLOCKERS \(2\)/);
    expect(steps).toMatch(/Recommended \(1\)/);
  });
});
