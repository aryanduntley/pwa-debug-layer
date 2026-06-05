import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { pwaSnapshotHandler, pwaSnapshotTool } from '../../../src/mcp/tools/pwa_snapshot.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const snapshotPayload = (store: unknown = { framework: 'redux', state: { n: 1 } }) => ({
  url: 'https://app/',
  title: 'App',
  capturedAt: 1234,
  sw: { supported: true, controller: null, registrations: [], hasWaitingUpdate: false },
  store,
  webStorage: {
    local: { supported: true, area: 'local', entries: [], entryCount: 0, truncated: false },
    session: { supported: true, area: 'session', entries: [], entryCount: 0, truncated: false },
  },
  idb: { supported: true, databases: [] },
  cacheNames: { supported: true, caches: [] },
});

const buildCtx = (
  connections?: readonly IpcConnectionInfo[],
  payload?: unknown,
): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () => Object.freeze({ payload: payload ?? snapshotPayload() }),
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

describe('pwa_snapshot tool', () => {
  it('exposes its name', () => {
    expect(pwaSnapshotTool.name).toBe('pwa_snapshot');
  });

  it('errors when no NMH is connected', async () => {
    expect((await pwaSnapshotHandler({}, buildCtx([]))).ok).toBe(false);
  });

  it('returns the composed runtime snapshot', async () => {
    const r = await pwaSnapshotHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    const data = r.data as {
      url: string;
      store: { framework: string } | null;
      webStorage: { local: unknown; session: unknown };
    };
    expect(data.url).toBe('https://app/');
    expect(data.store!.framework).toBe('redux');
    expect(data.webStorage.local).toBeDefined();
    expect(data.webStorage.session).toBeDefined();
  });

  it('accepts a null store (no store detected)', async () => {
    const r = await pwaSnapshotHandler({}, buildCtx(undefined, snapshotPayload(null)));
    expect(r.ok).toBe(true);
    expect((r.data as { store: unknown }).store).toBeNull();
  });

  it('rejects a malformed payload shape', async () => {
    const r = await pwaSnapshotHandler({}, buildCtx(undefined, { url: 'x' }));
    expect(r.ok).toBe(false);
  });
});
