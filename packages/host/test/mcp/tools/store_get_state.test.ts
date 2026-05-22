import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  storeGetStateHandler,
  storeGetStateTool,
} from '../../../src/mcp/tools/store_get_state.js';
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
          framework: 'redux',
          state: { counter: { value: 0 } },
          scopeUrl: 'https://example.test/',
        },
      });
    },
    listConnections: () =>
      opts.connections ?? [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore: mockSettingsStore(),
  });
};

const schema = z.object(storeGetStateTool.inputSchema);

describe('storeGetStateTool — input schema', () => {
  it('accepts empty args and a full payload incl. framework', () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(
      schema.safeParse({
        extension_id: 'aaa',
        tab_id: 5,
        path: 'counter.value',
        framework: 'redux',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty framework string', () => {
    expect(schema.safeParse({ framework: '' }).success).toBe(false);
  });
});

describe('storeGetStateHandler — wire payload', () => {
  it('forwards tool=store_get_state with path + framework', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await storeGetStateHandler(
      { tab_id: 7, path: 'counter.value', framework: 'redux' },
      ctx,
    );
    expect(capture.current?.tool).toBe('store_get_state');
    expect(capture.current?.payload).toMatchObject({
      tab_id: 7,
      path: 'counter.value',
      framework: 'redux',
    });
  });

  it('omits framework from the wire payload when not supplied', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await storeGetStateHandler({}, ctx);
    expect(capture.current?.payload).not.toHaveProperty('framework');
  });
});

describe('storeGetStateHandler — success + errors', () => {
  it('surfaces framework + state from the page payload', async () => {
    const ctx = buildCtx({
      responsePayload: {
        framework: 'redux',
        state: { counter: { value: 42 } },
        scopeUrl: 'https://example.test/path',
      },
    });
    const r = await storeGetStateHandler({ tab_id: 9 }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { framework: string; state: unknown; tabId: number };
    expect(d.framework).toBe('redux');
    expect(d.state).toEqual({ counter: { value: 42 } });
    expect(d.tabId).toBe(9);
  });

  it('next_steps mentions truncated when set', async () => {
    const ctx = buildCtx({
      responsePayload: {
        framework: 'redux',
        state: { __type: 'Truncated' },
        truncated: true,
        scopeUrl: 'https://example.test/',
      },
    });
    const r = await storeGetStateHandler({}, ctx);
    expect(r.next_steps.join(' ')).toMatch(/truncated/);
  });

  it('errors when no connections and no extension_id', async () => {
    const r = await storeGetStateHandler({}, buildCtx({ connections: [] }));
    expect(r.ok).toBe(false);
  });

  it('maps a transport throw to a store_get_state failure', async () => {
    const ctx = buildCtx({ throwOnRequest: new Error('timeout 5000ms') });
    const r = await storeGetStateHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/store_get_state failed/);
  });

  it('maps an NMH transport-error envelope', async () => {
    const ctx = buildCtx({ responseError: { message: 'no active tab' } });
    const r = await storeGetStateHandler({}, ctx);
    expect(r.error).toMatch(/store_get_state nmh error/);
  });

  it('maps a page-world tool-level error', async () => {
    const ctx = buildCtx({
      responsePayload: { error: { message: 'no store detected' } },
    });
    const r = await storeGetStateHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/store_get_state: no store detected/);
  });

  it('flags a malformed (non-store, non-error) payload', async () => {
    const ctx = buildCtx({ responsePayload: { random: 'noise' } });
    const r = await storeGetStateHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
