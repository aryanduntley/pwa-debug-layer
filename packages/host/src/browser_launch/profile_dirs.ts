/**
 * Default user-data-dir resolution per OS — the profile dir passed to
 * --user-data-dir when spawning fresh in 'existing' mode.
 *
 * OS-modularized: one frozen row per browser per OS. Linux native is
 * first-class; macOS / Windows rows are present but the targets are deferred
 * (consistent with browser_discovery's M14 posture), and Linux snap/flatpak
 * confined profile dirs are deferred (they live outside ~/.config and need
 * per-package handling). Resolver returns null when it cannot resolve, so the
 * orchestrator can degrade with a clear message.
 *
 * NOTE: the Linux segment data overlaps native-messaging/browser_paths
 * LINUX_NATIVE (both describe ~/.config/<browser>). A future consolidation
 * could lift a shared profile-dir resolver; kept separate for M15 to avoid
 * refactoring the NMH-install path. See evolution note.
 */
import { join } from 'node:path';
import type { BrowserName } from '../native-messaging/browser_paths.js';

export type ProfileDirEnv = {
  readonly HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly LOCALAPPDATA?: string;
};

type SegmentRow = { readonly name: BrowserName; readonly segments: readonly string[] };

/** Linux: <config>/<segments> (config = XDG_CONFIG_HOME or HOME/.config). */
const LINUX_PROFILE_DIRS: readonly SegmentRow[] = Object.freeze([
  { name: 'chrome', segments: Object.freeze(['google-chrome']) },
  { name: 'chromium', segments: Object.freeze(['chromium']) },
  { name: 'edge', segments: Object.freeze(['microsoft-edge']) },
  { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
  { name: 'vivaldi', segments: Object.freeze(['vivaldi']) },
  { name: 'opera', segments: Object.freeze(['opera']) },
]);

/** macOS: ~/Library/Application Support/<segments> (deferred — best-effort). */
const MAC_PROFILE_DIRS: readonly SegmentRow[] = Object.freeze([
  { name: 'chrome', segments: Object.freeze(['Google', 'Chrome']) },
  { name: 'chromium', segments: Object.freeze(['Chromium']) },
  { name: 'edge', segments: Object.freeze(['Microsoft Edge']) },
  { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
  { name: 'vivaldi', segments: Object.freeze(['Vivaldi']) },
  { name: 'opera', segments: Object.freeze(['com.operasoftware.Opera']) },
]);

/** Windows: %LOCALAPPDATA%/<segments>/User Data (deferred — best-effort). */
const WIN_PROFILE_DIRS: readonly SegmentRow[] = Object.freeze([
  { name: 'chrome', segments: Object.freeze(['Google', 'Chrome']) },
  { name: 'chromium', segments: Object.freeze(['Chromium']) },
  { name: 'edge', segments: Object.freeze(['Microsoft', 'Edge']) },
  { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
  { name: 'vivaldi', segments: Object.freeze(['Vivaldi']) },
  { name: 'opera', segments: Object.freeze(['Opera Software', 'Opera Stable']) },
]);

const rowFor = (
  table: readonly SegmentRow[],
  browser: BrowserName,
): SegmentRow | undefined => table.find((r) => r.name === browser);

const linuxConfigRoot = (env: ProfileDirEnv): string | null => {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0)
    return env.XDG_CONFIG_HOME;
  if (env.HOME && env.HOME.length > 0) return join(env.HOME, '.config');
  return null;
};

/**
 * Resolve the browser's default user-data-dir, or null when unresolvable
 * (unsupported OS, missing env, or a browser absent from the table).
 */
export const defaultUserDataDir = (
  browser: BrowserName,
  platform: NodeJS.Platform,
  env: ProfileDirEnv,
): string | null => {
  if (platform === 'linux') {
    const row = rowFor(LINUX_PROFILE_DIRS, browser);
    const root = linuxConfigRoot(env);
    return row && root ? join(root, ...row.segments) : null;
  }
  if (platform === 'darwin') {
    const row = rowFor(MAC_PROFILE_DIRS, browser);
    return row && env.HOME
      ? join(env.HOME, 'Library', 'Application Support', ...row.segments)
      : null;
  }
  if (platform === 'win32') {
    const row = rowFor(WIN_PROFILE_DIRS, browser);
    return row && env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, ...row.segments, 'User Data')
      : null;
  }
  return null;
};
