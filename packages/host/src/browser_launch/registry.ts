/**
 * In-session launch registry: a record of the browsers this host process has
 * launched or attached to, so pdl_browser_status can report them. Pure closure
 * over an array (newest last); `now` is injected. In-session only — cross-host
 * persistence is deferred (a future state.json-backed registry).
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

export const createLaunchRegistry = (deps: {
  readonly now: () => number;
}): LaunchRegistry => {
  const records: LaunchRecord[] = [];
  return Object.freeze({
    record: (rec) => {
      records.push(Object.freeze({ ...rec, launchedAt: deps.now() }));
    },
    list: () => Object.freeze([...records]),
  });
};
