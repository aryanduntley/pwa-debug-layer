/**
 * Browser-discovery vocabulary.
 *
 * This module finds installed Chromium-family browser EXECUTABLES (what to
 * spawn) and the system-default browser. It is the launch-side counterpart to
 * native-messaging/browser_paths.ts, which finds profile/config dirs (where
 * Chrome reads the native-messaging manifest). The two share one browser
 * vocabulary — `BrowserName` is owned by browser_paths and re-used here, never
 * redefined.
 *
 * All discovery logic is pure with respect to injected `DiscoveryDeps`: no
 * direct node:fs / node:child_process imports in the detection functions. The
 * real edge wiring lives in node_deps.ts (side effects at the boundary).
 */
import type { BrowserName } from '../native-messaging/browser_paths.js';

export type { BrowserName };

/** How a browser executable was located. */
export type BinarySource =
  /** Resolved by name on the user's PATH. */
  | 'path'
  /** Found at a known standard install path for the OS. */
  | 'standard-path';

/** A located, launchable browser executable. */
export type DiscoveredBrowser = {
  readonly browser: BrowserName;
  readonly execPath: string;
  readonly source: BinarySource;
  /** True when this browser is the system default web browser. */
  readonly isDefault: boolean;
};

/** Result of a full discovery pass. */
export type BrowserDiscoveryResult = {
  readonly platform: NodeJS.Platform;
  readonly browsers: readonly DiscoveredBrowser[];
  /** System-default browser, or null when unknown / non-Chromium. */
  readonly defaultBrowser: BrowserName | null;
};

/** Outcome of running an external command; never throws — failure is code !== 0. */
export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
};

/**
 * Environment snapshot used only by the Windows table (Program Files roots).
 * Linux + macOS standard paths are absolute and need no env.
 */
export type EnvSnapshot = {
  readonly HOME?: string;
  readonly PROGRAMFILES?: string;
  readonly 'PROGRAMFILES(X86)'?: string;
  readonly LOCALAPPDATA?: string;
};

/**
 * Injected effectful primitives. Detection functions receive these so they
 * stay pure + testable; node_deps.ts provides the real implementations.
 */
export type DiscoveryDeps = {
  /** Resolve an executable name on PATH to an absolute path, or null. */
  readonly which: (name: string) => Promise<string | null>;
  /** Does an absolute path exist as a regular (executable) file? */
  readonly fileExists: (absPath: string) => Promise<boolean>;
  /** Run a command, capturing stdout + exit code. Must never reject. */
  readonly runCommand: (
    cmd: string,
    args: readonly string[],
  ) => Promise<CommandResult>;
};
