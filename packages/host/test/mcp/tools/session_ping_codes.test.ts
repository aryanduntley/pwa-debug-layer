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
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const buildCtxWithError = (
  pageWorldError: string,
  extra: Record<string, unknown> = {},
): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (
      _ext: string,
      env: IpcRequestEnvelope,
    ): Promise<IpcResponseEnvelope> =>
      Object.freeze({
        type: 'response' as const,
        requestId: env.requestId,
        payload: {
          extensionVersion: '1.2.3',
          attachedTabId: 42,
          pageWorld: null,
          pageWorldError,
          pageWorldErrorMessage: 'raw chrome.runtime error string',
          ...extra,
        },
      }),
    listConnections: (): readonly IpcConnectionInfo[] => [
      { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
    ],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
  });
};

describe('session_ping next_steps per typed code', () => {
  it('cs_not_attached_refresh_tab → instructs user to hard-refresh tab and retry', async () => {
    const r = await sessionPingHandler(
      {},
      buildCtxWithError('cs_not_attached_refresh_tab'),
    );
    const joined = r.next_steps.join(' ');
    expect(joined).toMatch(/hard-refresh the page tab/);
    expect(joined).toMatch(/Ctrl\+Shift\+R/);
  });

  it('page_blocks_scripts → mentions Brave Shields, uBlock, and CSP fallback', async () => {
    const r = await sessionPingHandler(
      {},
      buildCtxWithError('page_blocks_scripts'),
    );
    const joined = r.next_steps.join(' ');
    expect(joined).toMatch(/Brave/);
    expect(joined).toMatch(/Shields/);
    expect(joined).toMatch(/uBlock/);
    expect(joined).toMatch(/CSP/);
  });

  it('page_world_blocked → explains site CSP cannot be bypassed', async () => {
    const r = await sessionPingHandler(
      {},
      buildCtxWithError('page_world_blocked'),
    );
    const joined = r.next_steps.join(' ');
    expect(joined).toMatch(/Content-Security-Policy/);
    expect(joined).toMatch(/cannot bypass/);
  });

  it('restricted_url → instructs user to focus an http(s) tab', async () => {
    const r = await sessionPingHandler(
      {},
      buildCtxWithError('restricted_url'),
    );
    const joined = r.next_steps.join(' ');
    expect(joined).toMatch(/chrome:\/\//);
    expect(joined).toMatch(/regular http\(s\) tab/);
  });

  it('no_active_tab → instructs user to focus a tab', async () => {
    const r = await sessionPingHandler({}, buildCtxWithError('no_active_tab'));
    const joined = r.next_steps.join(' ');
    expect(joined).toMatch(/No active http\(s\) tab/);
    expect(joined).toMatch(/focus a regular browser tab/);
  });

  it('cs_inject_failed → instructs user to reload extension and hard-refresh', async () => {
    const r = await sessionPingHandler(
      {},
      buildCtxWithError('cs_inject_failed'),
    );
    const joined = r.next_steps.join(' ');
    expect(joined).toMatch(/reload the extension at chrome:\/\/extensions/);
    expect(joined).toMatch(/hard-refresh/);
  });
});
