/**
 * Default user-data-dir resolution per OS — the profile dir passed to
 * --user-data-dir when spawning fresh in 'existing' mode.
 *
 * OS-modularized: one frozen row per browser per OS. Linux native is
 * first-class; macOS / Windows rows are present but unverified on a real
 * machine (see task 82). Linux SNAP confinement is handled: a snap browser
 * (execPath under /snap/) stores its profile at ~/snap/<snap>/common/<cfg>,
 * NOT ~/.config, so the native path would be wrong. Linux FLATPAK is handled
 * too: a flatpak browser (execPath is the slash-free app-id) stores its profile
 * at ~/.var/app/<app-id>/config/<cfg>, resolved against the shared LINUX_FLATPAK
 * table. Resolver returns null when it cannot resolve, so the orchestrator can
 * degrade with a clear message rather than spawn against the wrong profile.
 *
 * NOTE: the Linux segment data overlaps native-messaging/browser_paths
 * LINUX_NATIVE (both describe ~/.config/<browser>). A future consolidation
 * could lift a shared profile-dir resolver; kept separate for M15 to avoid
 * refactoring the NMH-install path. See evolution note.
 */
import { join } from 'node:path';
import {
  LINUX_FLATPAK,
  type BrowserName,
} from '../native-messaging/browser_paths.js';

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

/**
 * Linux snap confinement: profile lives under ~/snap/<snap>/common/<segments>.
 * Chromium is the canonical snap browser (verified on a real snap install);
 * the table is the seam for adding more snap-packaged browsers.
 */
type SnapRow = {
  readonly name: BrowserName;
  readonly snap: string;
  readonly segments: readonly string[];
};

const SNAP_PROFILE_DIRS: readonly SnapRow[] = Object.freeze([
  { name: 'chromium', snap: 'chromium', segments: Object.freeze(['chromium']) },
]);

const rowFor = (
  table: readonly SegmentRow[],
  browser: BrowserName,
): SegmentRow | undefined => table.find((r) => r.name === browser);

/** True when an execPath denotes a snap-packaged browser (e.g. /snap/bin/…). */
const isSnapExec = (execPath: string | undefined): boolean =>
  execPath !== undefined && execPath.includes('/snap/');

/**
 * True when `execPath` is actually a flatpak app-id rather than a real binary
 * path. Discovery sets execPath to the app-id for flatpak browsers; app-ids are
 * reverse-DNS (e.g. org.chromium.Chromium) and never contain a path separator,
 * so a non-empty, slash-free value is a flatpak app-id. A real exec path always
 * contains '/'.
 */
const isFlatpakExec = (execPath: string | undefined): boolean =>
  execPath !== undefined && execPath.length > 0 && !execPath.includes('/');

/** snap confined profile dir, or null when HOME is missing / browser unknown. */
const snapProfileDir = (
  browser: BrowserName,
  env: ProfileDirEnv,
): string | null => {
  const row = SNAP_PROFILE_DIRS.find((r) => r.name === browser);
  return row && env.HOME
    ? join(env.HOME, 'snap', row.snap, 'common', ...row.segments)
    : null;
};

/**
 * Flatpak profile dir: ~/.var/app/<app-id>/config/<configSegments>. Resolved by
 * app-id (the flatpak execPath) against LINUX_FLATPAK — the same table the NMH
 * install path and launch-side discovery use, so the app-id↔segment mapping
 * lives in exactly one place. Null when HOME is missing or the app-id is unknown.
 */
const flatpakProfileDir = (
  appId: string,
  env: ProfileDirEnv,
): string | null => {
  const row = LINUX_FLATPAK.find((r) => r.appId === appId);
  return row && env.HOME
    ? join(env.HOME, '.var', 'app', row.appId, 'config', ...row.configSegments)
    : null;
};

const linuxConfigRoot = (env: ProfileDirEnv): string | null => {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0)
    return env.XDG_CONFIG_HOME;
  if (env.HOME && env.HOME.length > 0) return join(env.HOME, '.config');
  return null;
};

/**
 * Resolve the browser's default user-data-dir, or null when unresolvable
 * (unsupported OS, missing env, or a browser absent from the table).
 *
 * `execPath` (the located browser binary) disambiguates Linux packaging: a
 * snap browser is confined to ~/snap/… so the native ~/.config path would be
 * wrong. Omitting it preserves the native-path behavior (back-compat).
 */
export const defaultUserDataDir = (
  browser: BrowserName,
  platform: NodeJS.Platform,
  env: ProfileDirEnv,
  execPath?: string,
): string | null => {
  if (platform === 'linux') {
    if (isSnapExec(execPath)) return snapProfileDir(browser, env);
    if (isFlatpakExec(execPath)) return flatpakProfileDir(execPath as string, env);
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
