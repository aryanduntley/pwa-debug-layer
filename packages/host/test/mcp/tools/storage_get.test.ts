import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  storageGetHandler,
  storageGetTool,
} from '../../../src/mcp/tools/storage_get.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const storagePayload = (area: 'local' | 'session') => ({
  supported: true,
  area,
  entries: [{ key: 'token', value: 'abc' }],
  entryCount: 1,
  truncated: false,
});

const buildCtx = (
  connections?: readonly IpcConnectionInfo[],
  payload?: unknown,
): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (_id: string, env: { tool: string; payload?: unknown }) => {
      const area =
        (env.payload as { area?: string } | undefined)?.area === 'session'
          ? 'session'
          : 'local';
      return Object.freeze({ payload: payload ?? storagePayload(area) });
    },
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

describe('storage_get tool', () => {
  it('exposes its name', () => {
    expect(storageGetTool.name).toBe('storage_get');
  });

  it('errors when no NMH is connected', async () => {
    expect((await storageGetHandler({}, buildCtx([]))).ok).toBe(false);
  });

  it('returns the web-storage snapshot', async () => {
    const r = await storageGetHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    const data = r.data as { area: string; entries: unknown[]; entryCount: number };
    expect(data.area).toBe('local');
    expect(data.entries).toHaveLength(1);
    expect(data.entryCount).toBe(1);
  });

  it('forwards the requested area through to the page-world', async () => {
    const r = await storageGetHandler({ area: 'session' }, buildCtx());
    expect((r.data as { area: string }).area).toBe('session');
  });

  it('rejects a malformed payload shape', async () => {
    const r = await storageGetHandler({}, buildCtx(undefined, { supported: true }));
    expect(r.ok).toBe(false);
  });
});
