import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  pwaUpdateAnalyzeHandler,
  pwaUpdateAnalyzeTool,
} from '../../../src/mcp/tools/pwa_update_analyze.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import {
  createCapturesRegistry,
  type CapturesRegistry,
} from '../../../src/captures_in/captures_in.js';

const gatherPayload = () => ({
  sw: {
    supported: true,
    controller: { scriptURL: '/sw.js', state: 'activated' },
    registrations: [],
    hasWaitingUpdate: true,
  },
  cacheEntries: [],
});

const buildCtx = (
  opts: {
    connections?: readonly IpcConnectionInfo[];
    payload?: unknown;
    registry?: CapturesRegistry;
  } = {},
): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () => Object.freeze({ payload: opts.payload ?? gatherPayload() }),
    listConnections: () =>
      opts.connections ?? [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: opts.registry ?? createCapturesRegistry(),
    settingsStore: mockSettingsStore(),
  });
};

describe('pwa_update_analyze tool', () => {
  it('exposes its name', () => {
    expect(pwaUpdateAnalyzeTool.name).toBe('pwa_update_analyze');
  });

  it('errors when no NMH is connected', async () => {
    expect((await pwaUpdateAnalyzeHandler({}, buildCtx({ connections: [] }))).ok).toBe(false);
  });

  it('flags a waiting update from the gathered SW snapshot', async () => {
    const r = await pwaUpdateAnalyzeHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    const data = r.data as { findings: { code: string }[]; hasWaitingUpdate: boolean };
    expect(data.hasWaitingUpdate).toBe(true);
    expect(data.findings.map((f) => f.code)).toContain('waiting_update_active_client');
  });

  it('correlates a JS-chunk 404 from the network ring buffer', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [
        { ts: 1, kind: 'fetch', phase: 'response', url: 'https://x/chunk.abc.js', status: 404 },
      ],
    });
    const r = await pwaUpdateAnalyzeHandler({}, buildCtx({ registry }));
    const data = r.data as { findings: { code: string }[]; chunk404s: { url: string }[] };
    expect(data.chunk404s).toHaveLength(1);
    expect(data.chunk404s[0]!.url).toBe('https://x/chunk.abc.js');
    expect(data.findings.map((f) => f.code)).toContain('chunk_404');
  });

  it('rejects a malformed gather payload shape', async () => {
    const r = await pwaUpdateAnalyzeHandler({}, buildCtx({ payload: { sw: { supported: 'no' } } }));
    expect(r.ok).toBe(false);
  });
});
