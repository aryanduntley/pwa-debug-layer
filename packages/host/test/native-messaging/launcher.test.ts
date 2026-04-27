import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPosixLauncher,
  buildWindowsLauncher,
  defaultLauncherPath,
  writeLauncher,
} from '../../src/native-messaging/launcher.js';

describe('buildPosixLauncher', () => {
  it('emits #!/bin/sh + an exec line with both quoted paths', () => {
    const body = buildPosixLauncher({
      nodePath: '/usr/local/bin/node',
      mainJsPath: '/abs/dist/main.js',
    });
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(body).toContain("exec '/usr/local/bin/node' '/abs/dist/main.js' \"$@\"");
    expect(body.endsWith('\n')).toBe(true);
  });

  it('rejects single-quoted paths (POSIX shell quoting)', () => {
    expect(() =>
      buildPosixLauncher({ nodePath: "/bin/with'quote", mainJsPath: '/main.js' }),
    ).toThrow(/single quotes/);
    expect(() =>
      buildPosixLauncher({ nodePath: '/node', mainJsPath: "/path/with'q.js" }),
    ).toThrow(/single quotes/);
  });
});

describe('buildWindowsLauncher', () => {
  it('emits @echo off + double-quoted command with %* forwarding', () => {
    const body = buildWindowsLauncher({
      nodePath: 'C:\\nodejs\\node.exe',
      mainJsPath: 'C:\\app\\main.js',
    });
    expect(body.startsWith('@echo off\r\n')).toBe(true);
    expect(body).toContain('"C:\\nodejs\\node.exe" "C:\\app\\main.js" %*');
    expect(body.includes('\r\n')).toBe(true);
  });

  it('rejects double-quoted paths', () => {
    expect(() =>
      buildWindowsLauncher({ nodePath: 'C:\\bad"path\\node.exe', mainJsPath: 'C:\\m.js' }),
    ).toThrow(/double quotes/);
  });
});

describe('defaultLauncherPath', () => {
  it('uses XDG_CONFIG_HOME on linux when set', () => {
    expect(defaultLauncherPath('linux', { XDG_CONFIG_HOME: '/x' })).toBe(
      '/x/pwa-debug/bin/pwa-debug-host',
    );
  });

  it('falls back to HOME/.config on linux', () => {
    expect(defaultLauncherPath('linux', { HOME: '/h' })).toBe(
      '/h/.config/pwa-debug/bin/pwa-debug-host',
    );
  });

  it('uses APPDATA on win32', () => {
    expect(defaultLauncherPath('win32', { APPDATA: 'C:\\u\\Roaming' })).toBe(
      'C:\\u\\Roaming/pwa-debug/pwa-debug-host.bat',
    );
  });

  it('uses HOME on darwin', () => {
    expect(defaultLauncherPath('darwin', { HOME: '/h' })).toBe(
      '/h/.config/pwa-debug/bin/pwa-debug-host',
    );
  });

  it('throws on linux when HOME and XDG_CONFIG_HOME are both unset', () => {
    expect(() => defaultLauncherPath('linux', {})).toThrow(/HOME and XDG_CONFIG_HOME/);
  });

  it('throws on win32 when APPDATA is unset', () => {
    expect(() => defaultLauncherPath('win32', {})).toThrow(/APPDATA/);
  });
});

describe('writeLauncher', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pwa-debug-launcher-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a POSIX launcher and chmods 0755', async () => {
    const launcherPath = join(dir, 'bin', 'pwa-debug-host');
    const result = await writeLauncher(
      'linux',
      { nodePath: '/usr/local/bin/node', mainJsPath: '/abs/main.js' },
      launcherPath,
    );
    expect(result.launcherPath).toBe(launcherPath);
    const body = await readFile(launcherPath, 'utf-8');
    expect(body).toContain("exec '/usr/local/bin/node' '/abs/main.js' \"$@\"");
    const st = await stat(launcherPath);
    // Mode includes executable bits (& 0o111 should be non-zero on POSIX).
    expect(st.mode & 0o111).toBeGreaterThan(0);
  });

  it('writes a Windows launcher (no chmod)', async () => {
    const launcherPath = join(dir, 'pwa-debug-host.bat');
    const result = await writeLauncher(
      'win32',
      { nodePath: 'C:\\nodejs\\node.exe', mainJsPath: 'C:\\app\\main.js' },
      launcherPath,
    );
    expect(result.launcherPath).toBe(launcherPath);
    const body = await readFile(launcherPath, 'utf-8');
    expect(body).toContain('"C:\\nodejs\\node.exe" "C:\\app\\main.js" %*');
  });

  it('creates parent directories as needed', async () => {
    const launcherPath = join(dir, 'a', 'b', 'c', 'pwa-debug-host');
    await writeLauncher(
      'linux',
      { nodePath: '/n', mainJsPath: '/m' },
      launcherPath,
    );
    await expect(stat(launcherPath)).resolves.toBeTruthy();
  });
});
