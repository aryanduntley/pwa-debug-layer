/**
 * The impure edge: real DiscoveryDeps backed by node:fs + node:child_process.
 *
 * Kept isolated from all detection logic so the rest of the module stays pure
 * and unit-testable with fakes. Mirrors host_io's "side effects live here,
 * callers stay pure" boundary.
 */
import { access, constants, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { CommandResult, DiscoveryDeps } from './types.js';

/** Resolve a PATH name to an absolute path via `command -v`; null if absent. */
const whichImpl = (name: string): Promise<string | null> =>
  new Promise((resolve) => {
    // `command -v` is POSIX-portable and avoids depending on the `which` binary.
    execFile('/bin/sh', ['-c', `command -v -- "${name}"`], (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.trim();
      resolve(line.length > 0 ? line : null);
    });
  });

/** True when the path exists and is a regular, executable file. */
const fileExistsImpl = async (absPath: string): Promise<boolean> => {
  try {
    const s = await stat(absPath);
    if (!s.isFile()) return false;
    await access(absPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Run a command, capturing stdout + exit code. Never rejects. */
const runCommandImpl = (
  cmd: string,
  args: readonly string[],
): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(cmd, [...args], (err, stdout) => {
      if (err) {
        const code =
          typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : 1;
        resolve({ code, stdout: stdout ?? '' });
        return;
      }
      resolve({ code: 0, stdout: stdout ?? '' });
    });
  });

/** Production DiscoveryDeps wiring real OS effects. */
export const defaultDiscoveryDeps = (): DiscoveryDeps =>
  Object.freeze({
    which: whichImpl,
    fileExists: fileExistsImpl,
    runCommand: runCommandImpl,
  });
