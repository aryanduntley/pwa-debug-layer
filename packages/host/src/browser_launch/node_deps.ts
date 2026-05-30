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
import { defaultStatePath, loadHostState } from '../state/host_state.js';
import { defaultLauncherPath } from '../native-messaging/launcher.js';
import {
  buildHostManifest,
  writeHostManifestToDir,
  HOST_NAME,
  HOST_DESCRIPTION,
} from '../native-messaging/manifest_writer.js';
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
  persistentProfileDir,
  pickExtensionPath,
  type SandboxEnv,
} from './sandbox_paths.js';
import {
  snapPackageForBrowser,
  snapSandboxProfileDir,
  writeSnapHostFiles,
} from '../native-messaging/snap_host.js';
import type {
  BrowserName,
  LaunchDeps,
  LaunchSandboxDeps,
  SandboxMode,
  SpawnOutcome,
} from './types.js';
import type { Packaging } from '../browser_discovery/types.js';

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
 * Resolve a sandbox-mode profile dir, packaging-aware. Snap browsers cannot use
 * ~/.pwa-debug (a hidden dir the snap home interface blocks → the browser exits
 * instantly), so they route to ~/snap/<pkg>/common: a persistent
 * pwa-debug-profile dir, or a fresh mkdtemp under common for sandbox-temp. The
 * snap-common dir already exists (the snap is installed). Native/flatpak keep
 * the ~/.pwa-debug layout. Returns null when the dir can't be resolved.
 */
export const resolveSandboxProfileDir = (
  browser: BrowserName,
  mode: SandboxMode,
  packaging: Packaging,
  env: SandboxEnv,
): string | null => {
  if (packaging === 'snap') {
    const pkg = snapPackageForBrowser(browser);
    if (!pkg || !env.HOME) return null;
    if (mode === 'sandbox-temp') {
      const common = join(env.HOME, 'snap', pkg, 'common');
      return mkdtempSync(join(common, TEMP_PROFILE_PREFIX));
    }
    return snapSandboxProfileDir(pkg, env);
  }
  return mode === 'sandbox-temp'
    ? makeTempProfileDir()
    : persistentProfileDir(browser, env);
};

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

/**
 * Confined-browser sandbox manifest writer. Loads the registered extension IDs,
 * builds the host manifest, and writes it into <userDataDir>/NativeMessagingHosts/
 * so a flatpak/snap Chromium (which searches the user-data-dir, not the install
 * location) finds the host. The launcher the manifest points at depends on the
 * confinement: for SNAP, ensure the snap relay + launcher exist under
 * ~/snap/<pkg>/common (node is exec-denied + glibc-incompatible there) and point
 * at that launcher; otherwise (flatpak) point at the canonical node launcher.
 * No-op when no extension is registered (connectNative would be rejected anyway;
 * host_register_extension is the prerequisite).
 */
const writeSandboxManifestImpl = async (
  userDataDir: string,
  snapPackage?: string,
): Promise<void> => {
  const state = await loadHostState(defaultStatePath());
  if (state.extensionIds.length === 0) return;
  let hostBinaryPath: string;
  if (snapPackage !== undefined) {
    const snap = await writeSnapHostFiles(snapPackage, process.env);
    if (!snap) return;
    hostBinaryPath = snap.launcherPath;
  } else {
    hostBinaryPath = defaultLauncherPath(process.platform, process.env);
  }
  const manifest = buildHostManifest({
    name: HOST_NAME,
    description: HOST_DESCRIPTION,
    hostBinaryPath,
    allowedExtensionIds: state.extensionIds,
  });
  await writeHostManifestToDir(manifest, join(userDataDir, 'NativeMessagingHosts'));
};

/** Production LaunchSandboxDeps: probe + spawn reused, temp dirs auto-tracked. */
export const defaultSandboxDeps = (): LaunchSandboxDeps =>
  Object.freeze({
    probeDebugPort: probeDebugPortImpl,
    spawnBrowser: spawnBrowserImpl,
    registerTempProfile: (dir: string) => getTempRegistry().register(dir),
    writeSandboxManifest: writeSandboxManifestImpl,
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

// ── pdl_close_browser effects ──────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll the debug port until it stops answering (browser gone) or attempts run out. */
const waitForPortDown = async (
  port: number,
  attempts: number,
): Promise<boolean> => {
  for (let i = 0; i < attempts; i += 1) {
    if (!(await probeDebugPortImpl(port))) return true;
    await sleep(250);
  }
  return !(await probeDebugPortImpl(port));
};

/** Read the browser-level CDP WebSocket URL from /json/version (null if absent). */
const fetchBrowserWsUrl = async (port: number): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      webSocketDebuggerUrl?: unknown;
    } | null;
    const url = body?.webSocketDebuggerUrl;
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Canonical graceful quit: connect the browser CDP WebSocket and send
 * Browser.close. The browser exits cleanly (no crash-restore bubble) and the
 * socket closes. Resolves true once the socket closes, false on error/timeout.
 * Uses Node's global WebSocket (Node >= 22).
 */
const cdpBrowserClose = (wsUrl: string): Promise<boolean> =>
  new Promise((resolveP) => {
    let settled = false;
    const finish = (v: boolean): void => {
      if (!settled) {
        settled = true;
        resolveP(v);
      }
    };
    try {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        finish(false);
      }, 2000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      });
      // Browser.close makes the browser exit → the socket closes: that's success.
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        finish(true);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        finish(false);
      });
    } catch {
      finish(false);
    }
  });

export type TerminateOutcome = {
  readonly closed: boolean;
  readonly method: 'already-down' | 'cdp' | 'sigterm' | 'sigkill' | 'failed';
};

/**
 * Stop a managed launch, preferring a clean shutdown:
 *  1. port already down → already-down (idempotent).
 *  2. CDP Browser.close over the WebSocket → clean quit, no restore bubble.
 *  3. SIGTERM the spawned pid (graceful) → 4. SIGKILL last resort.
 * Each step waits for the debug port to go down before reporting success.
 */
export const terminateManagedBrowserImpl = async (
  record: LaunchRecord,
): Promise<TerminateOutcome> => {
  if (!(await probeDebugPortImpl(record.port))) {
    return { closed: true, method: 'already-down' };
  }
  const wsUrl = await fetchBrowserWsUrl(record.port);
  if (wsUrl) {
    await cdpBrowserClose(wsUrl);
    if (await waitForPortDown(record.port, 8)) {
      return { closed: true, method: 'cdp' };
    }
  }
  if (record.pid !== null) {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    if (await waitForPortDown(record.port, 8)) {
      return { closed: true, method: 'sigterm' };
    }
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    if (await waitForPortDown(record.port, 8)) {
      return { closed: true, method: 'sigkill' };
    }
  }
  return { closed: false, method: 'failed' };
};

/** Regex-escape a string for safe use as a pgrep -f pattern. */
const escapeForPgrep = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when any process still has `dir` in its command line — i.e. a browser
 * instance is still using this profile. Uses pgrep -f over the escaped path.
 * pgrep exits 1 (→ err) when nothing matches; treat that as not-referenced.
 */
const profileDirReferenced = (dir: string): Promise<boolean> =>
  new Promise((resolveP) => {
    execFile('pgrep', ['-f', escapeForPgrep(dir)], (err, stdout) => {
      if (err) return resolveP(false);
      resolveP(stdout.trim().length > 0);
    });
  });

/** Poll until no process references the profile dir (browser fully exited) or attempts run out. */
const waitForProfileReleased = async (
  dir: string,
  attempts: number,
): Promise<void> => {
  for (let i = 0; i < attempts; i += 1) {
    if (!(await profileDirReferenced(dir))) return;
    await sleep(250);
  }
};

/**
 * Remove a sandbox profile dir, GUARDED: only paths under ~/.pwa-debug/profiles
 * or an os.tmpdir() entry with the sandbox-temp prefix are eligible — defense in
 * depth so a bad caller can never rm an arbitrary (e.g. user-profile) dir.
 *
 * A clean CDP Browser.close drops the debug port early, but the browser's child
 * processes keep flushing the profile to disk for a few seconds after — an
 * immediate rmSync races those writes and the dir gets repopulated. So we first
 * wait until no process still references the dir (the browser has fully exited),
 * then delete and re-check once. Returns true only when the dir is actually gone.
 */
export const discardProfileDirImpl = async (dir: string): Promise<boolean> => {
  const resolved = resolve(dir);
  const underPwaProfiles = resolved.includes(join('.pwa-debug', 'profiles'));
  const isTempProfile =
    dirname(resolved) === resolve(tmpdir()) &&
    basename(resolved).startsWith(TEMP_PROFILE_PREFIX);
  if (!underPwaProfiles && !isTempProfile) return false;
  await waitForProfileReleased(resolved, 40); // up to ~10s for graceful shutdown
  try {
    rmSync(resolved, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  // A final shutdown write can race the delete; retry once if it reappeared.
  if (existsSync(resolved)) {
    await sleep(250);
    try {
      rmSync(resolved, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  return !existsSync(resolved);
};

/** Whether chrome-devtools-mcp is registered with Claude Code, and the
 *  --browserUrl it is configured to attach to (null if registered without one
 *  or if the arg can't be parsed). */
export type ChromeDevtoolsRegistration = {
  readonly registered: boolean;
  readonly browserUrl: string | null;
};

const BROWSER_URL_ARG_RE = /--browserUrl(?:[=\s]+)(\S+)/;

/**
 * Read the REAL chrome-devtools-mcp registration from Claude Code via
 * `claude mcp get chrome-devtools`. A zero exit means it is registered; the
 * configured --browserUrl is regex-extracted from the (human-readable) output.
 * This MCP is Claude-Code-targeted, so the `claude` CLI is the source of truth —
 * we deliberately do NOT fall back to parsing ~/.claude.json. Never rejects:
 * returns { registered: false } when `claude` is absent, errors, or times out.
 */
export const readChromeDevtoolsRegistration =
  (): Promise<ChromeDevtoolsRegistration> =>
    new Promise((resolveP) => {
      execFile(
        'claude',
        ['mcp', 'get', 'chrome-devtools'],
        { timeout: 10_000 },
        (err, stdout) => {
          if (err) {
            resolveP({ registered: false, browserUrl: null });
            return;
          }
          const match = BROWSER_URL_ARG_RE.exec(stdout ?? '');
          resolveP({ registered: true, browserUrl: match?.[1] ?? null });
        },
      );
    });

/** Outcome of a `claude mcp ...` mutation. Never throws; carries stderr on failure. */
export type ClaudeMcpResult = {
  readonly ok: boolean;
  readonly error: string | null;
};

const runClaudeMcp = (args: readonly string[]): Promise<ClaudeMcpResult> =>
  new Promise((resolveP) => {
    execFile('claude', [...args], { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr ?? '').trim() || err.message;
        resolveP({ ok: false, error: detail });
        return;
      }
      resolveP({ ok: true, error: null });
    });
  });

/**
 * Register chrome-devtools-mcp with Claude Code (user scope) pointed at the
 * given CDP browserUrl, via `claude mcp add`. This writes a DIRECT MCP
 * registration — Claude Code must be restarted for the new server to load.
 */
export const addChromeDevtoolsRegistration = (
  browserUrl: string,
): Promise<ClaudeMcpResult> =>
  runClaudeMcp([
    'mcp',
    'add',
    'chrome-devtools',
    '--scope',
    'user',
    '--',
    'npx',
    '-y',
    'chrome-devtools-mcp@latest',
    '--browserUrl',
    browserUrl,
  ]);

/** Remove the chrome-devtools-mcp registration via `claude mcp remove`. */
export const removeChromeDevtoolsRegistration = (): Promise<ClaudeMcpResult> =>
  runClaudeMcp(['mcp', 'remove', 'chrome-devtools']);

const EXTENSION_URL_RE = /^chrome-extension:\/\/([a-p]{32})\//;

/**
 * GET /json/list on a live debug port and return the distinct extension IDs of
 * loaded MV3 service-worker targets (an extension surfaces its SW here once
 * loaded). Lets the host spot an extension that is loaded in a managed browser
 * but whose ID is not whitelisted in allowed_origins — the failure mode where
 * the SW loads yet connectNative is rejected. Never rejects: returns [] on any
 * error, a dead port, or a non-array body.
 */
export const fetchLoadedExtensionIds = async (
  port: number,
): Promise<readonly string[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as unknown;
    if (!Array.isArray(body)) return [];
    const ids = new Set<string>();
    for (const target of body) {
      if (
        target === null ||
        typeof target !== 'object' ||
        (target as { type?: unknown }).type !== 'service_worker'
      ) {
        continue;
      }
      const url = (target as { url?: unknown }).url;
      if (typeof url !== 'string') continue;
      const id = EXTENSION_URL_RE.exec(url)?.[1];
      if (id) ids.add(id);
    }
    return [...ids];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

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
