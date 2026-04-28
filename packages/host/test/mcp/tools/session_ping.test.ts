import { describe, it, expect } from 'vitest';
import { sessionPingHandler } from '../../../src/mcp/tools/session_ping.js';
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
};

const buildCtx = (opts: FakeOpts = {}): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (
      _extId: string,
      env: IpcRequestEnvelope,
    ): Promise<IpcResponseEnvelope> =>
      Object.freeze({
        type: 'response' as const,
        requestId: env.requestId,
        payload: opts.responsePayload ?? {},
      }),
    listConnections: () =>
      opts.connections ?? [
        { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
      ],
  });
  return Object.freeze({ ipcServer: fake, hostVersion: '0.0.0-test' });
};

describe('sessionPingHandler — pageWorld surfacing', () => {
  it('lifts pageWorld from a well-formed SW response payload', async () => {
    const ctx = buildCtx({
      responsePayload: {
        extensionVersion: '1.2.3',
        attachedTabId: 42,
        pageWorld: {
          url: 'https://example.com/',
          title: 'Example',
          readyState: 'complete',
        },
      },
    });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      pageWorld: { url: string; title: string; readyState: string } | null;
      pageWorldError?: string;
    };
    expect(d.pageWorld).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      readyState: 'complete',
    });
    expect(d.pageWorldError).toBeUndefined();
  });

  it('passes through pageWorldError when the SW reports a page-bridge failure', async () => {
    const ctx = buildCtx({
      responsePayload: {
        extensionVersion: '1.2.3',
        attachedTabId: 42,
        pageWorld: null,
        pageWorldError: 'no active tab',
      },
    });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      pageWorld: unknown;
      pageWorldError?: string;
    };
    expect(d.pageWorld).toBeNull();
    expect(d.pageWorldError).toBe('no active tab');
    expect(r.next_steps.join(' ')).toMatch(/pageWorld is null/);
  });

  it('returns pageWorld:null when the field is absent from the SW response', async () => {
    const ctx = buildCtx({
      responsePayload: { extensionVersion: '1.2.3', attachedTabId: 42 },
    });
    const r = await sessionPingHandler({}, ctx);
    const d = r.data as { pageWorld: unknown };
    expect(d.pageWorld).toBeNull();
    expect(r.next_steps.join(' ')).toMatch(/pageWorld is null/);
  });

  it('returns pageWorld:null when readyState is malformed', async () => {
    const ctx = buildCtx({
      responsePayload: {
        pageWorld: {
          url: 'https://x',
          title: 't',
          readyState: 'bogus',
        },
      },
    });
    const r = await sessionPingHandler({}, ctx);
    const d = r.data as { pageWorld: unknown };
    expect(d.pageWorld).toBeNull();
  });
});
