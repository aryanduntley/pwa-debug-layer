/**
 * Snap-confinement native-messaging support.
 *
 * Snap chromium cannot use the normal $HOME launcher + node + ~/.config socket:
 * its AppArmor profile (snap.chromium.chromium) denies (a) exec of binaries
 * under $HOME and (b) connect() to a unix socket under ~/.config, and its base
 * runtime ships an older glibc than host-built binaries. Three clearances,
 * each live-verified in snap confinement (see milestone-54 notes):
 *   - exec IS allowed from ~/snap/<pkg>/common/ and of /usr/bin/python3;
 *   - /usr/bin/python3 runs under the snap runtime glibc and has AF_UNIX;
 *   - connect() to a unix socket UNDER ~/snap/<pkg>/common/ IS allowed.
 *
 * Because the NMH is a PURE byte relay (Chrome native-messaging framing and the
 * IPC socket framing are byte-identical — encodeIpcEnvelope === frameMessage),
 * the snap host is a ~20-line python3 script that pumps stdin<->the snap-common
 * unix socket. This module owns: where the snap host files live, the relay
 * source, the launcher that execs it, and the per-install snap socket paths the
 * MCP host additionally listens on.
 *
 * Single source of truth for snap package names: LINUX_SNAP in browser_paths.
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LINUX_SNAP, type BrowserName } from './browser_paths.js';

export type SnapHostEnv = { readonly HOME?: string };

/** Filename of the generated python relay under the snap host dir. */
export const SNAP_RELAY_FILENAME = 'snap_relay.py';
/** Filename of the generated snap launcher (the manifest `path` target). */
export const SNAP_LAUNCHER_FILENAME = 'pwa-debug-host-snap';
/** Basename of the per-snap IPC socket the MCP host also listens on. */
export const SNAP_SOCKET_FILENAME = 'mcp.sock';

/** ~/snap/<pkg>/common/pwa-debug — the snap-confinement-reachable host dir. */
export const snapHostDir = (
  snapPackage: string,
  env: SnapHostEnv,
): string | null =>
  env.HOME
    ? join(env.HOME, 'snap', snapPackage, 'common', 'pwa-debug')
    : null;

/** The snap package name for a browser, or null if it has no snap packaging. */
export const snapPackageForBrowser = (browser: BrowserName): string | null =>
  LINUX_SNAP.find((b) => b.name === browser)?.snapPackage ?? null;

/**
 * Sandbox-mode profile dir for a snap browser: ~/snap/<pkg>/common/pwa-debug-profile.
 * The normal sandbox dir (~/.pwa-debug/profiles/<browser>) is UNREACHABLE under
 * snap confinement — `.pwa-debug` is a hidden dir the snap home interface
 * excludes, so the browser exits instantly. The snap's own common dir is
 * writable from inside confinement. Null without HOME.
 */
export const snapSandboxProfileDir = (
  snapPackage: string,
  env: SnapHostEnv,
): string | null =>
  env.HOME
    ? join(env.HOME, 'snap', snapPackage, 'common', 'pwa-debug-profile')
    : null;

/** Absolute path of the per-snap IPC socket (under the snap-common host dir). */
export const snapSocketPath = (
  snapPackage: string,
  env: SnapHostEnv,
): string | null => {
  const dir = snapHostDir(snapPackage, env);
  return dir ? join(dir, SNAP_SOCKET_FILENAME) : null;
};

/**
 * The python3 relay source. Reads the target socket from PWA_DEBUG_SOCKET
 * (baked into the launcher), connects, SYNTHESIZES the IPC register frame from
 * the chrome-extension://<id>/ origin Chrome passes as argv (exactly like the
 * node NMH's nmh_mode + ipc_client — the register is NMH-generated, NOT sent by
 * the extension), then pumps stdin<->socket verbatim. After register, Chrome's
 * native-messaging frames and the host IPC frames are byte-identical (4-byte LE
 * len + JSON), so the rest is a pure byte relay. Uses /usr/bin/python3 from the
 * snap runtime (glibc-compatible, AppArmor-exec-allowed), never host node.
 */
export const buildSnapRelayScript = (): string =>
  [
    '#!/usr/bin/python3',
    '# pwa-debug snap native-messaging relay (generated at install time).',
    '# Synthesizes the register frame from the origin argv, then pumps',
    '# stdin<->the snap-common IPC unix socket (framing is byte-identical).',
    'import os, sys, socket, select, struct, json, re',
    'path = os.environ.get("PWA_DEBUG_SOCKET")',
    'if not path:',
    '    sys.stderr.write("pwa-debug snap relay: PWA_DEBUG_SOCKET unset\\n")',
    '    sys.exit(1)',
    '# Chrome passes the calling extension origin (chrome-extension://<id>/) in argv.',
    'ext = None',
    'for a in sys.argv[1:]:',
    '    m = re.match(r"^chrome-extension://([^/:]+)/?$", a)',
    '    if m:',
    '        ext = m.group(1)',
    '        break',
    'if not ext:',
    '    sys.stderr.write("pwa-debug snap relay: no chrome-extension origin in argv\\n")',
    '    sys.exit(1)',
    's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
    'try:',
    '    s.connect(path)',
    'except OSError as e:',
    '    sys.stderr.write("pwa-debug snap relay: connect failed: %s\\n" % e)',
    '    sys.exit(1)',
    '# Register frame (NMH-synthesized): 4-byte LE length + JSON body.',
    'reg = json.dumps({"type": "register", "extensionId": ext}).encode()',
    's.sendall(struct.pack("<I", len(reg)) + reg)',
    'stdin_fd = sys.stdin.fileno()',
    'out = sys.stdout.buffer',
    'stdin_open = True',
    'while True:',
    '    rlist = [s] + ([stdin_fd] if stdin_open else [])',
    '    r, _, _ = select.select(rlist, [], [])',
    '    if stdin_open and stdin_fd in r:',
    '        data = os.read(stdin_fd, 65536)',
    '        if data:',
    '            s.sendall(data)',
    '        else:',
    '            stdin_open = False',
    '            try:',
    '                s.shutdown(socket.SHUT_WR)',
    '            except OSError:',
    '                pass',
    '    if s in r:',
    '        chunk = s.recv(65536)',
    '        if not chunk:',
    '            break',
    '        out.write(chunk)',
    '        out.flush()',
    '',
  ].join('\n');

/**
 * The snap launcher (POSIX sh) that Chrome execs as the native host. Bakes the
 * snap-common socket path into PWA_DEBUG_SOCKET and execs /usr/bin/python3 on
 * the relay, forwarding Chrome's argv. Lives under the snap-common host dir so
 * AppArmor permits its exec. Mirrors the node launcher's single-quote safety.
 */
export const buildSnapLauncher = (
  relayPath: string,
  socketPath: string,
): string => {
  if (relayPath.includes("'") || socketPath.includes("'")) {
    throw new Error(
      'snap_host: relayPath/socketPath must not contain single quotes (POSIX shell quoting)',
    );
  }
  return [
    '#!/bin/sh',
    '# pwa-debug snap native messaging host launcher (generated at install time).',
    '# Execs the snap runtime python3 on the byte-relay; node is exec-denied and',
    '# glibc-incompatible under snap confinement.',
    `PWA_DEBUG_SOCKET='${socketPath}'`,
    'export PWA_DEBUG_SOCKET',
    `exec /usr/bin/python3 '${relayPath}' "$@"`,
    '',
  ].join('\n');
};

const atomicWrite = async (
  path: string,
  body: string,
  mode: number,
): Promise<void> => {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, body, 'utf-8');
  await rename(tmp, path);
  await chmod(path, mode);
};

export type SnapHostInstall = {
  readonly launcherPath: string;
  readonly relayPath: string;
  readonly socketPath: string;
};

/**
 * Install the snap native-messaging host files under ~/snap/<pkg>/common/pwa-debug:
 * the python relay (0644) and the launcher that execs it with the snap socket
 * baked in (0755). Returns the launcher path (the snap manifest's `path` target)
 * + the socket path, or null when HOME is unset. The only impure function here;
 * the install orchestrator composes it with the manifest writer.
 */
export const writeSnapHostFiles = async (
  snapPackage: string,
  env: SnapHostEnv,
): Promise<SnapHostInstall | null> => {
  const hostDir = snapHostDir(snapPackage, env);
  const socketPath = snapSocketPath(snapPackage, env);
  if (!hostDir || !socketPath) return null;
  const relayPath = join(hostDir, SNAP_RELAY_FILENAME);
  const launcherPath = join(hostDir, SNAP_LAUNCHER_FILENAME);
  await mkdir(hostDir, { recursive: true });
  await atomicWrite(relayPath, buildSnapRelayScript(), 0o644);
  await atomicWrite(launcherPath, buildSnapLauncher(relayPath, socketPath), 0o755);
  return Object.freeze({ launcherPath, relayPath, socketPath });
};

export type SnapSocketTarget = {
  readonly browser: BrowserName;
  readonly snapPackage: string;
  readonly socketPath: string;
};

/**
 * Per-installed-snap socket paths the MCP host must ALSO listen on (in addition
 * to the canonical ~/.config socket). A snap is "installed" iff its
 * ~/snap/<pkg>/common dir exists — cheap to check and avoids creating a
 * ~/snap tree for a snap that isn't present. Pure over the injected `exists`.
 */
export const installedSnapSocketTargets = async (
  env: SnapHostEnv,
  exists: (absPath: string) => Promise<boolean>,
): Promise<readonly SnapSocketTarget[]> => {
  if (!env.HOME) return Object.freeze([]);
  const out: SnapSocketTarget[] = [];
  for (const b of LINUX_SNAP) {
    const common = join(env.HOME, 'snap', b.snapPackage, 'common');
    if (await exists(common)) {
      const socketPath = join(common, 'pwa-debug', SNAP_SOCKET_FILENAME);
      out.push(
        Object.freeze({
          browser: b.name,
          snapPackage: b.snapPackage,
          socketPath,
        }),
      );
    }
  }
  return Object.freeze(out);
};
