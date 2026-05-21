/**
 * System-default browser detection, per OS.
 *
 * Linux is first-class via `xdg-settings get default-web-browser`, whose
 * stdout (e.g. `google-chrome.desktop`) is mapped to a BrowserName through the
 * DESKTOP_TO_BROWSER table. macOS (`defaults read com.apple.LaunchServices`)
 * and Windows (HKCU UserChoice registry) are stubbed + deferred until those OS
 * targets are first-class — they return null today.
 *
 * All command execution is injected; a missing binary or non-zero exit is a
 * graceful null, never a throw.
 */
import { DESKTOP_TO_BROWSER } from './binary_table.js';
import type { BrowserName, DiscoveryDeps } from './types.js';

/** Map an xdg-settings .desktop id to a BrowserName, or null if non-Chromium. */
const desktopIdToBrowser = (raw: string): BrowserName | null => {
  const id = raw.trim().toLowerCase();
  if (id.length === 0) return null;
  for (const entry of DESKTOP_TO_BROWSER) {
    if (id.includes(entry.pattern)) return entry.name;
  }
  return null;
};

const detectDefaultLinux = async (
  deps: DiscoveryDeps,
): Promise<BrowserName | null> => {
  const { code, stdout } = await deps.runCommand('xdg-settings', [
    'get',
    'default-web-browser',
  ]);
  if (code !== 0) return null;
  return desktopIdToBrowser(stdout);
};

/** macOS default detection — deferred (see milestone M14 deferred note). */
const detectDarwinDefault = async (
  _deps: DiscoveryDeps,
): Promise<BrowserName | null> => null;

/** Windows default detection — deferred (see milestone M14 deferred note). */
const detectWin32Default = async (
  _deps: DiscoveryDeps,
): Promise<BrowserName | null> => null;

/**
 * Resolve the system-default web browser as a BrowserName, or null when it is
 * unknown, non-Chromium, or the OS path is not yet implemented.
 */
export const detectDefaultBrowser = async (
  platform: NodeJS.Platform,
  deps: DiscoveryDeps,
): Promise<BrowserName | null> => {
  if (platform === 'linux') return detectDefaultLinux(deps);
  if (platform === 'darwin') return detectDarwinDefault(deps);
  if (platform === 'win32') return detectWin32Default(deps);
  return null;
};
