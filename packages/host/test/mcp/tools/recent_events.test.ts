import { describe, it, expect } from 'vitest';
import { recentEventsHandler } from '../../../src/mcp/tools/recent_events.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import type {
  IpcRequestEnvelope,
  IpcResponseEnvelope,
} from '../../../src/mcp/ipc/envelope.js';

type FakeOpts = {
  readonly connections?: readonly IpcConnectionInfo[];
  readonly responsePayload?: unknown;
  readonly responseError?: { readonly message: string };
  readonly captureRequest?: (env: IpcRequestEnvelope) => void;
  readonly throwOnRequest?: Error;
};

const buildCtx = (opts: FakeOpts = {}): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (
      _extId: string,
      env: IpcRequestEnvelope,
    ): Promise<IpcResponseEnvelope> => {
      opts.captureRequest?.(env);
      if (opts.throwOnRequest) throw opts.throwOnRequest;
      if (opts.responseError) {
        return Object.freeze({
          type: 'response' as const,
          requestId: env.requestId,
          error: opts.responseError,
        });
      }
      return Object.freeze({
        type: 'response' as const,
        requestId: env.requestId,
        payload: opts.responsePayload ?? {},
      });
    },
    listConnections: () =>
      opts.connections ?? [
        { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
      ],
  });
  return Object.freeze({ ipcServer: fake, hostVersion: '0.0.0-test' });
};

describe('recentEventsHandler — happy path', () => {
  it('returns events + stats from the SW response payload', async () => {
    const ctx = buildCtx({
      responsePayload: {
        events: [
          {
            kind: 'console',
            level: 'log',
            args: ['hi'],
            ts: 1,
            frameUrl: 'https://x',
            frameKey: 'top',
          },
          {
            kind: 'console',
            level: 'warn',
            args: ['boom'],
            ts: 2,
            frameUrl: 'https://x',
            frameKey: 'top',
            stack: '    at userFrame (about:blank:1:1)',
          },
        ],
        stats: { totalReceived: 2, perKind: { console: 2 }, bufferSize: 200 },
      },
    });
    const r = await recentEventsHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      extensionId: string;
      events: ReadonlyArray<{ kind: string }>;
      stats: {
        totalReceived: number;
        perKind: Record<string, number>;
        bufferSize: number;
      };
    };
    expect(d.extensionId).toBe('aaa');
    expect(d.events.length).toBe(2);
    expect(d.events[0]?.kind).toBe('console');
    expect(d.stats.totalReceived).toBe(2);
    expect(d.stats.bufferSize).toBe(200);
  });

  it('forwards filter args and renames since_ms -> sinceMs in the IPC payload', async () => {
    let captured: IpcRequestEnvelope | undefined;
    const ctx = buildCtx({
      captureRequest: (env) => {
        captured = env;
      },
      responsePayload: {
        events: [],
        stats: { totalReceived: 0, perKind: {}, bufferSize: 200 },
      },
    });
    await recentEventsHandler(
      { kinds: ['console', 'fetch'], since_ms: 100, limit: 25 },
      ctx,
    );
    expect(captured?.tool).toBe('recent_events');
    expect(typeof captured?.requestId).toBe('string');
    const p = captured?.payload as Record<string, unknown>;
    expect(p['kinds']).toEqual(['console', 'fetch']);
    expect(p['sinceMs']).toBe(100);
    expect(p['limit']).toBe(25);
    expect(p).not.toHaveProperty('since_ms');
  });

  it('omits filter fields from the IPC payload when not provided', async () => {
    let captured: IpcRequestEnvelope | undefined;
    const ctx = buildCtx({
      captureRequest: (env) => {
        captured = env;
      },
      responsePayload: {
        events: [],
        stats: { totalReceived: 0, perKind: {}, bufferSize: 200 },
      },
    });
    await recentEventsHandler({}, ctx);
    expect(captured?.payload).toEqual({});
  });

  it('returns ok with events:[] + empty-buffer hint when SW returns no events', async () => {
    const ctx = buildCtx({
      responsePayload: {
        events: [],
        stats: { totalReceived: 0, perKind: {}, bufferSize: 200 },
      },
    });
    const r = await recentEventsHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as { events: ReadonlyArray<unknown> };
    expect(d.events).toEqual([]);
    expect(r.next_steps.join(' ')).toMatch(/events:\[\]/);
    expect(r.next_steps.join(' ')).toMatch(/hard-refresh/);
  });
});

describe('recentEventsHandler — error paths', () => {
  it('errors with NMH-not-connected hint when no connections', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await recentEventsHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no NMH connected/);
    expect(r.next_steps.join(' ')).toMatch(/host_status/);
  });

  it('errors with disambiguate-extension hint when multiple connections and no arg', async () => {
    const ctx = buildCtx({
      connections: [
        { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
        { extensionId: 'bbb', connectedAt: 2, lastSeenAt: 2 },
      ],
    });
    const r = await recentEventsHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/multiple NMH connections/);
  });

  it('errors when extension_id is given but not connected', async () => {
    const ctx = buildCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
    });
    const r = await recentEventsHandler({ extension_id: 'bbb' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no connected NMH for extension_id=bbb/);
  });

  it('surfaces IPC failures', async () => {
    const ctx = buildCtx({ throwOnRequest: new Error('boom: timeout') });
    const r = await recentEventsHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recent_events failed: boom: timeout/);
  });

  it('surfaces NMH error envelopes', async () => {
    const ctx = buildCtx({
      responseError: { message: 'sw responder unavailable' },
    });
    const r = await recentEventsHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sw responder unavailable/);
  });
});

describe('recentEventsHandler — defensive payload handling', () => {
  it('falls back to safe defaults when SW response payload is malformed', async () => {
    const ctx = buildCtx({ responsePayload: 'not-an-object' });
    const r = await recentEventsHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      events: ReadonlyArray<unknown>;
      stats: { totalReceived: number; perKind: Record<string, number>; bufferSize: number };
    };
    expect(d.events).toEqual([]);
    expect(d.stats).toEqual({ totalReceived: 0, perKind: {}, bufferSize: 0 });
  });

  it('falls back to events:[] when events field is not an array', async () => {
    const ctx = buildCtx({
      responsePayload: { events: 'not-an-array', stats: {} },
    });
    const r = await recentEventsHandler({}, ctx);
    const d = r.data as { events: ReadonlyArray<unknown> };
    expect(d.events).toEqual([]);
  });
});
