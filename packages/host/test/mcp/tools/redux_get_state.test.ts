import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { z } from 'zod';
import {
  reduxGetStateHandler,
  reduxGetStateTool,
} from '../../../src/mcp/tools/redux_get_state.js';
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
          state: { counter: { value: 0 } },
          scopeUrl: 'https://example.test/',
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

const schema = z.object(reduxGetStateTool.inputSchema);

describe('reduxGetStateTool — input schema', () => {
  it('accepts empty args (everything optional)', () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('accepts a full payload', () => {
    expect(
      schema.safeParse({
        extension_id: 'aaa',
        tab_id: 5,
        path: 'counter.value',
      }).success,
    ).toBe(true);
  });

  it('rejects empty path string', () => {
    expect(schema.safeParse({ path: '' }).success).toBe(false);
  });

  it('rejects non-integer tab_id', () => {
    expect(schema.safeParse({ tab_id: 1.5 }).success).toBe(false);
  });
});

describe('reduxGetStateHandler — happy path', () => {
  it('builds IPC envelope with tool=redux_get_state and forwards path+tab_id', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reduxGetStateHandler(
      { extension_id: 'aaa', tab_id: 7, path: 'counter.value' },
      ctx,
    );
    expect(capture.current?.tool).toBe('redux_get_state');
    expect(capture.current?.payload).toMatchObject({
      tab_id: 7,
      path: 'counter.value',
    });
  });

  it('omits path from wire payload when not provided', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reduxGetStateHandler({}, ctx);
    expect(capture.current?.payload).toEqual({});
  });

  it('returns ok with state + scopeUrl on success', async () => {
    const ctx = buildCtx({
      responsePayload: {
        state: { counter: { value: 42 } },
        scopeUrl: 'https://example.test/path',
      },
    });
    const r = await reduxGetStateHandler({ tab_id: 9 }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      tabId: number;
      state: unknown;
      scopeUrl: string;
    };
    expect(d.tabId).toBe(9);
    expect(d.state).toEqual({ counter: { value: 42 } });
    expect(d.scopeUrl).toBe('https://example.test/path');
  });

  it('preserves the path echo from the page-world payload', async () => {
    const ctx = buildCtx({
      responsePayload: {
        state: 42,
        path: 'counter.value',
        scopeUrl: 'https://example.test/',
      },
    });
    const r = await reduxGetStateHandler({ path: 'counter.value' }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { state: unknown; path: string };
    expect(d.state).toBe(42);
    expect(d.path).toBe('counter.value');
  });

  it('next_steps mentions truncated when set', async () => {
    const ctx = buildCtx({
      responsePayload: {
        state: { __type: 'Truncated' },
        truncated: true,
        scopeUrl: 'https://example.test/',
      },
    });
    const r = await reduxGetStateHandler({}, ctx);
    expect(r.next_steps.join(' ')).toMatch(/truncated/);
  });
});

describe('reduxGetStateHandler — error paths', () => {
  it('returns error when no connections and no extension_id', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await reduxGetStateHandler({}, ctx);
    expect(r.ok).toBe(false);
  });

  it('returns error when ipcServer.request throws', async () => {
    const ctx = buildCtx({ throwOnRequest: new Error('timeout 5000ms') });
    const r = await reduxGetStateHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redux_get_state failed/);
  });

  it('returns error when NMH responds with transport error envelope', async () => {
    const ctx = buildCtx({ responseError: { message: 'no active tab' } });
    const r = await reduxGetStateHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redux_get_state nmh error/);
  });

  it('maps a payload-level error (no store detected) to errorResponse', async () => {
    const ctx = buildCtx({
      responsePayload: {
        error: { message: 'redux_get_state: no Redux store detected.' },
      },
    });
    const r = await reduxGetStateHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no Redux store detected/);
    expect(r.next_steps.join(' ')).toMatch(/__pwaDebug_redux/);
  });

  it('returns error when payload is neither store-info nor tool-error shape', async () => {
    const ctx = buildCtx({ responsePayload: { random: 'noise' } });
    const r = await reduxGetStateHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
