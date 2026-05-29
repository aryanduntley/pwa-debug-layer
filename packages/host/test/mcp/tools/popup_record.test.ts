import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import { popupRecordHandler, popupRecordTool } from '../../../src/mcp/tools/popup_record.js';
import { popupReplayHandler, popupReplayTool } from '../../../src/mcp/tools/popup_replay.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type { IpcConnectionInfo, IpcServer } from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

const buildCtx = (connections?: readonly IpcConnectionInfo[]): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () => {
      throw new Error('recording tools must not perform IPC');
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

let dir: string;
let prevXdg: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-rectool-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(dir, { recursive: true, force: true });
});

describe('popupRecord / popupReplay tools', () => {
  it('expose their names', () => {
    expect(popupRecordTool.name).toBe('popup_record');
    expect(popupReplayTool.name).toBe('popup_replay');
  });

  it('status reports inactive before any recording', async () => {
    const r = await popupRecordHandler({ action: 'status' }, buildCtx());
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ recording: { active: false } });
  });

  it('start → feed events → stop → replay round-trip', async () => {
    const ctx = buildCtx();
    const start = await popupRecordHandler(
      { action: 'start', label: 'roundtrip' },
      ctx,
    );
    expect(start.ok).toBe(true);

    ctx.capturesRegistry.getOrCreate('aaa').receive({
      events: [
        {
          kind: 'library_popup',
          ts: 1,
          frameKey: 'top',
          frameUrl: 'https://x/',
          popupId: 'P',
          role: 'primary',
          parentPopupId: null,
          phase: 'appeared',
          library: 'walletconnect',
          detection: 'shadow',
        },
      ],
    });

    const stop = await popupRecordHandler({ action: 'stop' }, ctx);
    expect(stop.ok).toBe(true);
    expect((stop.data as { recording: { count: number } }).recording.count).toBe(1);

    const replay = await popupReplayHandler(
      { label: 'roundtrip', mode: 'primary' },
      ctx,
    );
    expect(replay.ok).toBe(true);
    expect((replay.data as { total: number }).total).toBe(1);

    const list = await popupReplayHandler({}, ctx);
    expect(
      (list.data as { recordings: Array<{ label: string }> }).recordings.some(
        (x) => x.label === 'roundtrip',
      ),
    ).toBe(true);
  });
});
