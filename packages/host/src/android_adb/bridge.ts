import type { CdpAttachResult, CdpTransport } from '../transport/cdp_transport.js';
import {
  findAdb,
  forwardSocket,
  listDevices,
  listReverses,
  listSockets,
  removeForward,
  removeReverse,
  reversePort,
  type AdbContext,
} from './adb.js';
import type { AdbDeps } from './node_deps.js';
import type { AdbDevice, AdbFailureKind, DevtoolsSocket } from './parse.js';

export type AndroidDeviceReport = AdbDevice & {
  readonly sockets?: readonly DevtoolsSocket[];
  readonly socketsError?: string;
};

export type AndroidFailure = {
  readonly ok: false;
  readonly kind: AdbFailureKind | 'no_socket' | 'ambiguous_socket' | 'attach_failed';
  readonly message: string;
  readonly devices?: readonly AdbDevice[];
  readonly sockets?: readonly DevtoolsSocket[];
  readonly candidates?: readonly { readonly id: string; readonly url: string }[];
};

export type AndroidDevicesResult =
  | { readonly ok: true; readonly adbPath: string; readonly devices: readonly AndroidDeviceReport[] }
  | AndroidFailure;

export type AndroidAttachOptions = {
  readonly serial?: string;
  /** Socket name, or 'chrome' / 'webview' to pick by kind. Default: Chrome. */
  readonly socket?: string;
  readonly targetId?: string;
  readonly urlContains?: string;
  /** Open a new tab at this URL and attach it (bridge present from the first script). */
  readonly openUrl?: string;
  readonly reload?: boolean;
  /** Desktop ports to expose on the phone as localhost:<port> (adb reverse). */
  readonly reversePorts?: readonly number[];
};

export type AndroidAttachResult =
  | {
      readonly ok: true;
      readonly serial: string;
      readonly model?: string;
      readonly socket: DevtoolsSocket;
      readonly browserUrl: string;
      readonly forwardReused: boolean;
      readonly reversed: readonly number[];
      readonly connectionId: string;
      readonly url: string;
      readonly title: string;
      readonly reused: boolean;
      readonly loadStatus?: 'complete' | 'loading';
      readonly bridge: unknown;
    }
  | AndroidFailure;

export type AndroidBridge = {
  readonly devices: () => Promise<AndroidDevicesResult>;
  readonly attach: (opts: AndroidAttachOptions) => Promise<AndroidAttachResult>;
  /** Remove the forwards and reverses this bridge created. */
  readonly cleanup: () => Promise<void>;
};

export type AndroidBridgeDeps = {
  readonly adb: AdbDeps;
  readonly cdp: Pick<CdpTransport, 'attach' | 'openTab'>;
};

const fail = (
  kind: AndroidFailure['kind'],
  message: string,
  extra?: Omit<AndroidFailure, 'ok' | 'kind' | 'message'>,
): AndroidFailure => Object.freeze({ ok: false as const, kind, message, ...extra });

/** Choose the device: the given serial, or the only authorized one. */
const pickDevice = (
  devices: readonly AdbDevice[],
  serial: string | undefined,
): { readonly ok: true; readonly device: AdbDevice } | AndroidFailure => {
  if (serial !== undefined) {
    const d = devices.find((x) => x.serial === serial);
    if (d === undefined) return fail('no_device', `no device with serial ${serial}`, { devices });
    if (d.state === 'unauthorized') return fail('unauthorized', `${serial} has not authorized this computer`, { devices });
    if (d.state !== 'device') return fail('offline', `${serial} is ${d.rawState}`, { devices });
    return { ok: true, device: d };
  }
  const ready = devices.filter((d) => d.state === 'device');
  if (ready.length === 1) return { ok: true, device: ready[0]! };
  if (ready.length > 1) {
    return fail('multiple_devices', `${ready.length} devices are connected; pass serial`, { devices });
  }
  const unauthorized = devices.find((d) => d.state === 'unauthorized');
  if (unauthorized !== undefined) {
    return fail('unauthorized', `${unauthorized.serial} is connected but has not authorized this computer`, { devices });
  }
  const offline = devices.find((d) => d.state !== 'device');
  return offline !== undefined
    ? fail('offline', `${offline.serial} is ${offline.rawState}`, { devices })
    : fail('no_device', 'no Android device is connected over adb', { devices });
};

/** Choose the socket: by name, by kind, else Chrome, else the only one. */
const pickSocket = (
  sockets: readonly DevtoolsSocket[],
  wanted: string | undefined,
): { readonly ok: true; readonly socket: DevtoolsSocket } | AndroidFailure => {
  if (sockets.length === 0) return fail('no_socket', 'no browser or debuggable WebView is exposing a DevTools socket on the device', { sockets });
  const byWanted =
    wanted === undefined
      ? sockets.filter((s) => s.kind === 'chrome')
      : sockets.filter((s) => s.socket === wanted || s.kind === wanted || s.package === wanted);
  const pool = byWanted.length > 0 ? byWanted : wanted === undefined ? sockets : [];
  if (pool.length === 1) return { ok: true, socket: pool[0]! };
  if (pool.length === 0) return fail('no_socket', `no DevTools socket matches "${wanted}"`, { sockets });
  return fail('ambiguous_socket', `${pool.length} DevTools sockets match; pass socket`, { sockets });
};

/**
 * Glue between adb and the CDP transport: find the phone, expose its
 * DevTools socket locally, then attach (or open a tab) over CDP.
 */
export const createAndroidBridge = (deps: AndroidBridgeDeps): AndroidBridge => {
  // Mappings this host created, so cleanup never removes the user's own.
  const createdForwards = new Map<string, { readonly serial: string; readonly port: number }>();
  const createdReverses = new Map<string, { readonly serial: string; readonly port: number }>();
  let adbCache: AdbContext | null = null;

  const adbContext = async (): Promise<{ readonly ok: true; readonly adb: AdbContext } | AndroidFailure> => {
    if (adbCache !== null) return { ok: true, adb: adbCache };
    const found = await findAdb(deps.adb);
    if (!found.ok) return fail(found.kind, found.message);
    adbCache = { adbPath: found.value, deps: deps.adb };
    return { ok: true, adb: adbCache };
  };

  const devices = async (): Promise<AndroidDevicesResult> => {
    const ctx = await adbContext();
    if (!ctx.ok) return ctx;
    const listed = await listDevices(ctx.adb);
    if (!listed.ok) return fail(listed.kind, listed.message);
    const reports = await Promise.all(
      listed.value.map(async (d): Promise<AndroidDeviceReport> => {
        if (d.state !== 'device') return d;
        const s = await listSockets(ctx.adb, d.serial);
        return s.ok ? { ...d, sockets: s.value } : { ...d, socketsError: s.message };
      }),
    );
    return { ok: true, adbPath: ctx.adb.adbPath, devices: Object.freeze(reports) };
  };

  const reverse = async (adb: AdbContext, serial: string, ports: readonly number[]) => {
    const existing = await listReverses(adb, serial);
    const already = new Set(existing.ok ? existing.value.map((r) => r.localPort) : []);
    for (const port of ports) {
      if (already.has(port)) continue;
      const r = await reversePort(adb, serial, port);
      if (!r.ok) return fail(r.kind, `adb reverse tcp:${port} failed: ${r.message}`);
      createdReverses.set(`${serial}:${port}`, { serial, port });
    }
    return null;
  };

  const attach = async (opts: AndroidAttachOptions): Promise<AndroidAttachResult> => {
    const ctx = await adbContext();
    if (!ctx.ok) return ctx;
    const listed = await listDevices(ctx.adb);
    if (!listed.ok) return fail(listed.kind, listed.message);
    const picked = pickDevice(listed.value, opts.serial);
    if (!picked.ok) return picked;
    const { device } = picked;

    const reverseFailure = await reverse(ctx.adb, device.serial, opts.reversePorts ?? []);
    if (reverseFailure !== null) return reverseFailure;

    const sockets = await listSockets(ctx.adb, device.serial);
    if (!sockets.ok) return fail(sockets.kind, sockets.message);
    const chosen = pickSocket(sockets.value, opts.socket);
    if (!chosen.ok) return chosen;

    const fwd = await forwardSocket(ctx.adb, device.serial, chosen.socket.socket);
    if (!fwd.ok) return fail(fwd.kind, fwd.message);
    if (!fwd.value.reused) createdForwards.set(`${device.serial}:${fwd.value.port}`, { serial: device.serial, port: fwd.value.port });
    const browserUrl = `127.0.0.1:${fwd.value.port}`;

    const r: CdpAttachResult & { readonly loadStatus?: 'complete' | 'loading'; readonly url?: string } =
      opts.openUrl !== undefined
        ? await deps.cdp.openTab({ browserUrl, url: opts.openUrl })
        : await deps.cdp.attach({
            browserUrl,
            ...(opts.targetId !== undefined ? { targetId: opts.targetId } : {}),
            ...(opts.urlContains !== undefined ? { urlContains: opts.urlContains } : {}),
            ...(opts.reload !== undefined ? { reload: opts.reload } : {}),
          });
    if (!r.ok) {
      const candidates = 'candidates' in r && r.candidates !== undefined ? r.candidates.map((c) => ({ id: c.id, url: c.url })) : undefined;
      return fail('attach_failed', r.error, candidates !== undefined ? { candidates } : undefined);
    }
    return Object.freeze({
      ok: true as const,
      serial: device.serial,
      ...(device.model !== undefined ? { model: device.model } : {}),
      socket: chosen.socket,
      browserUrl,
      forwardReused: fwd.value.reused,
      reversed: Object.freeze([...(opts.reversePorts ?? [])]),
      connectionId: r.connectionId,
      url: r.url ?? r.target.url,
      title: r.target.title,
      reused: r.reused,
      ...(r.loadStatus !== undefined ? { loadStatus: r.loadStatus } : {}),
      bridge: r.status,
    });
  };

  const cleanup = async (): Promise<void> => {
    if (adbCache === null) return;
    const adb = adbCache;
    await Promise.all([
      ...[...createdForwards.values()].map((f) => removeForward(adb, f.serial, f.port)),
      ...[...createdReverses.values()].map((r) => removeReverse(adb, r.serial, r.port)),
    ]);
    createdForwards.clear();
    createdReverses.clear();
  };

  return Object.freeze({ devices, attach, cleanup });
};
