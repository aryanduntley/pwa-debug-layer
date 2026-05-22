import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  storeSubscribeHandler,
  storeSubscribeTool,
} from '../../../src/mcp/tools/store_subscribe.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type { IpcServer } from '../../../src/mcp/ipc/ipc_server.js';
import type {
  IpcRequestEnvelope,
  IpcResponseEnvelope,
} from '../../../src/mcp/ipc/envelope.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

type FakeOpts = {
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
          active: true,
          framework: 'redux',
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
    settingsStore: mockSettingsStore(),
  });
};

const schema = z.object(storeSubscribeTool.inputSchema);

describe('storeSubscribeTool — input schema', () => {
  it('requires a valid action enum', () => {
    expect(schema.safeParse({ action: 'start' }).success).toBe(true);
    expect(schema.safeParse({ action: 'stop' }).success).toBe(true);
    expect(schema.safeParse({ action: 'nope' }).success).toBe(false);
  });
});

describe('storeSubscribeHandler', () => {
  it('forwards tool=store_subscribe with action + path + framework', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await storeSubscribeHandler(
      { action: 'start', path: 'counter', framework: 'redux' },
      ctx,
    );
    expect(capture.current?.tool).toBe('store_subscribe');
    expect(capture.current?.payload).toMatchObject({
      action: 'start',
      path: 'counter',
      framework: 'redux',
    });
  });

  it('returns active + framework on success', async () => {
    const r = await storeSubscribeHandler({ action: 'start' }, buildCtx());
    expect(r.ok).toBe(true);
    const d = r.data as { active: boolean; framework: string };
    expect(d.active).toBe(true);
    expect(d.framework).toBe('redux');
  });

  it('flags a malformed subscribe payload', async () => {
    const ctx = buildCtx({ responsePayload: { nope: 1 } });
    const r = await storeSubscribeHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
