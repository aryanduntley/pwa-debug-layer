/**
 * Shared host-process filesystem IO primitives.
 *
 * Three pure-at-edges functions consumed by every host module that needs to
 * persist a small JSON file under ~/.config/pwa-debug (host_state.state.json,
 * host_settings.settings.json, …). Side effects (fs) live here; callers stay
 * pure transforms.
 *
 * Plug-ability: a new persisted host file = pass a different filename +
 * caller-specific shape validator. No primitive in this module knows about
 * any particular schema.
 */
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

/** Minimal env snapshot for XDG resolution; tests inject controlled values. */
export type XdgEnv = {
  readonly HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
};

const PWA_DEBUG_CONFIG_DIR = 'pwa-debug';

/**
 * Resolve `<XDG_CONFIG_HOME | HOME/.config>/pwa-debug/<filename>`. Pure with
 * respect to the passed env snapshot. Throws on missing env vars; callers
 * (host_state, host_settings) wrap the throw with their own caller-specific
 * message so existing error contracts stay stable.
 */
export const xdgConfigPath = (
  filename: string,
  env: XdgEnv = process.env,
): string => {
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : env.HOME
        ? join(env.HOME, '.config')
        : null;
  if (!configHome) {
    throw new Error(
      'host_io: cannot resolve config path; HOME and XDG_CONFIG_HOME are both unset',
    );
  }
  return join(configHome, PWA_DEBUG_CONFIG_DIR, filename);
};

/**
 * Crash-safe JSON persistence: mkdir-p the parent dir, write to a per-process
 * tmp file, then atomic rename onto the target. Identical bytes (2-space
 * indent, trailing newline) to the inline implementation host_state used
 * pre-extraction so on-disk format is unchanged.
 */
export const atomicWriteJson = async (
  path: string,
  data: unknown,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  await rename(tmp, path);
};

/**
 * Append a single record line to a file. Opens-with-create on first call
 * (mode 0o600) and writes one fs.appendFile per call with a trailing '\n'.
 * Ensures the parent directory exists via mkdir -p. Owns the only place in
 * the host process where rolling jsonl files are appended — host_archive
 * composes this primitive on every disk-spill event from the captures ring
 * buffers. No buffering, no fsync; the caller decides when to rotate to a
 * fresh path. The caller passes a line WITHOUT a trailing newline so this
 * primitive owns line termination.
 */
export const appendLine = async (
  path: string,
  line: string,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, { encoding: 'utf-8', mode: 0o600 });
};

/**
 * Streaming UTF-8 line reader for jsonl archives. Async generator over
 * createReadStream + readline so the host_archive reader can iterate
 * multi-MB rotated files without slurping them into memory. Final lines
 * without a trailing '\n' are still emitted (readline default).
 *
 * ENOENT contract: when the file does not exist, yields nothing and
 * returns normally — host_archive treats "archive doesn't exist yet" as
 * the steady state on a fresh install or with disk spill disabled.
 */
export async function* readLines(path: string): AsyncIterable<string> {
  try {
    await access(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Read + JSON.parse a config file with a missing-file fallback. The caller
 * supplies the (raw:unknown) => T validator so per-file shape enforcement
 * stays at the boundary that owns it — `host_state` validates HostState,
 * `host_settings` validates the persisted settings object, this primitive
 * remains schema-agnostic.
 */
export const readJsonOr = async <T>(
  path: string,
  fallback: T,
  parse: (raw: unknown) => T,
): Promise<T> => {
  let body: string;
  try {
    body = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
  return parse(JSON.parse(body));
};
