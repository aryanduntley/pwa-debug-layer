import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { z } from 'zod';
import {
  sessionRecordHandler,
  sessionRecordTool,
} from '../../../src/mcp/tools/session_record.js';
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
          sessionId: 'sess-1',
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

const schema = z.object(sessionRecordTool.inputSchema);

describe('sessionRecordTool — input schema', () => {
  it('requires action', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("accepts action='start' minimally", () => {
    expect(schema.safeParse({ action: 'start' }).success).toBe(true);
  });

  it('accepts full payload', () => {
    expect(
      schema.safeParse({
        extension_id: 'aaa',
        tab_id: 5,
        action: 'start',
        session_id: 'sess-1',
        duration_cap_ms: 30000,
      }).success,
    ).toBe(true);
  });

  it('rejects empty session_id', () => {
    expect(
      schema.safeParse({ action: 'start', session_id: '' }).success,
    ).toBe(false);
  });

  it('rejects non-positive duration_cap_ms', () => {
    expect(
      schema.safeParse({ action: 'start', duration_cap_ms: 0 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ action: 'start', duration_cap_ms: -1 }).success,
    ).toBe(false);
  });

  it('rejects action=garbage', () => {
    expect(schema.safeParse({ action: 'garbage' }).success).toBe(false);
  });
});

describe('sessionRecordHandler — happy path', () => {
  it('forwards action+session_id+duration_cap_ms', async () => {
    const capture = { current: null as IpcRequestEnvelope | null };
    const ctx = buildCtx({ captureRequest: capture });
    await sessionRecordHandler(
      { action: 'start', session_id: 'sess-A', duration_cap_ms: 5000, tab_id: 7 },
      ctx,
    );
    expect(capture.current?.tool).toBe('session_record');
    expect(capture.current?.payload).toMatchObject({
      action: 'start',
      session_id: 'sess-A',
      duration_cap_ms: 5000,
      tab_id: 7,
    });
  });

  it("returns ok with active+sessionId on action='start'", async () => {
    const ctx = buildCtx({
      responsePayload: {
        active: true,
        sessionId: 'sess-B',
        scopeUrl: 'https://example.test/',
      },
    });
    const r = await sessionRecordHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { active: boolean; sessionId: string };
    expect(d.active).toBe(true);
    expect(d.sessionId).toBe('sess-B');
  });

  it("returns ok with active=false on action='stop'", async () => {
    const ctx = buildCtx({
      responsePayload: { active: false, scopeUrl: 'https://example.test/' },
    });
    const r = await sessionRecordHandler({ action: 'stop' }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { active: boolean };
    expect(d.active).toBe(false);
  });
});

describe('sessionRecordHandler — error paths', () => {
  it('errors when no connections', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await sessionRecordHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
  });

  it('errors when ipcServer.request throws', async () => {
    const ctx = buildCtx({ throwOnRequest: new Error('timeout') });
    const r = await sessionRecordHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/session_record failed/);
  });

  it('errors when NMH responds with transport error', async () => {
    const ctx = buildCtx({ responseError: { message: 'no active tab' } });
    const r = await sessionRecordHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/session_record nmh error/);
  });

  it('maps tool-level error payload', async () => {
    const ctx = buildCtx({
      responsePayload: {
        error: { message: 'session_record: payload must be {...}' },
      },
    });
    const r = await sessionRecordHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
  });

  it('errors on malformed payload', async () => {
    const ctx = buildCtx({ responsePayload: { random: 'noise' } });
    const r = await sessionRecordHandler({ action: 'start' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malformed payload/);
  });
});
