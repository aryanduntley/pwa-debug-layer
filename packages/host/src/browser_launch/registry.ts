/**
 * Launch registry: a record of the browsers this host has launched or attached
 * to, so pdl_browser_status can report them. Pure closure over an array
 * (newest last); `now` is injected.
 *
 * Persistence (optional, injected): when `load`/`persist` are supplied the
 * registry seeds from the last run and writes back on every record(), so
 * pdl_browser_status survives a host restart. node_deps wires these to a
 * launches.json beside the host config (a dedicated file — NOT state.json — so
 * launch writes never race the extension-id/manifest writers, and host_state
 * stays decoupled from browser_launch types). Liveness is NOT persisted: a
 * stale pid/port is harmless because pdl_browser_status re-probes every port.
 */
import type { BrowserName, LaunchProfileType } from './types.js';

export type LaunchRecord = {
  readonly browser: BrowserName;
  readonly profileType: LaunchProfileType;
  readonly port: number;
  readonly pid: number | null;
  readonly browserUrl: string | null;
  readonly userDataDir?: string;
  readonly launchedAt: number;
};

export type LaunchRegistry = {
  readonly record: (rec: Omit<LaunchRecord, 'launchedAt'>) => void;
  readonly list: () => readonly LaunchRecord[];
};

const BROWSERS: readonly BrowserName[] = [
  'chrome',
  'chromium',
  'edge',
  'brave',
  'vivaldi',
  'opera',
];
const PROFILE_TYPES: readonly LaunchProfileType[] = [
  'existing',
  'sandbox-persistent',
  'sandbox-temp',
];

/**
 * A debug port serves exactly one browser at a time, so a new launch on a port
 * supersedes any prior record for it (keeps the list bounded across restarts).
 * Result is ordered newest-last.
 */
export const mergeLaunch = (
  records: readonly LaunchRecord[],
  rec: LaunchRecord,
): readonly LaunchRecord[] =>
  Object.freeze([...records.filter((r) => r.port !== rec.port), rec]);

/**
 * Validate persisted JSON back into LaunchRecords, dropping malformed entries
 * (a corrupt launches.json must never crash boot). Non-array input → [].
 */
export const parseLaunchRecords = (raw: unknown): readonly LaunchRecord[] => {
  if (!Array.isArray(raw)) return [];
  const out: LaunchRecord[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (!BROWSERS.includes(o['browser'] as BrowserName)) continue;
    if (!PROFILE_TYPES.includes(o['profileType'] as LaunchProfileType)) continue;
    if (typeof o['port'] !== 'number') continue;
    if (typeof o['launchedAt'] !== 'number') continue;
    const pid = o['pid'];
    const browserUrl = o['browserUrl'];
    const userDataDir = o['userDataDir'];
    out.push(
      Object.freeze({
        browser: o['browser'] as BrowserName,
        profileType: o['profileType'] as LaunchProfileType,
        port: o['port'],
        pid: typeof pid === 'number' ? pid : null,
        browserUrl: typeof browserUrl === 'string' ? browserUrl : null,
        ...(typeof userDataDir === 'string' ? { userDataDir } : {}),
        launchedAt: o['launchedAt'],
      }),
    );
  }
  return Object.freeze(out);
};

export const createLaunchRegistry = (deps: {
  readonly now: () => number;
  /** Seed from a previous run (optional — omit for in-session-only). */
  readonly load?: () => readonly LaunchRecord[];
  /** Write back after each record() (optional — omit for in-session-only). */
  readonly persist?: (records: readonly LaunchRecord[]) => void;
}): LaunchRegistry => {
  let records: readonly LaunchRecord[] = deps.load ? [...deps.load()] : [];
  return Object.freeze({
    record: (rec) => {
      records = mergeLaunch(
        records,
        Object.freeze({ ...rec, launchedAt: deps.now() }),
      );
      deps.persist?.(records);
    },
    list: () => Object.freeze([...records]),
  });
};
