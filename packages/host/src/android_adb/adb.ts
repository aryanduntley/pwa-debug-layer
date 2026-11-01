import type { AdbDeps } from './node_deps.js';
import {
  adbPathCandidates,
  classifyAdbFailure,
  parseDevices,
  parseDevtoolsSockets,
  parseForwards,
  type AdbDevice,
  type AdbFailureKind,
  type AdbForward,
  type DevtoolsSocket,
} from './parse.js';

export type AdbResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: AdbFailureKind; readonly message: string };

/** A located adb binary plus the effects to run it. */
export type AdbContext = {
  readonly adbPath: string;
  readonly deps: AdbDeps;
};

const ok = <T>(value: T): AdbResult<T> => Object.freeze({ ok: true as const, value });
const fail = <T>(kind: AdbFailureKind, message: string): AdbResult<T> =>
  Object.freeze({ ok: false as const, kind, message });

/** Run adb; a non-zero exit becomes a classified failure. */
const run = async (adb: AdbContext, args: readonly string[]): Promise<AdbResult<string>> => {
  const r = await adb.deps.run(adb.adbPath, args);
  if (r.code === 0) return ok(r.stdout);
  const output = `${r.stderr}\n${r.stdout}`.trim();
  return fail(classifyAdbFailure(output), `adb ${args.join(' ')}: ${output || `exit ${r.code}`}`);
};

/** PATH first, then the usual SDK locations. */
export const findAdb = async (deps: AdbDeps): Promise<AdbResult<string>> => {
  const onPath = await deps.which('adb');
  if (onPath !== null) return ok(onPath);
  for (const candidate of adbPathCandidates(deps.env, deps.platform)) {
    if (await deps.fileExists(candidate)) return ok(candidate);
  }
  return fail('not_installed', 'adb not found on PATH or in the Android SDK locations (ANDROID_HOME, ANDROID_SDK_ROOT, ~/Android/Sdk).');
};

export const listDevices = async (adb: AdbContext): Promise<AdbResult<readonly AdbDevice[]>> => {
  const r = await run(adb, ['devices', '-l']);
  return r.ok ? ok(parseDevices(r.value)) : r;
};

const packageForPid = async (adb: AdbContext, serial: string, pid: number): Promise<string | undefined> => {
  const r = await run(adb, ['-s', serial, 'shell', 'cat', `/proc/${pid}/cmdline`]);
  if (!r.ok) return undefined;
  const name = r.value.split('\0')[0]?.trim();
  return name !== undefined && name !== '' ? name : undefined;
};

/** DevTools sockets on a device; WebView sockets get their app package. */
export const listSockets = async (
  adb: AdbContext,
  serial: string,
): Promise<AdbResult<readonly DevtoolsSocket[]>> => {
  const r = await run(adb, ['-s', serial, 'shell', 'cat', '/proc/net/unix']);
  if (!r.ok) return r;
  const sockets = parseDevtoolsSockets(r.value);
  const resolved = await Promise.all(
    sockets.map(async (s) => {
      if (s.kind !== 'webview' || s.pid === undefined) return s;
      const pkg = await packageForPid(adb, serial, s.pid);
      return pkg !== undefined ? Object.freeze({ ...s, package: pkg }) : s;
    }),
  );
  return ok(Object.freeze(resolved));
};

/**
 * Make a device socket reachable on a local port. Reuses an existing forward
 * for the same device and socket; otherwise lets adb pick a free port.
 */
export const forwardSocket = async (
  adb: AdbContext,
  serial: string,
  socket: string,
): Promise<AdbResult<{ readonly port: number; readonly reused: boolean }>> => {
  const remote = `localabstract:${socket}`;
  const list = await run(adb, ['forward', '--list']);
  if (list.ok) {
    const existing = parseForwards(list.value).find(
      (f) => f.serial === serial && f.remote === remote && f.localPort !== undefined,
    );
    if (existing?.localPort !== undefined) return ok({ port: existing.localPort, reused: true });
  }
  const r = await run(adb, ['-s', serial, 'forward', 'tcp:0', remote]);
  if (!r.ok) return r;
  const port = Number(r.value.trim());
  return Number.isInteger(port) && port > 0
    ? ok({ port, reused: false })
    : fail('failed', `adb forward tcp:0 ${remote} returned no port: ${r.value.trim()}`);
};

export const removeForward = async (adb: AdbContext, serial: string, port: number): Promise<AdbResult<true>> => {
  const r = await run(adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`]);
  return r.ok ? ok(true as const) : r;
};

export const reversePort = async (adb: AdbContext, serial: string, port: number): Promise<AdbResult<true>> => {
  const r = await run(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  return r.ok ? ok(true as const) : r;
};

export const removeReverse = async (adb: AdbContext, serial: string, port: number): Promise<AdbResult<true>> => {
  const r = await run(adb, ['-s', serial, 'reverse', '--remove', `tcp:${port}`]);
  return r.ok ? ok(true as const) : r;
};

/** Current reverse mappings on a device (the first column is the transport, not the serial). */
export const listReverses = async (
  adb: AdbContext,
  serial: string,
): Promise<AdbResult<readonly AdbForward[]>> => {
  const r = await run(adb, ['-s', serial, 'reverse', '--list']);
  return r.ok ? ok(parseForwards(r.value)) : r;
};
