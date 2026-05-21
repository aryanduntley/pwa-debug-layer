/**
 * Per-OS browser executable location data — DATA ONLY, no logic.
 *
 * OS-modularization seam: every browser on every OS is one frozen row.
 * Adding a browser (or fixing a path) is a one-line edit here and never
 * touches the detection logic in discover_binaries.ts. Each OS owns its own
 * table; discover_binaries dispatches to the matching one by platform.
 */
import type { BrowserName } from '../native-messaging/browser_paths.js';

/**
 * Linux: candidate executable names probed on PATH (preferred — respects the
 * user's actual install), then absolute fallback paths for common packages.
 */
export type LinuxBinaryEntry = {
  readonly name: BrowserName;
  readonly pathNames: readonly string[];
  readonly standardPaths: readonly string[];
};

export const LINUX_BINARIES: readonly LinuxBinaryEntry[] = Object.freeze([
  {
    name: 'chrome',
    pathNames: Object.freeze(['google-chrome', 'google-chrome-stable']),
    standardPaths: Object.freeze([
      '/opt/google/chrome/chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
    ]),
  },
  {
    name: 'chromium',
    pathNames: Object.freeze(['chromium', 'chromium-browser']),
    standardPaths: Object.freeze([
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ]),
  },
  {
    name: 'edge',
    pathNames: Object.freeze(['microsoft-edge', 'microsoft-edge-stable']),
    standardPaths: Object.freeze([
      '/opt/microsoft/msedge/msedge',
      '/usr/bin/microsoft-edge',
    ]),
  },
  {
    name: 'brave',
    pathNames: Object.freeze(['brave-browser', 'brave']),
    standardPaths: Object.freeze([
      '/opt/brave.com/brave/brave-browser',
      '/usr/bin/brave-browser',
    ]),
  },
  {
    name: 'vivaldi',
    pathNames: Object.freeze(['vivaldi', 'vivaldi-stable']),
    standardPaths: Object.freeze(['/opt/vivaldi/vivaldi', '/usr/bin/vivaldi']),
  },
  {
    name: 'opera',
    pathNames: Object.freeze(['opera']),
    standardPaths: Object.freeze(['/usr/bin/opera', '/opt/opera/opera']),
  },
]);

/** macOS: absolute .app bundle executable paths under /Applications. */
export type MacBinaryEntry = {
  readonly name: BrowserName;
  readonly execPath: string;
};

export const MAC_BINARIES: readonly MacBinaryEntry[] = Object.freeze([
  {
    name: 'chrome',
    execPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  {
    name: 'chromium',
    execPath: '/Applications/Chromium.app/Contents/MacOS/Chromium',
  },
  {
    name: 'edge',
    execPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  },
  {
    name: 'brave',
    execPath:
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  },
  {
    name: 'vivaldi',
    execPath: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  },
  { name: 'opera', execPath: '/Applications/Opera.app/Contents/MacOS/Opera' },
]);

/**
 * Windows: path segments under a Program Files root. discover_binaries joins
 * these onto each available root (PROGRAMFILES, PROGRAMFILES(X86),
 * LOCALAPPDATA) from the env snapshot.
 */
export type WinBinaryEntry = {
  readonly name: BrowserName;
  readonly segments: readonly string[];
};

export const WIN_BINARIES: readonly WinBinaryEntry[] = Object.freeze([
  {
    name: 'chrome',
    segments: Object.freeze(['Google', 'Chrome', 'Application', 'chrome.exe']),
  },
  {
    name: 'chromium',
    segments: Object.freeze(['Chromium', 'Application', 'chrome.exe']),
  },
  {
    name: 'edge',
    segments: Object.freeze(['Microsoft', 'Edge', 'Application', 'msedge.exe']),
  },
  {
    name: 'brave',
    segments: Object.freeze([
      'BraveSoftware',
      'Brave-Browser',
      'Application',
      'brave.exe',
    ]),
  },
  {
    name: 'vivaldi',
    segments: Object.freeze(['Vivaldi', 'Application', 'vivaldi.exe']),
  },
  {
    name: 'opera',
    segments: Object.freeze(['Opera', 'launcher.exe']),
  },
]);

/**
 * Maps an xdg-settings `.desktop` id (or a recognizable substring of one) to a
 * BrowserName. Order matters: first substring hit wins, so list more-specific
 * patterns before generic ones. Non-Chromium defaults (firefox, etc.) simply
 * have no entry and resolve to null.
 */
export type DesktopMapEntry = {
  readonly pattern: string;
  readonly name: BrowserName;
};

export const DESKTOP_TO_BROWSER: readonly DesktopMapEntry[] = Object.freeze([
  { pattern: 'google-chrome', name: 'chrome' },
  { pattern: 'microsoft-edge', name: 'edge' },
  { pattern: 'brave', name: 'brave' },
  { pattern: 'vivaldi', name: 'vivaldi' },
  { pattern: 'opera', name: 'opera' },
  // chromium last: 'chromium' would otherwise shadow nothing here, but keeping
  // it after the branded browsers documents the precedence intent.
  { pattern: 'chromium', name: 'chromium' },
]);
