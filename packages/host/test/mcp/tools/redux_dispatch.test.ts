import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { z } from 'zod';
import {
  reduxDispatchHandler,
  reduxDispatchTool,
} from '../../../src/mcp/tools/redux_dispatch.js';
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
import type {
  SettingTypeMap,
  SettingKey,
  SettingsRecord,
} from '@pwa-debug/shared';

type FakeOpts = {
  readonly connections?: readonly IpcConnectionInfo[];
  readonly responsePayload?: unknown;
  readonly responseError?: { readonly message: string };
  readonly throwOnRequest?: Error;
  readonly captureRequest?: { current: IpcRequestEnvelope | null };
  readonly allowDispatch?: boolean;
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
          dispatched: true,
          action: { type: 'counter/increment' },
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
    'capture.stores.allowDispatch': opts.allowDispatch ?? true,
  } as Partial<SettingsRecord>);
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore,
  });
};

void (null as unknown as SettingTypeMap[SettingKey]); // type-only reference to satisfy lint

const schema = z.object(reduxDispatchTool.inputSchema);

describe('reduxDispatchTool — input schema', () => {
  it('requires action.type', () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ action: {} }).success).toBe(false);
    expect(schema.safeParse({ action: { type: '' } }).success).toBe(false);
  });

  it('accepts minimal action', () => {
    expect(schema.safeParse({ action: { type: 'a' } }).success).toBe(true);
  });

  it('accepts full payload', () => {
    expect(
      schema.safeParse({
        extension_id: 'aaa',
        tab_id: 5,
        action: { type: 'counter/addBy', payload: 7 },
      }).success,
    ).toBe(true);
  });
});

describe('reduxDispatchHandler — setting gate', () => {
  it('errors when capture.stores.allowDispatch=false', async () => {
    const ctx = buildCtx({ allowDispatch: false });
    const r = await reduxDispatchHandler({ action: { type: 'x' } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/disabled/);
    expect(r.next_steps.join(' ')).toMatch(/allowDispatch/);
  });

  it('errors before opening an IPC request when disabled', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ allowDispatch: false, captureRequest: capture });
    await reduxDispatchHandler({ action: { type: 'x' } }, ctx);
    expect(capture.current).toBeNull();
  });
});

describe('reduxDispatchHandler — happy path (gate open)', () => {
  it('forwards action + tab_id to the IPC envelope', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ allowDispatch: true, captureRequest: capture });
    await reduxDispatchHandler(
      { action: { type: 'counter/addBy', payload: 5 }, tab_id: 7 },
      ctx,
    );
    expect(capture.current?.tool).toBe('redux_dispatch');
    expect(capture.current?.payload).toMatchObject({
      action: { type: 'counter/addBy', payload: 5 },
      tab_id: 7,
    });
  });

  it('returns ok with dispatched:true + scopeUrl', async () => {
    const ctx = buildCtx({
      allowDispatch: true,
      responsePayload: {
        dispatched: true,
        action: { type: 'counter/increment' },
        scopeUrl: 'https://example.test/',
      },
    });
    const r = await reduxDispatchHandler(
      { action: { type: 'counter/increment' } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const d = r.data as { dispatched: boolean; scopeUrl: string };
    expect(d.dispatched).toBe(true);
    expect(d.scopeUrl).toBe('https://example.test/');
  });
});

describe('reduxDispatchHandler — error paths (gate open)', () => {
  it('returns error when no connections', async () => {
    const ctx = buildCtx({ allowDispatch: true, connections: [] });
    const r = await reduxDispatchHandler({ action: { type: 'x' } }, ctx);
    expect(r.ok).toBe(false);
  });

  it('returns error when ipcServer.request throws', async () => {
    const ctx = buildCtx({
      allowDispatch: true,
      throwOnRequest: new Error('timeout'),
    });
    const r = await reduxDispatchHandler({ action: { type: 'x' } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redux_dispatch failed/);
  });

  it('returns error when NMH responds with transport error', async () => {
    const ctx = buildCtx({
      allowDispatch: true,
      responseError: { message: 'no active tab' },
    });
    const r = await reduxDispatchHandler({ action: { type: 'x' } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redux_dispatch nmh error/);
  });

  it('maps tool-level error (no store) to errorResponse', async () => {
    const ctx = buildCtx({
      allowDispatch: true,
      responsePayload: {
        error: { message: 'redux_dispatch: no Redux store detected.' },
      },
    });
    const r = await reduxDispatchHandler({ action: { type: 'x' } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no Redux store detected/);
  });

  it('returns error for malformed payload', async () => {
    const ctx = buildCtx({
      allowDispatch: true,
      responsePayload: { random: 'noise' },
    });
    const r = await reduxDispatchHandler({ action: { type: 'x' } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
