import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { z } from 'zod';
import { reactTreeHandler, reactTreeTool } from '../../../src/mcp/tools/react_tree.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import type {
  IpcRequestEnvelope,
  IpcResponseEnvelope,
} from '../../../src/mcp/ipc/envelope.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

type FakeOpts = {
  readonly connections?: readonly IpcConnectionInfo[];
  readonly responsePayload?: unknown;
  readonly responseError?: { readonly message: string };
  readonly throwOnRequest?: Error;
  readonly captureRequest?: { current: IpcRequestEnvelope | null };
};

const buildCtx = (opts: FakeOpts = {}): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (
      _extId: string,
      env: IpcRequestEnvelope,
    ): Promise<IpcResponseEnvelope> => {
      if (opts.captureRequest !== undefined) {
        opts.captureRequest.current = env;
      }
      if (opts.throwOnRequest !== undefined) throw opts.throwOnRequest;
      if (opts.responseError !== undefined) {
        return Object.freeze({
          type: 'response' as const,
          requestId: env.requestId,
          error: opts.responseError,
        });
      }
      return Object.freeze({
        type: 'response' as const,
        requestId: env.requestId,
        payload: opts.responsePayload ?? {
          roots: [],
          truncated: false,
          rootCount: 0,
        },
      });
    },
    listConnections: () =>
      opts.connections ?? [
        { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
      ],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore: mockSettingsStore(),
  });
};

const schema = z.object(reactTreeTool.inputSchema);

describe('reactTreeTool — input schema', () => {
  it('accepts an empty payload', () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('accepts all options', () => {
    const r = schema.safeParse({
      extension_id: 'aaa',
      tab_id: 5,
      root_index: 0,
      depth_limit: 4,
      max_nodes: 50,
    });
    expect(r.success).toBe(true);
  });

  it('rejects negative root_index', () => {
    expect(schema.safeParse({ root_index: -1 }).success).toBe(false);
  });

  it('rejects non-positive depth_limit', () => {
    expect(schema.safeParse({ depth_limit: 0 }).success).toBe(false);
  });

  it('rejects max_nodes above the cap', () => {
    expect(schema.safeParse({ max_nodes: 5001 }).success).toBe(false);
  });

  it('rejects non-integer depth_limit', () => {
    expect(schema.safeParse({ depth_limit: 1.5 }).success).toBe(false);
  });
});

describe('reactTreeHandler — happy path', () => {
  it('builds an IPC request with tool=react_tree and forwards options', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({
      captureRequest: capture,
      responsePayload: { roots: [], truncated: false, rootCount: 1 },
    });
    const r = await reactTreeHandler(
      { extension_id: 'aaa', tab_id: 7, root_index: 0, depth_limit: 6, max_nodes: 100 },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(capture.current?.tool).toBe('react_tree');
    expect(capture.current?.extensionId).toBe('aaa');
    expect(capture.current?.payload).toMatchObject({
      tab_id: 7,
      root_index: 0,
      depth_limit: 6,
      max_nodes: 100,
    });
  });

  it('omits IPC payload fields the caller did not provide', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reactTreeHandler({}, ctx);
    expect(capture.current?.payload).toEqual({});
  });

  it('returns extensionId/tabId/roots/truncated/rootCount on okResponse', async () => {
    const ctx = buildCtx({
      responsePayload: {
        roots: [
          {
            stableId: 'root0',
            displayName: 'HostRoot',
            hasState: false,
            hasHooks: false,
            children: [],
          },
        ],
        truncated: false,
        rootCount: 1,
      },
    });
    const r = await reactTreeHandler({ tab_id: 9 }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      extensionId: string;
      tabId: number | null;
      roots: ReadonlyArray<{ displayName: string }>;
      truncated: boolean;
      rootCount: number;
    };
    expect(d.tabId).toBe(9);
    expect(d.rootCount).toBe(1);
    expect(d.roots).toHaveLength(1);
    expect(d.roots[0]?.displayName).toBe('HostRoot');
  });

  it('next_steps mentions truncated:true when applicable', async () => {
    const ctx = buildCtx({
      responsePayload: { roots: [], truncated: true, rootCount: 1 },
    });
    const r = await reactTreeHandler({}, ctx);
    expect(r.next_steps.join(' ')).toMatch(/truncated/);
  });

  it('next_steps mentions rootCount===0 when no React roots', async () => {
    const ctx = buildCtx({
      responsePayload: { roots: [], truncated: false, rootCount: 0 },
    });
    const r = await reactTreeHandler({}, ctx);
    expect(r.next_steps.join(' ')).toMatch(/rootCount===0/);
  });

  it('next_steps flags out-of-range root_index', async () => {
    const ctx = buildCtx({
      responsePayload: { roots: [], truncated: false, rootCount: 1 },
    });
    const r = await reactTreeHandler({ root_index: 5 }, ctx);
    expect(r.next_steps.join(' ')).toMatch(/out of range/);
  });
});

describe('reactTreeHandler — error paths', () => {
  it('returns an error when no connections are present and no extension_id supplied', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await reactTreeHandler({}, ctx);
    expect(r.ok).toBe(false);
  });

  it('returns an error when ipcServer.request throws (transport failure)', async () => {
    const ctx = buildCtx({ throwOnRequest: new Error('timeout 5000ms') });
    const r = await reactTreeHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/react_tree failed/);
  });

  it('returns an error when NMH-mode responds with error envelope', async () => {
    const ctx = buildCtx({ responseError: { message: 'page world unreachable' } });
    const r = await reactTreeHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/react_tree nmh error/);
  });

  it('returns an error when payload is malformed', async () => {
    const ctx = buildCtx({ responsePayload: { unexpected: 'shape' } });
    const r = await reactTreeHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
