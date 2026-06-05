import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { idbQueryHandler, idbQueryTool } from '../../../src/mcp/tools/idb_query.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const queryPayload = (db: string, store: string) => ({
  supported: true,
  found: true,
  db,
  store,
  records: [{ key: 1, value: { name: 'a' } }],
  returned: 1,
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
      const p = env.payload as { db?: string; store?: string } | undefined;
      return Object.freeze({
        payload: payload ?? queryPayload(p?.db ?? 'app', p?.store ?? 'items'),
      });
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

describe('idb_query tool', () => {
  it('exposes its name', () => {
    expect(idbQueryTool.name).toBe('idb_query');
  });

  it('errors when no NMH is connected', async () => {
    expect(
      (await idbQueryHandler({ db: 'app', store: 'items' }, buildCtx([]))).ok,
    ).toBe(false);
  });

  it('returns the record slice', async () => {
    const r = await idbQueryHandler({ db: 'app', store: 'items' }, buildCtx());
    expect(r.ok).toBe(true);
    const data = r.data as { db: string; store: string; records: unknown[]; returned: number };
    expect(data.db).toBe('app');
    expect(data.store).toBe('items');
    expect(data.records).toHaveLength(1);
    expect(data.returned).toBe(1);
  });

  it('forwards db + store through to the page-world', async () => {
    const r = await idbQueryHandler({ db: 'other', store: 'logs' }, buildCtx());
    const data = r.data as { db: string; store: string };
    expect(data.db).toBe('other');
    expect(data.store).toBe('logs');
  });

  it('rejects a malformed payload shape', async () => {
    const r = await idbQueryHandler(
      { db: 'app', store: 'items' },
      buildCtx(undefined, { supported: true }),
    );
    expect(r.ok).toBe(false);
  });
});
