import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSettingsStore,
  type SettingsStore,
} from '../../../src/host_settings/host_settings.js';
import {
  settingsSetHandler,
  settingsSetTool,
} from '../../../src/mcp/tools/settings_set.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type { IpcServer } from '../../../src/mcp/ipc/ipc_server.js';
import { createCapturesRegistry } from '../../../src/captures_in/captures_in.js';

let dir: string;
let path: string;
let store: SettingsStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-settings-set-'));
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
    throw new Error('settings_set must not call ipcServer');
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

const onDisk = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf-8'));

describe('settings_set — happy paths per type', () => {
  it('accepts a number setting and persists it', async () => {
    const r = await settingsSetHandler(
      { key: 'capture.memoryCutoffPerKind', value: 12345 },
      buildCtx(),
    );
    expect(r.ok).toBe(true);
    expect((r.data as { value: unknown }).value).toBe(12345);
    expect((await onDisk())['capture.memoryCutoffPerKind']).toBe(12345);
  });

  it('accepts a boolean setting', async () => {
    const r = await settingsSetHandler(
      { key: 'capture.diskSpill.enabled', value: true },
      buildCtx(),
    );
    expect(r.ok).toBe(true);
    expect(store.getSetting('capture.diskSpill.enabled')).toBe(true);
  });

  it('accepts a string[] setting', async () => {
    const r = await settingsSetHandler(
      { key: 'sites.blocklist', value: ['*.tracking.com', 'evil.com/*'] },
      buildCtx(),
    );
    expect(r.ok).toBe(true);
    expect(store.getSetting('sites.blocklist')).toEqual([
      '*.tracking.com',
      'evil.com/*',
    ]);
  });

  it('accepts an enum[] subset for capture.enabledKinds', async () => {
    const r = await settingsSetHandler(
      { key: 'capture.enabledKinds', value: ['console', 'network'] },
      buildCtx(),
    );
    expect(r.ok).toBe(true);
    expect(store.getSetting('capture.enabledKinds')).toEqual([
      'console',
      'network',
    ]);
  });
});

describe('settings_set — rejection paths', () => {
  it('errorResponses for unknown keys', async () => {
    const r = await settingsSetHandler(
      { key: 'no.such.key', value: 1 },
      buildCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no.such.key');
    expect(r.next_steps.join(' ')).toMatch(/settings_list_schema/);
    // file should still not exist (no setSetting attempted)
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  it('rejects invalid number (negative) with schema-contextualized error', async () => {
    const r = await settingsSetHandler(
      { key: 'capture.memoryCutoffPerKind', value: -1 },
      buildCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("'capture.memoryCutoffPerKind'");
    expect(r.error).toContain('number');
    expect(r.next_steps.join(' ')).toMatch(/settings_list_schema/);
    expect(store.getSetting('capture.memoryCutoffPerKind')).toBe(5000); // unchanged
  });

  it('rejects invalid boolean (string)', async () => {
    const r = await settingsSetHandler(
      { key: 'capture.diskSpill.enabled', value: 'yes' },
      buildCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boolean');
  });

  it('rejects invalid string[] (non-array)', async () => {
    const r = await settingsSetHandler(
      { key: 'sites.allowlist', value: 'not-an-array' },
      buildCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('string[]');
  });

  it('rejects invalid enum[] (unknown kind) and surfaces enumValues hint', async () => {
    const r = await settingsSetHandler(
      { key: 'capture.enabledKinds', value: ['ooga'] },
      buildCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('enum[]');
    expect(r.error).toMatch(/console|network|dom_mutations|lifecycle/);
  });

  it('rejects invalid enum[] (duplicate elements)', async () => {
    const r = await settingsSetHandler(
      { key: 'capture.enabledKinds', value: ['console', 'console'] },
      buildCtx(),
    );
    expect(r.ok).toBe(false);
  });

  it('rejection does NOT write the file or change the in-memory value', async () => {
    await settingsSetHandler(
      { key: 'capture.memoryCutoffPerKind', value: -1 },
      buildCtx(),
    );
    // file should not exist (init didn't create one, rejection didn't either)
    await expect(readFile(path, 'utf-8')).rejects.toThrow();
    expect(store.getSetting('capture.memoryCutoffPerKind')).toBe(5000);
  });
});

describe('settings_set — persistence across simulated restart', () => {
  it('a value set via the tool is visible to a fresh store at the same path', async () => {
    const r = await settingsSetHandler(
      { key: 'capture.diskSpill.archiveLongevityDays', value: 30 },
      buildCtx(),
    );
    expect(r.ok).toBe(true);

    store.dispose();
    const store2 = createSettingsStore({ path, disableWatch: true });
    await store2.init();
    try {
      expect(store2.getSetting('capture.diskSpill.archiveLongevityDays')).toBe(30);
    } finally {
      store2.dispose();
    }
  });
});

describe('settings_set — MCP registry contract', () => {
  it('tool name and inputSchema match', () => {
    expect(settingsSetTool.name).toBe('settings_set');
    expect(Object.keys(settingsSetTool.inputSchema).sort()).toEqual([
      'key',
      'value',
    ]);
  });
});
