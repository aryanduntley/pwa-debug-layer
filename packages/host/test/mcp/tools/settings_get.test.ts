import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, settingKeys } from '@pwa-debug/shared';
import {
  createSettingsStore,
  type SettingsStore,
} from '../../../src/host_settings/host_settings.js';
import {
  settingsGetHandler,
  settingsGetTool,
} from '../../../src/mcp/tools/settings_get.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type { IpcServer } from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

let dir: string;
let path: string;
let store: SettingsStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-settings-get-'));
  path = join(dir, 'settings.json');
  store = createSettingsStore({ path, disableWatch: true });
  await store.init();
});
afterEach(async () => {
  store.dispose();
  await rm(dir, { recursive: true, force: true });
});

const noopIpc: IpcServer = Object.freeze({
  close: async () => {},
  sendTo: () => Object.freeze({ ok: true as const }),
  request: async () => {
    throw new Error('settings_get must not call ipcServer');
  },
  listConnections: () => [],
});

const buildCtx = (): ToolContext =>
  Object.freeze({
    ipcServer: noopIpc,
    hostVersion: '0.0.0-test',
    capturesRegistry: createCapturesRegistry(),
    settingsStore: store,
  });

describe('settings_get tool', () => {
  it('returns all values when key is omitted', async () => {
    const r = await settingsGetHandler({}, buildCtx());
    expect(r.ok).toBe(true);
    const data = r.data as { values: Record<string, unknown> };
    expect(data.values).toEqual(defaultSettings());
  });

  it('returns the requested key with value + wire-safe entry when key is known', async () => {
    const r = await settingsGetHandler(
      { key: 'capture.memoryCutoffPerKind' },
      buildCtx(),
    );
    expect(r.ok).toBe(true);
    const data = r.data as {
      key: string;
      value: unknown;
      entry: { key: string; type: string; default: unknown };
    };
    expect(data.key).toBe('capture.memoryCutoffPerKind');
    expect(data.value).toBe(5000);
    expect(data.entry.key).toBe('capture.memoryCutoffPerKind');
    expect(data.entry.type).toBe('number');
    expect(data.entry.default).toBe(5000);
    // Validate must not leak onto the wire.
    expect((data.entry as { validate?: unknown }).validate).toBeUndefined();
  });

  it('reflects the most recent setSetting in the same process', async () => {
    await store.setSetting('capture.diskSpill.enabled', true);
    const r = await settingsGetHandler(
      { key: 'capture.diskSpill.enabled' },
      buildCtx(),
    );
    expect(r.ok).toBe(true);
    expect((r.data as { value: unknown }).value).toBe(true);
  });

  it('errorResponses with a list_schema next_step when the key is unknown', async () => {
    const r = await settingsGetHandler(
      { key: 'no.such.key' },
      buildCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no.such.key');
    expect(r.next_steps.join(' ')).toMatch(/settings_list_schema/);
  });

  it('every known key is readable (full schema coverage)', async () => {
    for (const k of settingKeys()) {
      const r = await settingsGetHandler({ key: k }, buildCtx());
      expect(r.ok).toBe(true);
    }
  });

  it('tool name and inputSchema match the MCP registry contract', () => {
    expect(settingsGetTool.name).toBe('settings_get');
    expect(Object.keys(settingsGetTool.inputSchema)).toEqual(['key']);
  });
});
