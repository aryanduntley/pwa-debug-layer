import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  popupTailHandler,
  popupTailTool,
} from '../../../src/mcp/tools/popup_tail.js';
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
      throw new Error('popup_tail must not perform IPC — it reads the host buffer');
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

describe('popupTailTool', () => {
  it('exposes the popup_tail name', () => {
    expect(popupTailTool.name).toBe('popup_tail');
  });

  it('errors when no NMH is connected', async () => {
    const r = await popupTailHandler({ filter: undefined }, buildCtx([]));
    expect(r.ok).toBe(false);
  });

  it('returns an empty result when the extension is connected but no events have arrived', async () => {
    const r = await popupTailHandler({ filter: undefined }, buildCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ entries: [], cursor: null, hasMore: false });
    expect(r.next_steps.join(' ')).toMatch(/popup|widget/i);
  });
});
