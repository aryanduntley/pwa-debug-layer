/**
 * The impure edge: real LaunchDeps backed by fetch + node:child_process.
 * Isolated from all decision logic so launch_existing stays pure + testable.
 */
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdgConfigPath } from '../host_io/host_io.js';
import {
  TEMP_PROFILE_PREFIX,
  createTempCleanupRegistry,
  filterTempProfileNames,
  type TempCleanupRegistry,
} from './cleanup.js';
import {
  createLaunchRegistry,
  parseLaunchRecords,
  type LaunchRecord,
  type LaunchRegistry,
} from './registry.js';
import {
  defaultExtensionCandidates,
  isLoadableExtensionDir,
  pickExtensionPath,
  type SandboxEnv,
} from './sandbox_paths.js';
import type {
  BrowserName,
  LaunchDeps,
  LaunchSandboxDeps,
  SpawnOutcome,
} from './types.js';

const PROBE_TIMEOUT_MS = 800;

/** GET /json/version on the debug port; a 2xx JSON body means the port is live. */
const probeDebugPortImpl = async (port: number): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as unknown;
    return body !== null && typeof body === 'object';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** pgrep -f the executable basename; exit 0 with output means it is running. */
const isProcessRunningImpl = (
  _browser: BrowserName,
  execPath: string,
): Promise<boolean> =>
  new Promise((resolve) => {
    execFile('pgrep', ['-f', basename(execPath)], (err, stdout) => {
      // pgrep exits 1 (→ err) when no process matches; treat as not-running.
      if (err) return resolve(false);
      resolve(stdout.trim().length > 0);
    });
  });

/** Spawn detached + unref so the browser outlives the host process. */
const spawnBrowserImpl = (
  cmd: string,
  args: readonly string[],
): Promise<SpawnOutcome> =>
  new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd, [...args], {
        detached: true,
        stdio: 'ignore',
      });
      // Surface synchronous spawn failures (e.g. ENOENT) before unref/resolve.
      child.once('error', reject);
      const pid = child.pid ?? null;
      child.unref();
      resolve({ pid });
    } catch (e) {
      reject(e as Error);
    }
  });

/** Production LaunchDeps wiring real OS effects. */
export const defaultLaunchDeps = (): LaunchDeps =>
  Object.freeze({
    probeDebugPort: probeDebugPortImpl,
    isProcessRunning: isProcessRunningImpl,
    spawnBrowser: spawnBrowserImpl,
  });

/** Create a fresh mkdtemp profile dir for a sandbox-temp launch. */
export const makeTempProfileDir = (): string =>
  mkdtempSync(join(tmpdir(), TEMP_PROFILE_PREFIX));

/**
 * Absolute paths of sandbox-temp profile dirs lingering under os.tmpdir() from
 * a previous run. Graceful shutdown removes its own, so any survivors imply a
 * crash/SIGKILL. Warn-only at boot: mkdtemp names don't identify the owning
 * host process, so auto-removal could delete a concurrently-running host's
 * active profile. Never throws (a missing/unreadable tmpdir yields []).
 */
export const findLingeringTempProfiles = (): readonly string[] => {
  try {
    const base = tmpdir();
    return filterTempProfileNames(readdirSync(base)).map((n) => join(base, n));
  } catch {
    return [];
  }
};

// Lazy module-singleton temp-cleanup registry: created on first sandbox-temp
// launch, with process signal handlers installed exactly once.
let tempRegistry: TempCleanupRegistry | null = null;

const getTempRegistry = (): TempCleanupRegistry => {
  if (tempRegistry) return tempRegistry;
  const registry = createTempCleanupRegistry({
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  });
  const onSignal = (): void => {
    registry.cleanupAll();
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', () => registry.cleanupAll());
  tempRegistry = registry;
  return registry;
};

/**
 * Absolute host-package root. The host bundles to a single packages/host/dist/
 * main.js, so this module's dir is packages/host/dist — ONE level below the
 * package root. (The earlier '..','..' overshot to packages/, making the
 * candidate `<pkg>/extension` resolve to the extension SOURCE root.)
 */
const hostPackageDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve the unpacked extension dir to preload, or null when none is found. */
export const resolveExtensionPath = (env: SandboxEnv): string | null =>
  pickExtensionPath(defaultExtensionCandidates(env, hostPackageDir()), (dir) =>
    isLoadableExtensionDir(dir, (p) => existsSync(p)),
  );

/** Production LaunchSandboxDeps: probe + spawn reused, temp dirs auto-tracked. */
export const defaultSandboxDeps = (): LaunchSandboxDeps =>
  Object.freeze({
    probeDebugPort: probeDebugPortImpl,
    spawnBrowser: spawnBrowserImpl,
    registerTempProfile: (dir: string) => getTempRegistry().register(dir),
  });

// Lazy module-singleton launch registry, persisted to launches.json beside the
// host config so pdl_browser_status survives a host restart.
let launchRegistry: LaunchRegistry | null = null;

/** Path to the persisted launch registry (dedicated file, not state.json). */
const launchesStatePath = (): string => xdgConfigPath('launches.json');

/** Read persisted launches; any error (missing/corrupt/no-HOME) → []. */
const loadPersistedLaunches = (): readonly LaunchRecord[] => {
  try {
    return parseLaunchRecords(
      JSON.parse(readFileSync(launchesStatePath(), 'utf-8')),
    );
  } catch {
    return [];
  }
};

/** Crash-safe write of the launch registry; best-effort (never throws). */
const persistLaunches = (records: readonly LaunchRecord[]): void => {
  try {
    const path = launchesStatePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // best-effort; a failed persist must never break the launch path.
  }
};

/** The host-process launch registry (created on first use). */
export const getLaunchRegistry = (): LaunchRegistry => {
  if (!launchRegistry) {
    launchRegistry = createLaunchRegistry({
      now: Date.now,
      load: loadPersistedLaunches,
      persist: persistLaunches,
    });
  }
  return launchRegistry;
};

/** True when `npx chrome-devtools-mcp --version` succeeds. Never rejects. */
export const probeChromeDevtoolsVersion = (): Promise<boolean> =>
  new Promise((resolveP) => {
    execFile(
      'npx',
      ['--no-install', 'chrome-devtools-mcp', '--version'],
      { timeout: 10_000 },
      (err) => resolveP(!err),
    );
  });

/** Recursively copy the unpacked extension dir to a destination. */
export const copyDir = (src: string, dest: string): Promise<void> =>
  cp(src, dest, { recursive: true });

/** Default install target: ~/Downloads/pwa-debug-extension (or HOME fallback). */
export const defaultExtensionTargetDir = (
  env: { HOME?: string } = process.env,
): string => {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : '.';
  return join(home, 'Downloads', 'pwa-debug-extension');
};
