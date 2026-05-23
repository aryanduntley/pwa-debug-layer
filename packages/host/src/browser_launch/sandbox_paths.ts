/**
 * Sandbox profile-dir + extension-path resolution (pure).
 *
 * The persistent profile dir is deterministic (~/.pwa-debug/profiles/<browser>).
 * The extension path is picked from an ordered candidate list — env override,
 * a host-bundled location (populated by M17 packaging), then the monorepo
 * sibling for dev — choosing the first that holds a LOADABLE unpacked extension
 * (manifest.json AND a built entry script). The built-script check is what
 * keeps the picker from selecting the extension SOURCE root, which carries a
 * manifest.json but none of the rollup output it references (Chromium then
 * fails the load with "Could not load javascript 'content-script.js'").
 * All effects (HOME lookup, file existence) are passed in.
 */
import { join } from 'node:path';
import type { BrowserName } from '../native-messaging/browser_paths.js';

export type SandboxEnv = {
  readonly HOME?: string;
  readonly PWA_DEBUG_EXTENSION_PATH?: string;
};

/** Per-browser subdir under the sandbox profile root. */
const PROFILE_SUBDIR: Readonly<Record<BrowserName, string>> = Object.freeze({
  chrome: 'chrome',
  chromium: 'chromium',
  edge: 'edge',
  brave: 'brave',
  vivaldi: 'vivaldi',
  opera: 'opera',
});

/** ~/.pwa-debug/profiles/<browser> — stable across host restarts, or null without HOME. */
export const persistentProfileDir = (
  browser: BrowserName,
  env: SandboxEnv,
): string | null =>
  env.HOME && env.HOME.length > 0
    ? join(env.HOME, '.pwa-debug', 'profiles', PROFILE_SUBDIR[browser])
    : null;

/**
 * Ordered extension-dir candidates, most-authoritative first:
 *   1. PWA_DEBUG_EXTENSION_PATH (explicit override)
 *   2. <hostDir>/extension (host-bundled dist — populated by M17 packaging)
 *   3. <hostDir>/../extension/dist (monorepo sibling, dev)
 */
export const defaultExtensionCandidates = (
  env: SandboxEnv,
  hostDir: string,
): readonly string[] => {
  const out: string[] = [];
  if (env.PWA_DEBUG_EXTENSION_PATH && env.PWA_DEBUG_EXTENSION_PATH.length > 0) {
    out.push(env.PWA_DEBUG_EXTENSION_PATH);
  }
  out.push(join(hostDir, 'extension'));
  out.push(join(hostDir, '..', 'extension', 'dist'));
  return Object.freeze(out);
};

/**
 * Files that must BOTH exist for a dir to be a loadable unpacked extension: the
 * manifest and a built entry script. Requiring the script rejects the extension
 * source root (manifest.json present, rollup output absent) — the trap that made
 * the launcher preload a dir Chromium couldn't actually load.
 */
export const REQUIRED_EXTENSION_FILES: readonly string[] = Object.freeze([
  'manifest.json',
  'content-script.js',
]);

/** True when `dir` holds every REQUIRED_EXTENSION_FILES entry (existence injected). */
export const isLoadableExtensionDir = (
  dir: string,
  exists: (path: string) => boolean,
): boolean => REQUIRED_EXTENSION_FILES.every((f) => exists(join(dir, f)));

/** First candidate dir that holds a loadable unpacked extension, else null. */
export const pickExtensionPath = (
  candidates: readonly string[],
  isLoadable: (dir: string) => boolean,
): string | null => {
  for (const dir of candidates) {
    if (isLoadable(dir)) return dir;
  }
  return null;
};
