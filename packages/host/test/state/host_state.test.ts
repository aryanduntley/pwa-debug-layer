import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_STATE,
  defaultStatePath,
  loadHostState,
  saveHostState,
  addExtensionId,
  removeExtensionId,
  setManifestPaths,
  type HostState,
} from '../../src/state/host_state.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pwa-debug-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const samplePath = () => join(dir, 'state.json');

describe('defaultStatePath', () => {
  it('uses XDG_CONFIG_HOME when set', () => {
    expect(defaultStatePath({ XDG_CONFIG_HOME: '/x' })).toBe('/x/pwa-debug/state.json');
  });
  it('falls back to ~/.config when XDG_CONFIG_HOME is empty', () => {
    expect(defaultStatePath({ HOME: '/h' })).toBe('/h/.config/pwa-debug/state.json');
  });
  it('throws when neither HOME nor XDG_CONFIG_HOME is set', () => {
    expect(() => defaultStatePath({})).toThrow(/cannot resolve state path/);
  });
});

describe('loadHostState', () => {
  it('returns EMPTY_STATE when file is missing', async () => {
    const s = await loadHostState(samplePath());
    expect(s).toEqual(EMPTY_STATE);
  });

  it('parses a well-formed state file', async () => {
    const seed: HostState = {
      extensionIds: ['abc', 'def'],
      lastUpdated: '2026-04-26T22:00:00.000Z',
      lastInstalledManifestPaths: ['/p/a.json'],
    };
    await writeFile(samplePath(), JSON.stringify(seed), 'utf-8');
    expect(await loadHostState(samplePath())).toEqual(seed);
  });

  it('throws on malformed JSON', async () => {
    await writeFile(samplePath(), '{not-json', 'utf-8');
    await expect(loadHostState(samplePath())).rejects.toThrow();
  });

  it('throws on shape mismatch', async () => {
    await writeFile(samplePath(), JSON.stringify({ extensionIds: 'oops' }), 'utf-8');
    await expect(loadHostState(samplePath())).rejects.toThrow(/extensionIds/);
  });
});

describe('saveHostState round-trip', () => {
  it('saves and loads back identically', async () => {
    const s: HostState = {
      extensionIds: ['x'],
      lastUpdated: '2026-04-26T22:00:00.000Z',
      lastInstalledManifestPaths: ['/p/a.json', '/p/b.json'],
    };
    await saveHostState(samplePath(), s);
    expect(await loadHostState(samplePath())).toEqual(s);
  });

  it('creates parent directory if missing', async () => {
    const nested = join(dir, 'deep', 'nest', 'state.json');
    await saveHostState(nested, EMPTY_STATE);
    expect(await loadHostState(nested)).toEqual(EMPTY_STATE);
  });
});

describe('addExtensionId', () => {
  it('appends a new ID', () => {
    const s = addExtensionId(EMPTY_STATE, 'abc');
    expect(s.extensionIds).toEqual(['abc']);
  });
  it('returns the same instance when ID already present (no-op)', () => {
    const s1 = addExtensionId(EMPTY_STATE, 'abc');
    const s2 = addExtensionId(s1, 'abc');
    expect(s2).toBe(s1);
  });
});

describe('removeExtensionId', () => {
  it('removes an existing ID', () => {
    const s1 = addExtensionId(addExtensionId(EMPTY_STATE, 'a'), 'b');
    const s2 = removeExtensionId(s1, 'a');
    expect(s2.extensionIds).toEqual(['b']);
  });
  it('returns the same instance when ID is absent (no-op)', () => {
    const s = removeExtensionId(EMPTY_STATE, 'missing');
    expect(s).toBe(EMPTY_STATE);
  });
});

describe('setManifestPaths', () => {
  it('dedupes and sorts the paths', () => {
    const s = setManifestPaths(EMPTY_STATE, ['/b.json', '/a.json', '/b.json']);
    expect(s.lastInstalledManifestPaths).toEqual(['/a.json', '/b.json']);
  });
  it('replaces existing paths rather than merging', () => {
    const seed: HostState = { ...EMPTY_STATE, lastInstalledManifestPaths: ['/old.json'] };
    expect(setManifestPaths(seed, ['/new.json']).lastInstalledManifestPaths).toEqual(['/new.json']);
  });
});
