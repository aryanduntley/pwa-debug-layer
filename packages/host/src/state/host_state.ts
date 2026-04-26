import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

export const defaultStatePath = (
  env: { HOME?: string; XDG_CONFIG_HOME?: string } = process.env,
): string => {
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : env.HOME
        ? join(env.HOME, '.config')
        : null;
  if (!configHome) {
    throw new Error('host_state: cannot resolve state path; HOME and XDG_CONFIG_HOME are both unset');
  }
  return join(configHome, 'pwa-debug', 'state.json');
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

export const loadHostState = async (path: string): Promise<HostState> => {
  let body: string;
  try {
    body = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE;
    throw err;
  }
  return parseHostState(JSON.parse(body));
};

export const saveHostState = async (
  path: string,
  state: HostState,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  await rename(tmp, path);
};

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
