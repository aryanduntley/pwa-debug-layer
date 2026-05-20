import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { z } from 'zod';
import {
  reduxSubscribeHandler,
  reduxSubscribeTool,
} from '../../../src/mcp/tools/redux_subscribe.js';
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
          active: true,
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

const schema = z.object(reduxSubscribeTool.inputSchema);

describe('reduxSubscribeTool — input schema', () => {
  it('requires action', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });
  it("accepts action='start' minimally", () => {
    expect(schema.safeParse({ action: 'start' }).success).toBe(true);
  });
  it("accepts action='stop' minimally", () => {
    expect(schema.safeParse({ action: 'stop' }).success).toBe(true);
  });
  it('accepts a full payload', () => {
    expect(
      schema.safeParse({
        extension_id: 'aaa',
        tab_id: 9,
        action: 'start',
        path: 'counter.value',
      }).success,
    ).toBe(true);
  });
  it("rejects action='garbage'", () => {
    expect(schema.safeParse({ action: 'garbage' }).success).toBe(false);
  });
  it('rejects empty path', () => {
    expect(schema.safeParse({ action: 'start', path: '' }).success).toBe(false);
  });
});

describe('reduxSubscribeHandler — happy path', () => {
  it("forwards action='start' + path to the IPC envelope", async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reduxSubscribeHandler(
      { action: 'start', path: 'counter', tab_id: 7 },
      ctx,
    );
    expect(capture.current?.tool).toBe('redux_subscribe');
    expect(capture.current?.payload).toMatchObject({
      action: 'start',
      path: 'counter',
      tab_id: 7,
    });
  });

  it("omits path from wire payload when not provided", async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reduxSubscribeHandler({ action: 'stop' }, ctx);
    expect(capture.current?.payload).toEqual({ action: 'stop' });
  });

  it("returns ok with active+scopeUrl on action='start'", async () => {
    const ctx = buildCtx({
      responsePayload: {
        active: true,
        path: 'counter',
        scopeUrl: 'https://example.test/path',
      },
    });
    const r = await reduxSubscribeHandler({ action: 'start', path: 'counter' }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { active: boolean; path: string; scopeUrl: string };
    expect(d.active).toBe(true);
    expect(d.path).toBe('counter');
  });

  it("returns ok with active=false on action='stop'", async () => {
    const ctx = buildCtx({
      responsePayload: {
        active: false,
        scopeUrl: 'https://example.test/',
      },
    });
    const r = await reduxSubscribeHandler({ action: 'stop' }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { active: boolean };
    expect(d.active).toBe(false);
  });
});

describe('reduxSubscribeHandler — error paths', () => {
  it('returns error when no connections', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await reduxSubscribeHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
  });

  it('returns error when ipcServer.request throws', async () => {
    const ctx = buildCtx({ throwOnRequest: new Error('timeout') });
    const r = await reduxSubscribeHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redux_subscribe failed/);
  });

  it('returns error when NMH responds with transport error', async () => {
    const ctx = buildCtx({ responseError: { message: 'no active tab' } });
    const r = await reduxSubscribeHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redux_subscribe nmh error/);
  });

  it('maps tool-level error (no store) to errorResponse', async () => {
    const ctx = buildCtx({
      responsePayload: {
        error: { message: 'redux_subscribe: no Redux store detected.' },
      },
    });
    const r = await reduxSubscribeHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no Redux store detected/);
  });

  it('returns error for malformed payload', async () => {
    const ctx = buildCtx({ responsePayload: { random: 'noise' } });
    const r = await reduxSubscribeHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
