import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  reactFindByRoleHandler,
  reactFindByRoleTool,
} from '../../../src/mcp/tools/react_find_by_role.js';
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

const okPayload = { matches: [], truncated: false, rootCount: 1 };

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
        payload: opts.responsePayload ?? okPayload,
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
  });
};

const schema = z.object(reactFindByRoleTool.inputSchema);

describe('reactFindByRoleTool — input schema', () => {
  it('requires role', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('rejects empty role and empty name', () => {
    expect(schema.safeParse({ role: '' }).success).toBe(false);
    expect(schema.safeParse({ role: 'button', name: '' }).success).toBe(false);
  });

  it('accepts a minimal valid payload', () => {
    expect(schema.safeParse({ role: 'button' }).success).toBe(true);
  });

  it('accepts a full payload', () => {
    expect(
      schema.safeParse({
        extension_id: 'aaa',
        tab_id: 5,
        role: 'textbox',
        name: 'Email.*',
        root_index: 0,
        max_matches: 10,
      }).success,
    ).toBe(true);
  });

  it('rejects negative root_index, non-positive and over-cap max_matches', () => {
    expect(schema.safeParse({ role: 'x', root_index: -1 }).success).toBe(false);
    expect(schema.safeParse({ role: 'x', max_matches: 0 }).success).toBe(false);
    expect(schema.safeParse({ role: 'x', max_matches: 999 }).success).toBe(
      false,
    );
  });
});

describe('reactFindByRoleHandler — happy path', () => {
  it('builds an IPC envelope with tool=react_find_by_role and forwards options', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reactFindByRoleHandler(
      {
        extension_id: 'aaa',
        tab_id: 7,
        role: 'button',
        name: 'Save',
        root_index: 0,
        max_matches: 3,
      },
      ctx,
    );
    expect(capture.current?.tool).toBe('react_find_by_role');
    expect(capture.current?.payload).toMatchObject({
      role: 'button',
      tab_id: 7,
      name: 'Save',
      root_index: 0,
      max_matches: 3,
    });
  });

  it('omits IPC payload fields the caller did not provide (keeps role only)', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await reactFindByRoleHandler({ role: 'button' }, ctx);
    expect(capture.current?.payload).toEqual({ role: 'button' });
  });

  it('returns ok with matches/truncated/rootCount on success', async () => {
    const ctx = buildCtx({
      responsePayload: {
        matches: [
          {
            stableId: 'root0/App[0]/button[0]',
            displayName: 'button',
            role: 'button',
            name: 'Save changes',
          },
        ],
        truncated: false,
        rootCount: 1,
      },
    });
    const r = await reactFindByRoleHandler({ role: 'button', tab_id: 9 }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      tabId: number;
      matches: { role: string; name?: string }[];
      rootCount: number;
    };
    expect(d.tabId).toBe(9);
    expect(d.rootCount).toBe(1);
    expect(d.matches[0]!.role).toBe('button');
    expect(d.matches[0]!.name).toBe('Save changes');
  });

  it('next_steps mentions truncated:true when set', async () => {
    const ctx = buildCtx({
      responsePayload: { matches: [], truncated: true, rootCount: 1 },
    });
    const r = await reactFindByRoleHandler({ role: 'button' }, ctx);
    expect(r.next_steps.join(' ')).toMatch(/truncated/);
  });

  it('next_steps explains an out-of-range root_index', async () => {
    const ctx = buildCtx({
      responsePayload: { matches: [], truncated: false, rootCount: 1 },
    });
    const r = await reactFindByRoleHandler({ role: 'button', root_index: 5 }, ctx);
    expect(r.next_steps.join(' ')).toMatch(/out of range/);
  });

  it('next_steps gives no-match guidance when rootCount is 0', async () => {
    const ctx = buildCtx({
      responsePayload: { matches: [], truncated: false, rootCount: 0 },
    });
    const r = await reactFindByRoleHandler({ role: 'button' }, ctx);
    expect(r.next_steps.join(' ')).toMatch(/no React roots detected/i);
  });
});

describe('reactFindByRoleHandler — error paths', () => {
  it('returns error when no connections and no extension_id', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await reactFindByRoleHandler({ role: 'button' }, ctx);
    expect(r.ok).toBe(false);
  });

  it('returns error when ipcServer.request throws', async () => {
    const ctx = buildCtx({ throwOnRequest: new Error('timeout 5000ms') });
    const r = await reactFindByRoleHandler({ role: 'button' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/react_find_by_role failed/);
  });

  it('returns error when NMH responds with a transport error envelope', async () => {
    const ctx = buildCtx({ responseError: { message: 'no active tab' } });
    const r = await reactFindByRoleHandler({ role: 'button' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/react_find_by_role nmh error/);
  });

  it('maps a tool-level error payload (invalid name regex) to errorResponse', async () => {
    const ctx = buildCtx({
      responsePayload: {
        error: { message: 'react_find_by_role: invalid name regex: bad' },
      },
    });
    const r = await reactFindByRoleHandler({ role: 'button', name: '(' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid name regex/);
    expect(r.next_steps.join(' ')).toMatch(/regex/i);
  });

  it('returns error when payload is neither success nor tool-error shape', async () => {
    const ctx = buildCtx({ responsePayload: { random: 'noise' } });
    const r = await reactFindByRoleHandler({ role: 'button' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
