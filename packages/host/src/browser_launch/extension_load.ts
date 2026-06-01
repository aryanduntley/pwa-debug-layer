/**
 * Pure browser brand+version → unpacked-extension-load capability.
 *
 * Branded Google Chrome removed the --load-extension CLI flag: at 137 (with a
 * temporary escape hatch, --disable-features=DisableLoadExtensionCommandLineSwitch)
 * and FULLY at 142+ (escape hatch also removed). Every OTHER Chromium-family
 * browser — unbranded Chromium, Chrome-for-Testing, Brave, Edge, Opera, Vivaldi —
 * still honors --load-extension. So the sandbox extension-preload behavior is a
 * function of brand + major version, computed here (pure) and consumed by the
 * spawn-arg builder + the launch guidance. The version string is produced at the
 * edge (`<binary> --version`) and parsed by parseBrowserVersion;
 * extensionLoadStrategy maps the result to the launch behavior.
 *
 * Refs: research note #331, decision note #332.
 */

export type BrowserBrand =
  | 'google-chrome'
  | 'chrome-for-testing'
  | 'chromium'
  | 'brave'
  | 'edge'
  | 'opera'
  | 'vivaldi'
  | 'unknown';

/** A browser's brand + major version, parsed from its `--version` output. */
export type BrowserVersion = {
  readonly brand: BrowserBrand;
  readonly major: number;
};

/**
 * How to provision the unpacked extension for a sandbox launch:
 *  - 'load-flag': pass --load-extension (every non-Google-Chrome Chromium, and
 *    Google Chrome <=136).
 *  - 'load-flag-escape-hatch': --load-extension PLUS
 *    --disable-features=DisableLoadExtensionCommandLineSwitch (Google Chrome
 *    137..141, where the flag is gated behind that feature).
 *  - 'manual-guided': the flag is dead and unrecoverable (Google Chrome >=142) —
 *    omit it (and --disable-extensions-except, which would block a manual load
 *    too) and guide the user through a one-time Load-unpacked.
 */
export type ExtensionLoadStrategy =
  | 'load-flag'
  | 'load-flag-escape-hatch'
  | 'manual-guided';

/** Brand matchers against the leading product name of `<binary> --version`,
 *  most-specific first (Chrome-for-Testing before the google-chrome prefix). */
const BRAND_MATCHERS: ReadonlyArray<readonly [RegExp, BrowserBrand]> =
  Object.freeze([
    [/google chrome for testing/i, 'chrome-for-testing'],
    [/google chrome/i, 'google-chrome'],
    [/brave browser/i, 'brave'],
    [/microsoft edge/i, 'edge'],
    [/\bchromium\b/i, 'chromium'],
    [/\bvivaldi\b/i, 'vivaldi'],
    [/\bopera\b/i, 'opera'],
  ]);

/**
 * Parse the stdout of `<binary> --version` into a brand + major version.
 * Examples: "Google Chrome 148.0.7778.215", "Brave Browser 148.1.90.122",
 * "Chromium 148.0.7778.167 snap", "Microsoft Edge 141.0.3537.57". Returns null
 * when no dotted version number is present; an unrecognized product name still
 * parses (brand 'unknown') as long as a version is found.
 */
export const parseBrowserVersion = (stdout: string): BrowserVersion | null => {
  const text = stdout.trim();
  if (text.length === 0) return null;
  const m = text.match(/(\d+)\.\d+\.\d+/);
  if (!m) return null;
  const major = Number(m[1]);
  if (!Number.isInteger(major)) return null;
  const brand = BRAND_MATCHERS.find(([re]) => re.test(text))?.[1] ?? 'unknown';
  return Object.freeze({ brand, major });
};

/** Chrome major at which --load-extension started being gated (escape-hatch era). */
const CHROME_GATED_FROM = 137;
/** Chrome major at which --load-extension AND the escape hatch are both gone. */
const CHROME_DEAD_FROM = 142;

/**
 * Map a parsed version to the sandbox extension-load strategy. Only branded
 * Google Chrome is constrained; every other brand (and an unknown brand) gets
 * the plain flag, which still works. A null version (couldn't read `--version`)
 * is treated optimistically as 'load-flag' — better to attempt the flag than to
 * force the manual path on a browser that very likely supports it.
 */
export const extensionLoadStrategy = (
  version: BrowserVersion | null,
): ExtensionLoadStrategy => {
  if (!version || version.brand !== 'google-chrome') return 'load-flag';
  if (version.major >= CHROME_DEAD_FROM) return 'manual-guided';
  if (version.major >= CHROME_GATED_FROM) return 'load-flag-escape-hatch';
  return 'load-flag';
};

/** Effect signature: run a command, capturing stdout + exit code, never reject.
 *  Structurally matches browser_discovery's CommandResult-returning runCommand,
 *  declared inline so this module needn't depend on browser_discovery. */
type RunCommand = (
  cmd: string,
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string }>;

/**
 * Edge (effect injected): read a browser's brand+version by invoking its
 * `--version`. Native/snap browsers run `<execPath> --version`; a flatpak target
 * (appId set, no host binary) runs `flatpak run <appId> --version`. A non-zero
 * exit or unparseable output yields null, so the caller falls back to the
 * optimistic 'load-flag' strategy rather than blocking a launch on a version
 * read it couldn't complete.
 */
export const readBrowserVersion = async (
  runCommand: RunCommand,
  target: { readonly execPath: string; readonly appId?: string },
): Promise<BrowserVersion | null> => {
  const { cmd, args } = target.appId
    ? { cmd: 'flatpak', args: ['run', target.appId, '--version'] as const }
    : { cmd: target.execPath, args: ['--version'] as const };
  const res = await runCommand(cmd, args);
  if (res.code !== 0) return null;
  return parseBrowserVersion(res.stdout);
};
