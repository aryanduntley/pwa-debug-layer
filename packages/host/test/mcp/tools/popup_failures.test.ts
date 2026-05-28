import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  popupFailuresHandler,
  popupFailuresTool,
} from '../../../src/mcp/tools/popup_failures.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const buildCtx = (connections?: readonly IpcConnectionInfo[]): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () => {
      throw new Error('popup_failures must not perform IPC — it reads host buffers');
    },
    listConnections: () =>
      connections ?? [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore: mockSettingsStore(),
  });
};

describe('popupFailuresTool', () => {
  it('exposes the popup_failures name', () => {
    expect(popupFailuresTool.name).toBe('popup_failures');
  });

  it('errors when no NMH is connected', async () => {
    const r = await popupFailuresHandler({}, buildCtx([]));
    expect(r.ok).toBe(false);
  });

  it('returns an empty report set when connected but no events have arrived', async () => {
    const r = await popupFailuresHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ reports: [] });
  });

  it('correlates a seeded popup failure end-to-end', async () => {
    const ctx = buildCtx();
    const captures = ctx.capturesRegistry.getOrCreate('aaa');
    captures.receive({
      events: [
        {
          kind: 'library_popup',
          ts: 100,
          frameKey: 'top',
          popupId: 'p1',
          library: 'walletconnect',
          detection: 'portal',
          phase: 'appeared',
          state: { failure: { reason: 'user rejected request' } },
        },
        { kind: 'console', ts: 120, frameKey: 'top', level: 'error', args: ['WC error'] },
      ],
    });

    const r = await popupFailuresHandler({ extension_id: 'aaa' }, ctx);
    expect(r.ok).toBe(true);
    const reports = (r.data as { reports: Array<{ reason?: string; console: unknown[] }> }).reports;
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reason).toBe('user rejected request');
    expect(reports[0]!.console).toHaveLength(1);
  });
});
