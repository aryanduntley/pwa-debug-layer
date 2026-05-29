import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { errorTailHandler, errorTailTool } from '../../../src/mcp/tools/error_tail.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const buildCtx = (connections?: readonly IpcConnectionInfo[]): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () => {
      throw new Error('error_tail must not perform IPC — it reads the host buffer');
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

describe('errorTailTool', () => {
  it('exposes the error_tail name', () => {
    expect(errorTailTool.name).toBe('error_tail');
  });

  it('errors when no NMH is connected', async () => {
    const r = await errorTailHandler({ filter: undefined }, buildCtx([]));
    expect(r.ok).toBe(false);
  });

  it('returns empty when connected but no events have arrived', async () => {
    const r = await errorTailHandler({ filter: undefined }, buildCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ entries: [], cursor: null, hasMore: false });
  });

  it('returns seeded page_error events with cursors', async () => {
    const ctx = buildCtx();
    ctx.capturesRegistry.getOrCreate('aaa').receive({
      events: [
        {
          kind: 'page_error',
          ts: 1,
          frameUrl: 'https://x/',
          frameKey: 'top',
          subkind: 'unhandledrejection',
          message: 'User rejected the request',
          name: 'UserRejectedRequestError',
        },
        {
          kind: 'page_error',
          ts: 2,
          frameUrl: 'https://x/',
          frameKey: 'top',
          subkind: 'error',
          message: 'boom',
        },
      ],
    });
    const r = await errorTailHandler({ filter: undefined }, ctx);
    expect(r.ok).toBe(true);
    const entries = (r.data as { entries: Array<{ message: string; subkind: string; cursor: string }> }).entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.message)).toEqual([
      'User rejected the request',
      'boom',
    ]);
    expect(typeof entries[0]!.cursor).toBe('string');
  });
});
