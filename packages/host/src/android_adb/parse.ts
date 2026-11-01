import { join } from 'node:path';

/** adb device states we act on; anything else is passed through as 'other'. */
export type AdbDeviceState = 'device' | 'unauthorized' | 'offline' | 'other';

export type AdbDevice = {
  readonly serial: string;
  readonly state: AdbDeviceState;
  /** Raw state word when it is not one of the known ones. */
  readonly rawState: string;
  readonly model?: string;
  readonly product?: string;
  readonly device?: string;
  readonly transportId?: string;
};

export type DevtoolsSocketKind = 'chrome' | 'webview' | 'browser';

export type DevtoolsSocket = {
  /** Abstract socket name without the leading '@'. */
  readonly socket: string;
  readonly kind: DevtoolsSocketKind;
  /** WebView sockets carry the owning process id. */
  readonly pid?: number;
  /** App package: from the socket name, or resolved from the pid. */
  readonly package?: string;
};

export type AdbForward = {
  readonly serial: string;
  readonly local: string;
  readonly remote: string;
  readonly localPort?: number;
};

export type AdbFailureKind =
  | 'not_installed'
  | 'no_device'
  | 'unauthorized'
  | 'offline'
  | 'multiple_devices'
  | 'not_found'
  | 'failed';

const KNOWN_STATES: ReadonlySet<string> = new Set(['device', 'unauthorized', 'offline']);

/** `adb devices -l` -> devices. */
export const parseDevices = (stdout: string): readonly AdbDevice[] =>
  Object.freeze(
    stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('List of devices') && !l.startsWith('*'))
      .flatMap((line): AdbDevice[] => {
        const [serial, rawState, ...rest] = line.split(/\s+/);
        if (serial === undefined || rawState === undefined) return [];
        const kv = Object.fromEntries(
          rest.flatMap((t) => {
            const i = t.indexOf(':');
            return i > 0 ? [[t.slice(0, i), t.slice(i + 1)]] : [];
          }),
        ) as Record<string, string>;
        return [
          Object.freeze({
            serial,
            state: (KNOWN_STATES.has(rawState) ? rawState : 'other') as AdbDeviceState,
            rawState,
            ...(kv['model'] !== undefined ? { model: kv['model'] } : {}),
            ...(kv['product'] !== undefined ? { product: kv['product'] } : {}),
            ...(kv['device'] !== undefined ? { device: kv['device'] } : {}),
            ...(kv['transport_id'] !== undefined ? { transportId: kv['transport_id'] } : {}),
          }),
        ];
      }),
  );

const classifySocket = (socket: string): DevtoolsSocket => {
  if (socket === 'chrome_devtools_remote') {
    return Object.freeze({ socket, kind: 'chrome', package: 'com.android.chrome' });
  }
  const webview = /^webview_devtools_remote_(\d+)$/.exec(socket);
  if (webview) return Object.freeze({ socket, kind: 'webview', pid: Number(webview[1]) });
  const pkg = /^(.+)_devtools_remote$/.exec(socket)?.[1];
  return Object.freeze({ socket, kind: 'browser', ...(pkg !== undefined ? { package: pkg } : {}) });
};

/**
 * /proc/net/unix -> DevTools sockets. Stetho sockets (Facebook's library in
 * apps such as Google Messages) end in _devtools_remote too but are not
 * Chromium pages, so they are dropped.
 */
export const parseDevtoolsSockets = (procNetUnix: string): readonly DevtoolsSocket[] => {
  const names = new Set(
    procNetUnix
      .split(/\r?\n/)
      .map((l) => /@(\S*devtools_remote\S*)\s*$/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined && !n.startsWith('stetho_')),
  );
  return Object.freeze([...names].sort().map(classifySocket));
};

/** `adb forward --list` -> forwards. */
export const parseForwards = (stdout: string): readonly AdbForward[] =>
  Object.freeze(
    stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((p): p is [string, string, string] => p.length === 3)
      .map(([serial, local, remote]) => {
        const port = /^tcp:(\d+)$/.exec(local)?.[1];
        return Object.freeze({ serial, local, remote, ...(port !== undefined ? { localPort: Number(port) } : {}) });
      }),
  );

/** Best-effort reading of why an adb command failed. */
export const classifyAdbFailure = (output: string): AdbFailureKind => {
  const s = output.toLowerCase();
  if (s.includes('unauthorized')) return 'unauthorized';
  if (s.includes('offline')) return 'offline';
  if (s.includes('more than one device') || s.includes('more than one emulator')) return 'multiple_devices';
  if (s.includes('no devices') || s.includes('device not found') || /device '.*' not found/.test(s)) return 'no_device';
  if (s.includes('no such file') || s.includes('not found')) return 'not_found';
  return 'failed';
};

/** SDK install locations to try when adb is not on PATH. */
export const adbPathCandidates = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): readonly string[] => {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb';
  const roots = [
    env['ANDROID_HOME'],
    env['ANDROID_SDK_ROOT'],
    platform === 'linux' && env['HOME'] ? join(env['HOME'], 'Android', 'Sdk') : undefined,
    platform === 'darwin' && env['HOME'] ? join(env['HOME'], 'Library', 'Android', 'sdk') : undefined,
    platform === 'win32' && env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'Android', 'Sdk') : undefined,
  ].filter((r): r is string => typeof r === 'string' && r !== '');
  return Object.freeze([...new Set(roots.map((r) => join(r, 'platform-tools', exe)))]);
};
