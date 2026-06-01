import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { cacheListHandler, cacheListTool } from '../../../src/mcp/tools/cache_list.js';
import {
  cacheInspectHandler,
  cacheInspectTool,
} from '../../../src/mcp/tools/cache_inspect.js';
import {
  cacheMatchHandler,
  cacheMatchTool,
} from '../../../src/mcp/tools/cache_match.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const payloadFor = (tool: string): unknown => {
  switch (tool) {
    case 'cache_list':
      return { supported: true, caches: [{ name: 'static-v1', entryCount: 2 }] };
    case 'cache_inspect':
      return {
        supported: true,
        found: true,
        name: 'static-v1',
        entries: [
          {
            url: 'https://app.example/a.js',
            method: 'GET',
            status: 200,
            contentType: 'application/javascript',
            contentLength: 10,
            dateHeader: null,
            ageSeconds: null,
            cacheControl: null,
          },
        ],
        entryCount: 1,
        truncated: false,
      };
    case 'cache_match':
      return {
        supported: true,
        url: 'https://app.example/a.js',
        matched: true,
        cacheName: 'static-v1',
        entry: null,
      };
    default:
      return null;
  }
};

const buildCtx = (connections?: readonly IpcConnectionInfo[]): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (_id: string, env: { tool: string }) =>
      Object.freeze({ payload: payloadFor(env.tool) }),
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

describe('cache tools', () => {
  it('expose their names', () => {
    expect(cacheListTool.name).toBe('cache_list');
    expect(cacheInspectTool.name).toBe('cache_inspect');
    expect(cacheMatchTool.name).toBe('cache_match');
  });

  it('error when no NMH is connected', async () => {
    expect((await cacheListHandler({}, buildCtx([]))).ok).toBe(false);
    expect(
      (await cacheInspectHandler({ cache_name: 'static-v1' }, buildCtx([]))).ok,
    ).toBe(false);
    expect(
      (await cacheMatchHandler({ url: 'https://app.example/a.js' }, buildCtx([]))).ok,
    ).toBe(false);
  });

  it('cache_list returns the caches', async () => {
    const r = await cacheListHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    expect((r.data as { caches: unknown[] }).caches).toEqual([
      { name: 'static-v1', entryCount: 2 },
    ]);
  });

  it('cache_inspect returns entries for the named cache', async () => {
    const r = await cacheInspectHandler({ cache_name: 'static-v1' }, buildCtx());
    expect(r.ok).toBe(true);
    const data = r.data as { found: boolean; entries: unknown[] };
    expect(data.found).toBe(true);
    expect(data.entries).toHaveLength(1);
  });

  it('cache_match reports the serving cache', async () => {
    const r = await cacheMatchHandler(
      { url: 'https://app.example/a.js' },
      buildCtx(),
    );
    expect(r.ok).toBe(true);
    expect((r.data as { matched: boolean; cacheName: string }).matched).toBe(true);
    expect((r.data as { cacheName: string }).cacheName).toBe('static-v1');
  });
});
