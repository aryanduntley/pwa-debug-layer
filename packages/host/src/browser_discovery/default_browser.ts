/**
 * System-default browser detection, per OS.
 *
 * Linux  — `xdg-settings get default-web-browser` → a `.desktop` id.
 * macOS  — `defaults read com.apple.LaunchServices/com.apple.launchservices.secure
 *           LSHandlers` → the LSHandlerRoleAll bundle id for the http scheme.
 * Windows— `reg query HKCU\…\UrlAssociations\http\UserChoice /v ProgId` → ProgId.
 *
 * Each path reduces to "find the first known pattern inside an opaque id
 * string" (BrowserPatternEntry tables in binary_table.ts), so all three share
 * one matcher. All command execution is injected via DiscoveryDeps; a missing
 * binary or non-zero exit is a graceful null, never a throw.
 *
 * NOTE: the macOS + Windows paths are written but NOT yet verified on a real
 * machine (dev box is Linux). The parsers are unit-tested against captured-
 * format fixtures; live verification is tracked under task 82.
 */
import {
  DESKTOP_TO_BROWSER,
  MAC_BUNDLE_TO_BROWSER,
  WIN_PROGID_TO_BROWSER,
  type BrowserPatternEntry,
} from './binary_table.js';
import type { BrowserName, DiscoveryDeps } from './types.js';

/** First pattern (lowercased substring) contained in `raw`, or null. */
const matchBrowserPattern = (
  raw: string,
  table: readonly BrowserPatternEntry[],
): BrowserName | null => {
  const id = raw.trim().toLowerCase();
  if (id.length === 0) return null;
  for (const entry of table) {
    if (id.includes(entry.pattern)) return entry.name;
  }
  return null;
};

const detectDefaultLinux = async (
  deps: DiscoveryDeps,
): Promise<BrowserName | null> => {
  const { code, stdout } = await deps.runCommand('xdg-settings', [
    'get',
    'default-web-browser',
  ]);
  if (code !== 0) return null;
  return matchBrowserPattern(stdout, DESKTOP_TO_BROWSER);
};

/**
 * Extract the http(s)-scheme handler bundle id from `defaults read … LSHandlers`
 * old-style-plist output. The array is a list of `{ … }` dicts; the relevant
 * one carries `LSHandlerURLScheme = http(s)` plus `LSHandlerRoleAll = "<id>"`.
 * Keys appear in any order within a dict, so we scan per-dict blocks.
 */
const parseDarwinHttpHandler = (stdout: string): string | null => {
  for (const block of stdout.split('}')) {
    if (!/LSHandlerURLScheme\s*=\s*"?https?"?\s*;/.test(block)) continue;
    const role = block.match(/LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?\s*;/);
    if (role?.[1]) return role[1];
  }
  return null;
};

const detectDarwinDefault = async (
  deps: DiscoveryDeps,
): Promise<BrowserName | null> => {
  const { code, stdout } = await deps.runCommand('defaults', [
    'read',
    'com.apple.LaunchServices/com.apple.launchservices.secure',
    'LSHandlers',
  ]);
  if (code !== 0) return null;
  const bundleId = parseDarwinHttpHandler(stdout);
  return bundleId ? matchBrowserPattern(bundleId, MAC_BUNDLE_TO_BROWSER) : null;
};

/**
 * Extract the ProgId value from `reg query … /v ProgId` output. The value line
 * is `    ProgId    REG_SZ    <ProgId>`; the ProgId is the final whitespace-
 * delimited token on that line.
 */
const parseWinProgId = (stdout: string): string | null => {
  for (const line of stdout.split(/\r?\n/)) {
    if (!/\bProgId\b/.test(line) || !/REG_SZ/.test(line)) continue;
    const token = line.trim().split(/\s+/).at(-1);
    if (token && token !== 'REG_SZ') return token;
  }
  return null;
};

const detectWin32Default = async (
  deps: DiscoveryDeps,
): Promise<BrowserName | null> => {
  const { code, stdout } = await deps.runCommand('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '/v',
    'ProgId',
  ]);
  if (code !== 0) return null;
  const progId = parseWinProgId(stdout);
  return progId ? matchBrowserPattern(progId, WIN_PROGID_TO_BROWSER) : null;
};

/**
 * Resolve the system-default web browser as a BrowserName, or null when it is
 * unknown, non-Chromium, or the OS is unsupported.
 */
export const detectDefaultBrowser = async (
  platform: NodeJS.Platform,
  deps: DiscoveryDeps,
): Promise<BrowserName | null> => {
  if (platform === 'linux') return detectDefaultLinux(deps);
  if (platform === 'darwin') return detectDarwinDefault(deps);
  if (platform === 'win32') return detectWin32Default(deps);
  return null;
};
