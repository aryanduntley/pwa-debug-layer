import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSnapLauncher,
  buildSnapRelayScript,
  installedSnapSocketTargets,
  snapHostDir,
  snapPackageForBrowser,
  snapSandboxProfileDir,
  snapSocketPath,
  writeSnapHostFiles,
  SNAP_RELAY_FILENAME,
  SNAP_LAUNCHER_FILENAME,
} from '../../src/native-messaging/snap_host.js';

describe('snapHostDir / snapSocketPath', () => {
  it('resolves ~/snap/<pkg>/common/pwa-debug and the socket beneath it', () => {
    expect(snapHostDir('chromium', { HOME: '/h' })).toBe(
      '/h/snap/chromium/common/pwa-debug',
    );
    expect(snapSocketPath('chromium', { HOME: '/h' })).toBe(
      '/h/snap/chromium/common/pwa-debug/mcp.sock',
    );
  });
  it('returns null without HOME', () => {
    expect(snapHostDir('chromium', {})).toBeNull();
    expect(snapSocketPath('chromium', {})).toBeNull();
  });
});

describe('snapPackageForBrowser', () => {
  it('maps chromium to its snap package', () => {
    expect(snapPackageForBrowser('chromium')).toBe('chromium');
  });
  it('returns null for a browser with no snap packaging', () => {
    expect(snapPackageForBrowser('brave')).toBeNull();
  });
});

describe('snapSandboxProfileDir', () => {
  it('routes under ~/snap/<pkg>/common (NOT the snap-blocked ~/.pwa-debug)', () => {
    expect(snapSandboxProfileDir('chromium', { HOME: '/h' })).toBe(
      '/h/snap/chromium/common/pwa-debug-profile',
    );
  });
  it('returns null without HOME', () => {
    expect(snapSandboxProfileDir('chromium', {})).toBeNull();
  });
});

describe('buildSnapRelayScript', () => {
  it('is a python3 relay that registers from the origin argv then pumps', () => {
    const src = buildSnapRelayScript();
    expect(src.startsWith('#!/usr/bin/python3')).toBe(true);
    expect(src).toContain('PWA_DEBUG_SOCKET');
    expect(src).toContain('AF_UNIX');
    expect(src).toContain('select.select');
    // synthesizes the register frame from the chrome-extension origin argv
    expect(src).toContain('chrome-extension://');
    expect(src).toContain('"type": "register"');
    expect(src).toContain('struct.pack("<I", len(reg))');
    // then pumps both directions
    expect(src).toContain('s.sendall(data)');
    expect(src).toContain('out.write(chunk)');
  });
});

describe('buildSnapLauncher', () => {
  it('bakes the socket and execs python3 on the relay', () => {
    const body = buildSnapLauncher('/h/snap/chromium/common/pwa-debug/snap_relay.py', '/h/snap/chromium/common/pwa-debug/mcp.sock');
    expect(body.startsWith('#!/bin/sh')).toBe(true);
    expect(body).toContain("PWA_DEBUG_SOCKET='/h/snap/chromium/common/pwa-debug/mcp.sock'");
    expect(body).toContain('export PWA_DEBUG_SOCKET');
    expect(body).toContain(
      "exec /usr/bin/python3 '/h/snap/chromium/common/pwa-debug/snap_relay.py' \"$@\"",
    );
  });
  it('rejects single-quoted paths (POSIX shell quoting)', () => {
    expect(() => buildSnapLauncher("/r'x.py", '/s.sock')).toThrow(/single quotes/);
    expect(() => buildSnapLauncher('/r.py', "/s'x.sock")).toThrow(/single quotes/);
  });
});

describe('writeSnapHostFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pwa-debug-snaphost-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes an executable launcher (0755) + readable relay under <home>/snap/<pkg>/common/pwa-debug', async () => {
    const result = await writeSnapHostFiles('chromium', { HOME: dir });
    expect(result).not.toBeNull();
    const hostDir = join(dir, 'snap', 'chromium', 'common', 'pwa-debug');
    expect(result?.launcherPath).toBe(join(hostDir, SNAP_LAUNCHER_FILENAME));
    expect(result?.relayPath).toBe(join(hostDir, SNAP_RELAY_FILENAME));
    expect(result?.socketPath).toBe(join(hostDir, 'mcp.sock'));

    const launcherStat = await stat(result!.launcherPath);
    expect(launcherStat.mode & 0o111).toBeGreaterThan(0); // executable
    const launcherBody = await readFile(result!.launcherPath, 'utf-8');
    expect(launcherBody).toContain(`PWA_DEBUG_SOCKET='${result!.socketPath}'`);

    const relayBody = await readFile(result!.relayPath, 'utf-8');
    expect(relayBody.startsWith('#!/usr/bin/python3')).toBe(true);
  });

  it('returns null without HOME', async () => {
    expect(await writeSnapHostFiles('chromium', {})).toBeNull();
  });
});

describe('installedSnapSocketTargets', () => {
  it('includes a target for each snap whose common dir exists', async () => {
    const present = new Set(['/h/snap/chromium/common']);
    const targets = await installedSnapSocketTargets(
      { HOME: '/h' },
      async (p) => present.has(p),
    );
    expect(targets.map((t) => t.socketPath)).toEqual([
      '/h/snap/chromium/common/pwa-debug/mcp.sock',
    ]);
    expect(targets[0]?.snapPackage).toBe('chromium');
  });
  it('returns empty when no snap common dirs exist', async () => {
    expect(
      await installedSnapSocketTargets({ HOME: '/h' }, async () => false),
    ).toEqual([]);
  });
  it('returns empty without HOME', async () => {
    expect(
      await installedSnapSocketTargets({}, async () => true),
    ).toEqual([]);
  });
});
