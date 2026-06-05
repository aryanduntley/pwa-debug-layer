import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { idbListHandler, idbListTool } from '../../../src/mcp/tools/idb_list.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const listPayload = () => ({
  supported: true,
  databases: [
    {
      name: 'app',
      version: 2,
      stores: [{ name: 'items', keyPath: 'id', autoIncrement: false, indexes: [] }],
    },
  ],
});

const buildCtx = (
  connections?: readonly IpcConnectionInfo[],
  payload?: unknown,
): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () => Object.freeze({ payload: payload ?? listPayload() }),
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

describe('idb_list tool', () => {
  it('exposes its name', () => {
    expect(idbListTool.name).toBe('idb_list');
  });

  it('errors when no NMH is connected', async () => {
    expect((await idbListHandler({}, buildCtx([]))).ok).toBe(false);
  });

  it('returns the database listing', async () => {
    const r = await idbListHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    const data = r.data as { databases: { name: string; stores: unknown[] }[] };
    expect(data.databases).toHaveLength(1);
    expect(data.databases[0]!.name).toBe('app');
    expect(data.databases[0]!.stores).toHaveLength(1);
  });

  it('rejects a malformed payload shape', async () => {
    const r = await idbListHandler({}, buildCtx(undefined, { supported: true }));
    expect(r.ok).toBe(false);
  });
});
