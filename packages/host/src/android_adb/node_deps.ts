import { execFile } from 'node:child_process';
import { defaultDiscoveryDeps } from '../browser_discovery/node_deps.js';

const DEFAULT_ADB_TIMEOUT_MS = 15_000;

export type AdbRunResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type AdbDeps = {
  readonly which: (name: string) => Promise<string | null>;
  readonly fileExists: (absPath: string) => Promise<boolean>;
  readonly run: (adbPath: string, args: readonly string[], timeoutMs?: number) => Promise<AdbRunResult>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
};

/** Run adb, capturing both streams (adb reports most errors on stderr). Never rejects. */
export const runAdbProcess = (
  adbPath: string,
  args: readonly string[],
  timeoutMs: number = DEFAULT_ADB_TIMEOUT_MS,
): Promise<AdbRunResult> =>
  new Promise((resolve) => {
    execFile(adbPath, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code =
        err === null
          ? 0
          : typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1;
      const timedOut = err !== null && (err as { killed?: boolean }).killed === true;
      resolve({
        code,
        stdout: String(stdout ?? ''),
        stderr: timedOut ? `adb timed out after ${timeoutMs}ms` : String(stderr ?? (err as Error | null)?.message ?? ''),
      });
    });
  });

/** Real OS effects for the android_adb module. */
export const defaultAdbDeps = (): AdbDeps => {
  const d = defaultDiscoveryDeps();
  return Object.freeze({
    which: d.which,
    fileExists: d.fileExists,
    run: runAdbProcess,
    env: process.env,
    platform: process.platform,
  });
};
