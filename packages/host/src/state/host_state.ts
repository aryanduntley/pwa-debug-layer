import {
  atomicWriteJson,
  readJsonOr,
  xdgConfigPath,
  type XdgEnv,
} from '../host_io/host_io.js';

export type HostState = {
  readonly extensionIds: readonly string[];
  readonly lastUpdated: string;
  readonly lastInstalledManifestPaths: readonly string[];
};

export const EMPTY_STATE: HostState = Object.freeze({
  extensionIds: Object.freeze([] as readonly string[]),
  lastUpdated: '',
  lastInstalledManifestPaths: Object.freeze([] as readonly string[]),
});

/**
 * Thin wrapper over host_io.xdgConfigPath. Pre-checks env so the error string
 * stays the host_state-specific message existing callers (and the test suite)
 * already assert on, rather than the generic host_io message.
 */
export const defaultStatePath = (env: XdgEnv = process.env): string => {
  const hasXdg = Boolean(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0);
  if (!hasXdg && !env.HOME) {
    throw new Error(
      'host_state: cannot resolve state path; HOME and XDG_CONFIG_HOME are both unset',
    );
  }
  return xdgConfigPath('state.json', env);
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const parseHostState = (raw: unknown): HostState => {
  if (!raw || typeof raw !== 'object') {
    throw new Error('host_state: state.json root is not an object');
  }
  const r = raw as Record<string, unknown>;
  if (!isStringArray(r['extensionIds'])) {
    throw new Error('host_state: extensionIds is not a string[]');
  }
  if (typeof r['lastUpdated'] !== 'string') {
    throw new Error('host_state: lastUpdated is not a string');
  }
  if (!isStringArray(r['lastInstalledManifestPaths'])) {
    throw new Error('host_state: lastInstalledManifestPaths is not a string[]');
  }
  return {
    extensionIds: Object.freeze([...r['extensionIds']]),
    lastUpdated: r['lastUpdated'],
    lastInstalledManifestPaths: Object.freeze([...r['lastInstalledManifestPaths']]),
  };
};

export const loadHostState = (path: string): Promise<HostState> =>
  readJsonOr(path, EMPTY_STATE, parseHostState);

export const saveHostState = (
  path: string,
  state: HostState,
): Promise<void> => atomicWriteJson(path, state);

export const addExtensionId = (state: HostState, id: string): HostState => {
  if (state.extensionIds.includes(id)) return state;
  return {
    ...state,
    extensionIds: Object.freeze([...state.extensionIds, id]),
  };
};

export const removeExtensionId = (state: HostState, id: string): HostState => {
  if (!state.extensionIds.includes(id)) return state;
  return {
    ...state,
    extensionIds: Object.freeze(state.extensionIds.filter((x) => x !== id)),
  };
};

export const setManifestPaths = (
  state: HostState,
  paths: readonly string[],
): HostState => {
  const deduped = Object.freeze([...new Set(paths)].sort());
  return { ...state, lastInstalledManifestPaths: deduped };
};
