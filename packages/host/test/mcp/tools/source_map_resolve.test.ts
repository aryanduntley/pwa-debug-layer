import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { z } from 'zod';
import {
  sourceMapResolveHandler,
  sourceMapResolveTool,
} from '../../../src/mcp/tools/source_map_resolve.js';
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
import type { SettingsRecord } from '@pwa-debug/shared';

type FakeOpts = {
  readonly connections?: readonly IpcConnectionInfo[];
  readonly responsePayload?: unknown;
  readonly responseError?: { readonly message: string };
  readonly throwOnRequest?: Error;
  readonly captureRequest?: { current: IpcRequestEnvelope | null };
  readonly enabled?: boolean;
};

const buildCtx = (opts: FakeOpts = {}): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (
      _id: string,
      env: IpcRequestEnvelope,
    ): Promise<IpcResponseEnvelope> => {
      if (opts.captureRequest !== undefined) opts.captureRequest.current = env;
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
          original: {
            source: 'src/app.ts',
            line: 42,
            column: 8,
          },
          scopeUrl: 'https://example.test/',
        },
      });
    },
    listConnections: () =>
      opts.connections ?? [
        { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
      ],
  });
  const settingsStore = mockSettingsStore({
    'capture.sourceMap.enabled': opts.enabled ?? true,
  } as Partial<SettingsRecord>);
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore,
  });
};

const schema = z.object(sourceMapResolveTool.inputSchema);

describe('sourceMapResolveTool — input schema', () => {
  it('requires script_url + line + column', () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ script_url: 'a.js', line: 1 }).success,
    ).toBe(false);
  });

  it('rejects line < 1', () => {
    expect(
      schema.safeParse({ script_url: 'a.js', line: 0, column: 0 }).success,
    ).toBe(false);
  });

  it('rejects negative column', () => {
    expect(
      schema.safeParse({ script_url: 'a.js', line: 1, column: -1 }).success,
    ).toBe(false);
  });

  it('accepts a full payload', () => {
    expect(
      schema.safeParse({
        extension_id: 'aaa',
        tab_id: 5,
        script_url: 'https://x.com/b.js',
        line: 42,
        column: 8,
      }).success,
    ).toBe(true);
  });
});

describe('sourceMapResolveHandler — setting gate', () => {
  it('errors when capture.sourceMap.enabled=false', async () => {
    const ctx = buildCtx({ enabled: false });
    const r = await sourceMapResolveHandler(
      { script_url: 'a.js', line: 1, column: 0 },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disabled/);
  });

  it('does not open an IPC request when disabled', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ enabled: false, captureRequest: capture });
    await sourceMapResolveHandler(
      { script_url: 'a.js', line: 1, column: 0 },
      ctx,
    );
    expect(capture.current).toBeNull();
  });
});

describe('sourceMapResolveHandler — happy path (gate open)', () => {
  it('forwards script_url + line + column to the IPC envelope', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ enabled: true, captureRequest: capture });
    await sourceMapResolveHandler(
      {
        script_url: 'https://x.com/bundle.js',
        line: 18432,
        column: 5,
        tab_id: 7,
      },
      ctx,
    );
    expect(capture.current?.tool).toBe('source_map_resolve');
    expect(capture.current?.payload).toMatchObject({
      script_url: 'https://x.com/bundle.js',
      line: 18432,
      column: 5,
      tab_id: 7,
    });
  });

  it('returns ok with resolved frame on success', async () => {
    const ctx = buildCtx({
      enabled: true,
      responsePayload: {
        original: { source: 'src/app.ts', line: 42, column: 8 },
        scopeUrl: 'https://example.test/',
      },
    });
    const r = await sourceMapResolveHandler(
      { script_url: 'https://example.test/bundle.js', line: 1, column: 0 },
      ctx,
    );
    expect(r.ok).toBe(true);
    const d = r.data as { original: { source: string; line: number } };
    expect(d.original).toEqual({ source: 'src/app.ts', line: 42, column: 8 });
    expect(r.next_steps.join(' ')).toMatch(/src\/app.ts:42:8/);
  });

  it('returns ok with no original when no mapping exists', async () => {
    const ctx = buildCtx({
      enabled: true,
      responsePayload: { scopeUrl: 'https://example.test/' },
    });
    const r = await sourceMapResolveHandler(
      { script_url: 'https://example.test/bundle.js', line: 1, column: 0 },
      ctx,
    );
    expect(r.ok).toBe(true);
    const d = r.data as { original?: unknown };
    expect(d.original).toBeUndefined();
    expect(r.next_steps.join(' ')).toMatch(/No mapping/);
  });
});

describe('sourceMapResolveHandler — error paths (gate open)', () => {
  it('returns error when no connections', async () => {
    const ctx = buildCtx({ enabled: true, connections: [] });
    const r = await sourceMapResolveHandler(
      { script_url: 'a.js', line: 1, column: 0 },
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('returns error when ipcServer.request throws', async () => {
    const ctx = buildCtx({
      enabled: true,
      throwOnRequest: new Error('timeout'),
    });
    const r = await sourceMapResolveHandler(
      { script_url: 'a.js', line: 1, column: 0 },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source_map_resolve failed/);
  });

  it('returns error on NMH transport error envelope', async () => {
    const ctx = buildCtx({
      enabled: true,
      responseError: { message: 'no active tab' },
    });
    const r = await sourceMapResolveHandler(
      { script_url: 'a.js', line: 1, column: 0 },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nmh error/);
  });

  it('maps tool-level error payload', async () => {
    const ctx = buildCtx({
      enabled: true,
      responsePayload: {
        error: { message: 'source_map_resolve: script fetch returned 404' },
      },
    });
    const r = await sourceMapResolveHandler(
      { script_url: 'a.js', line: 1, column: 0 },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/script fetch returned 404/);
  });

  it('returns error on malformed payload', async () => {
    const ctx = buildCtx({
      enabled: true,
      responsePayload: { random: 'noise' },
    });
    const r = await sourceMapResolveHandler(
      { script_url: 'a.js', line: 1, column: 0 },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
