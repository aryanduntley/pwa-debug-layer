/**
 * Sandbox profile-dir + extension-path resolution (pure).
 *
 * The persistent profile dir is deterministic (~/.pwa-debug/profiles/<browser>).
 * The extension path is picked from an ordered candidate list — env override,
 * a host-bundled location (populated by M17 packaging), then the monorepo
 * sibling for dev — choosing the first that actually holds a manifest.json.
 * All effects (HOME lookup, manifest existence) are passed in.
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

/** First candidate dir that holds a loadable extension (manifest.json), else null. */
export const pickExtensionPath = (
  candidates: readonly string[],
  hasManifest: (dir: string) => boolean,
): string | null => {
  for (const dir of candidates) {
    if (hasManifest(dir)) return dir;
  }
  return null;
};
