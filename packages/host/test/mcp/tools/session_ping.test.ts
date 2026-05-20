import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
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
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

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
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore: mockSettingsStore(),
  });
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

  it("passes through typed pageWorldError + pageWorldErrorMessage when SW reports a page-bridge failure", async () => {
    const ctx = buildCtx({
      responsePayload: {
        extensionVersion: '1.2.3',
        attachedTabId: 42,
        pageWorld: null,
        pageWorldError: 'no_active_tab',
        pageWorldErrorMessage: 'no active tab',
      },
    });
    const r = await sessionPingHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      pageWorld: unknown;
      pageWorldError?: string;
      pageWorldErrorMessage?: string;
    };
    expect(d.pageWorld).toBeNull();
    expect(d.pageWorldError).toBe('no_active_tab');
    expect(d.pageWorldErrorMessage).toBe('no active tab');
    // next_steps should now reference the typed-code-specific imperative, not generic
    expect(r.next_steps.join(' ')).toMatch(/focus a regular browser tab/);
  });

  it('drops unknown pageWorldError values (defensive: not in typed union)', async () => {
    const ctx = buildCtx({
      responsePayload: {
        extensionVersion: '1.2.3',
        attachedTabId: 42,
        pageWorld: null,
        pageWorldError: 'some_unknown_code',
      },
    });
    const r = await sessionPingHandler({}, ctx);
    const d = r.data as {
      pageWorld: unknown;
      pageWorldError?: string;
    };
    expect(d.pageWorld).toBeNull();
    expect(d.pageWorldError).toBeUndefined();
    expect(r.next_steps.join(' ')).toMatch(
      /pageWorld is null but no typed pageWorldError/,
    );
  });

  it('returns pageWorld:null when the field is absent from the SW response', async () => {
    const ctx = buildCtx({
      responsePayload: { extensionVersion: '1.2.3', attachedTabId: 42 },
    });
    const r = await sessionPingHandler({}, ctx);
    const d = r.data as { pageWorld: unknown };
    expect(d.pageWorld).toBeNull();
    expect(r.next_steps.join(' ')).toMatch(
      /pageWorld is null but no typed pageWorldError/,
    );
  });

  it('exposes pageWorldSelfHealed:true and emits the self-heal info hint', async () => {
    const ctx = buildCtx({
      responsePayload: {
        extensionVersion: '1.2.3',
        attachedTabId: 42,
        pageWorld: { url: 'https://x', title: 't', readyState: 'complete' },
        pageWorldSelfHealed: true,
      },
    });
    const r = await sessionPingHandler({}, ctx);
    const d = r.data as { pageWorldSelfHealed?: boolean };
    expect(d.pageWorldSelfHealed).toBe(true);
    expect(r.next_steps.join(' ')).toMatch(/pageWorldSelfHealed:true/);
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
