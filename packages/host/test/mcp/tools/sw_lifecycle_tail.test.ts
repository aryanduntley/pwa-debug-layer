import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  swLifecycleTailHandler,
  swLifecycleTailTool,
} from '../../../src/mcp/tools/sw_lifecycle_tail.js';
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
      throw new Error('sw_lifecycle_tail must not perform IPC — it reads the host buffer');
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

describe('swLifecycleTailTool', () => {
  it('exposes the sw_lifecycle_tail name', () => {
    expect(swLifecycleTailTool.name).toBe('sw_lifecycle_tail');
  });

  it('errors when no NMH is connected', async () => {
    const r = await swLifecycleTailHandler({ filter: undefined }, buildCtx([]));
    expect(r.ok).toBe(false);
  });

  it('returns an empty result when connected but no events have arrived', async () => {
    const r = await swLifecycleTailHandler({ filter: undefined }, buildCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ entries: [], cursor: null, hasMore: false });
  });

  it('tails captured sw_state events with per-entry cursors', async () => {
    const ctx = buildCtx();
    ctx.capturesRegistry.getOrCreate('aaa').receive({
      events: [
        {
          kind: 'sw_state',
          ts: 1,
          frameUrl: 'https://app.example/',
          frameKey: 'top',
          subkind: 'updatefound',
          scope: 'https://app.example/',
        },
        {
          kind: 'sw_state',
          ts: 2,
          frameUrl: 'https://app.example/',
          frameKey: 'top',
          subkind: 'statechange',
          state: 'installed',
          slot: 'installing',
        },
        {
          kind: 'sw_state',
          ts: 3,
          frameUrl: 'https://app.example/',
          frameKey: 'top',
          subkind: 'controllerchange',
        },
      ],
    });

    const r = await swLifecycleTailHandler({ filter: undefined }, ctx);
    expect(r.ok).toBe(true);
    const data = r.data as {
      entries: ReadonlyArray<{ subkind: string; cursor: string }>;
      cursor: string | null;
      hasMore: boolean;
    };
    expect(data.entries).toHaveLength(3);
    expect(data.entries.map((e) => e.subkind)).toEqual([
      'updatefound',
      'statechange',
      'controllerchange',
    ]);
    expect(data.entries.every((e) => typeof e.cursor === 'string')).toBe(true);
    expect(data.cursor).not.toBeNull();
  });

  it('does not route sw_state into another buffer (isolation)', async () => {
    const ctx = buildCtx();
    const captures = ctx.capturesRegistry.getOrCreate('aaa');
    captures.receive({
      events: [
        {
          kind: 'sw_state',
          ts: 1,
          frameUrl: 'https://app.example/',
          frameKey: 'top',
          subkind: 'updatefound',
        },
      ],
    });
    expect(captures.tail('sw_state')).toHaveLength(1);
    expect(captures.tail('lifecycle')).toHaveLength(0);
    expect(captures.tail('console')).toHaveLength(0);
  });
});
