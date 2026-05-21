/**
 * Per-OS browser-executable detection + platform dispatcher.
 *
 * Mirrors native-messaging/browser_paths.detectBrowserInstalls: one function
 * per OS, all selected by a single `discoverBinaries(platform, …)` dispatcher,
 * every effect injected via DiscoveryDeps. Adding an OS = add a detect* fn +
 * one dispatcher branch; the data lives in binary_table.ts.
 */
import { join } from 'node:path';
import {
  LINUX_BINARIES,
  MAC_BINARIES,
  WIN_BINARIES,
} from './binary_table.js';
import type {
  DiscoveredBrowser,
  DiscoveryDeps,
  EnvSnapshot,
} from './types.js';

/**
 * Linux: prefer a PATH hit (honours the user's real install + snap shims),
 * fall back to known absolute package paths. First hit per browser wins.
 */
const detectLinuxBinaries = async (
  deps: DiscoveryDeps,
): Promise<readonly DiscoveredBrowser[]> => {
  const out: DiscoveredBrowser[] = [];
  for (const entry of LINUX_BINARIES) {
    let resolved: DiscoveredBrowser | null = null;
    for (const name of entry.pathNames) {
      const execPath = await deps.which(name);
      if (execPath) {
        resolved = Object.freeze({
          browser: entry.name,
          execPath,
          source: 'path' as const,
          isDefault: false,
        });
        break;
      }
    }
    if (!resolved) {
      for (const p of entry.standardPaths) {
        if (await deps.fileExists(p)) {
          resolved = Object.freeze({
            browser: entry.name,
            execPath: p,
            source: 'standard-path' as const,
            isDefault: false,
          });
          break;
        }
      }
    }
    if (resolved) out.push(resolved);
  }
  return Object.freeze(out);
};

/** macOS: probe the absolute .app bundle exec path. Best-effort (deferred). */
const detectDarwinBinaries = async (
  deps: DiscoveryDeps,
): Promise<readonly DiscoveredBrowser[]> => {
  const out: DiscoveredBrowser[] = [];
  for (const entry of MAC_BINARIES) {
    if (await deps.fileExists(entry.execPath)) {
      out.push(
        Object.freeze({
          browser: entry.name,
          execPath: entry.execPath,
          source: 'standard-path' as const,
          isDefault: false,
        }),
      );
    }
  }
  return Object.freeze(out);
};

/** Windows: join each table row onto every available Program Files root. Best-effort (deferred). */
const detectWin32Binaries = async (
  env: EnvSnapshot,
  deps: DiscoveryDeps,
): Promise<readonly DiscoveredBrowser[]> => {
  const roots = [
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.LOCALAPPDATA,
  ].filter((r): r is string => typeof r === 'string' && r.length > 0);
  const out: DiscoveredBrowser[] = [];
  for (const entry of WIN_BINARIES) {
    let resolved: DiscoveredBrowser | null = null;
    for (const root of roots) {
      const execPath = join(root, ...entry.segments);
      if (await deps.fileExists(execPath)) {
        resolved = Object.freeze({
          browser: entry.name,
          execPath,
          source: 'standard-path' as const,
          isDefault: false,
        });
        break;
      }
    }
    if (resolved) out.push(resolved);
  }
  return Object.freeze(out);
};

/**
 * Locate every installed Chromium-family browser executable for the platform.
 * Unknown platforms return an empty list (no throw) so callers degrade
 * gracefully.
 */
export const discoverBinaries = async (
  platform: NodeJS.Platform,
  env: EnvSnapshot,
  deps: DiscoveryDeps,
): Promise<readonly DiscoveredBrowser[]> => {
  if (platform === 'linux') return detectLinuxBinaries(deps);
  if (platform === 'darwin') return detectDarwinBinaries(deps);
  if (platform === 'win32') return detectWin32Binaries(env, deps);
  return Object.freeze([]);
};
