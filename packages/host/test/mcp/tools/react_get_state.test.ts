import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { z } from 'zod';
import {
  reactGetStateHandler,
  reactGetStateTool,
} from '../../../src/mcp/tools/react_get_state.js';
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
          stableId: 'root0/App[0]',
          displayName: 'App',
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

const schema = z.object(reactGetStateTool.inputSchema);

describe('reactGetStateTool — input schema', () => {
  it('requires stable_id', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('rejects empty stable_id', () => {
    expect(schema.safeParse({ stable_id: '' }).success).toBe(false);
  });

  it('accepts minimal valid payload', () => {
    expect(schema.safeParse({ stable_id: 'root0' }).success).toBe(true);
  });

  it('accepts a full payload', () => {
    expect(
      schema.safeParse({
        extension_id: 'aaa',
        tab_id: 5,
        stable_id: 'root0/App[0]',
        root_index: 0,
        include_props: true,
        include_hooks: false,
      }).success,
    ).toBe(true);
  });

  it('rejects negative root_index', () => {
    expect(schema.safeParse({ stable_id: 'x', root_index: -1 }).success).toBe(false);
  });

  it('rejects non-boolean include_props', () => {
    expect(
      schema.safeParse({ stable_id: 'x', include_props: 'yes' as unknown as boolean }).success,
    ).toBe(false);
  });
});

describe('reactGetStateHandler — happy path', () => {
  it('builds IPC envelope with tool=react_get_state and forwards options', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reactGetStateHandler(
      {
        extension_id: 'aaa',
        tab_id: 7,
        stable_id: 'root0/App[0]',
        root_index: 0,
        include_props: false,
        include_hooks: true,
      },
      ctx,
    );
    expect(capture.current?.tool).toBe('react_get_state');
    expect(capture.current?.payload).toMatchObject({
      stable_id: 'root0/App[0]',
      tab_id: 7,
      root_index: 0,
      include_props: false,
      include_hooks: true,
    });
  });

  it('omits IPC payload fields the caller did not provide (keeps stable_id only)', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reactGetStateHandler({ stable_id: 'root0' }, ctx);
    expect(capture.current?.payload).toEqual({ stable_id: 'root0' });
  });

  it('returns ok with component info on success', async () => {
    const ctx = buildCtx({
      responsePayload: {
        stableId: 'root0/App[0]',
        displayName: 'App',
        props: { initial: 0 },
        hooks: [{ type: 'state', index: 0, value: 5 }],
      },
    });
    const r = await reactGetStateHandler({ stable_id: 'root0/App[0]', tab_id: 9 }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { tabId: number; stableId: string; props: unknown; hooks: unknown };
    expect(d.tabId).toBe(9);
    expect(d.stableId).toBe('root0/App[0]');
    expect(d.props).toEqual({ initial: 0 });
    expect(d.hooks).toEqual([{ type: 'state', index: 0, value: 5 }]);
  });

  it('next_steps mentions truncated:true when set', async () => {
    const ctx = buildCtx({
      responsePayload: {
        stableId: 'root0/App[0]',
        displayName: 'App',
        truncated: true,
      },
    });
    const r = await reactGetStateHandler({ stable_id: 'root0/App[0]' }, ctx);
    expect(r.next_steps.join(' ')).toMatch(/truncated/);
  });

  it('next_steps notes include_hooks:false when set and hooks omitted', async () => {
    const ctx = buildCtx({
      responsePayload: { stableId: 'root0/App[0]', displayName: 'App' },
    });
    const r = await reactGetStateHandler(
      { stable_id: 'root0/App[0]', include_hooks: false },
      ctx,
    );
    expect(r.next_steps.join(' ')).toMatch(/include_hooks:false/);
  });
});

describe('reactGetStateHandler — error paths', () => {
  it('returns error when no connections and no extension_id', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await reactGetStateHandler({ stable_id: 'root0' }, ctx);
    expect(r.ok).toBe(false);
  });

  it('returns error when ipcServer.request throws', async () => {
    const ctx = buildCtx({ throwOnRequest: new Error('timeout 5000ms') });
    const r = await reactGetStateHandler({ stable_id: 'root0' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/react_get_state failed/);
  });

  it('returns error when NMH responds with transport error envelope', async () => {
    const ctx = buildCtx({ responseError: { message: 'no active tab' } });
    const r = await reactGetStateHandler({ stable_id: 'root0' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/react_get_state nmh error/);
  });

  it('maps a payload-level error (stable_id not resolvable) to errorResponse', async () => {
    const ctx = buildCtx({
      responsePayload: {
        error: { message: 'react_get_state: stable_id "root0/Missing" did not resolve.' },
      },
    });
    const r = await reactGetStateHandler({ stable_id: 'root0/Missing' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not resolve/);
    expect(r.next_steps.join(' ')).toMatch(/re-call react.tree/);
  });

  it('returns error when payload is neither component info nor tool-error shape', async () => {
    const ctx = buildCtx({ responsePayload: { random: 'noise' } });
    const r = await reactGetStateHandler({ stable_id: 'root0' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
