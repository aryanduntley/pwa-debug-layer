import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  storeDispatchHandler,
} from '../../../src/mcp/tools/store_dispatch.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import type {
  IpcRequestEnvelope,
  IpcResponseEnvelope,
} from '../../../src/mcp/ipc/envelope.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

type FakeOpts = {
  readonly allowDispatch?: boolean;
  readonly responsePayload?: unknown;
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
      return Object.freeze({
        type: 'response' as const,
        requestId: env.requestId,
        payload: opts.responsePayload ?? {
          dispatched: true,
          framework: 'redux',
          action: { type: 'inc' },
          scopeUrl: 'https://example.test/',
        },
      });
    },
    listConnections: () => [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore: mockSettingsStore({
      'capture.stores.allowDispatch': opts.allowDispatch ?? true,
    }),
  });
};

describe('storeDispatchHandler — allowDispatch gate', () => {
  it('blocks when capture.stores.allowDispatch=false and builds no envelope', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ allowDispatch: false, captureRequest: capture });
    const r = await storeDispatchHandler({ action: { type: 'inc' } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.next_steps.join(' ')).toMatch(/allowDispatch/);
    expect(capture.current).toBeNull();
  });
});

describe('storeDispatchHandler — happy path', () => {
  it('forwards tool=store_dispatch with action + framework', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ allowDispatch: true, captureRequest: capture });
    await storeDispatchHandler(
      { action: { type: 'inc', payload: 1 }, framework: 'redux', tab_id: 3 },
      ctx,
    );
    expect(capture.current?.tool).toBe('store_dispatch');
    expect(capture.current?.payload).toMatchObject({
      action: { type: 'inc', payload: 1 },
      framework: 'redux',
      tab_id: 3,
    });
  });

  it('returns dispatched + framework on success', async () => {
    const ctx = buildCtx({ allowDispatch: true });
    const r = await storeDispatchHandler({ action: { type: 'inc' } }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { dispatched: boolean; framework: string };
    expect(d.dispatched).toBe(true);
    expect(d.framework).toBe('redux');
  });

  it('flags a malformed dispatch payload', async () => {
    const ctx = buildCtx({ allowDispatch: true, responsePayload: { nope: 1 } });
    const r = await storeDispatchHandler({ action: { type: 'inc' } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
