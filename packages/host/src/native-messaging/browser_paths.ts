import { join } from 'node:path';

export type BrowserName =
  | 'chrome'
  | 'chromium'
  | 'edge'
  | 'brave'
  | 'vivaldi'
  | 'opera';

export type BrowserConfig = {
  readonly name: BrowserName;
  readonly configDirSegments: readonly string[];
};

export type InstalledBrowser = {
  readonly name: BrowserName;
  readonly manifestDir: string;
};

const NMH_DIR = 'NativeMessagingHosts';

const LINUX_BROWSERS: readonly BrowserConfig[] = Object.freeze([
  { name: 'chrome', configDirSegments: ['google-chrome'] },
  { name: 'chromium', configDirSegments: ['chromium'] },
  { name: 'edge', configDirSegments: ['microsoft-edge'] },
  { name: 'brave', configDirSegments: ['BraveSoftware', 'Brave-Browser'] },
  { name: 'vivaldi', configDirSegments: ['vivaldi'] },
  { name: 'opera', configDirSegments: ['opera'] },
]);

export const listSupportedBrowsers = (
  platform: NodeJS.Platform,
): readonly BrowserConfig[] => {
  if (platform === 'linux') return LINUX_BROWSERS;
  return [];
};

const userConfigRoot = (
  env: { HOME?: string; XDG_CONFIG_HOME?: string },
  platform: NodeJS.Platform,
): string => {
  if (platform !== 'linux') {
    throw new Error(`browser_paths: platform ${platform} not yet supported`);
  }
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) {
    return env.XDG_CONFIG_HOME;
  }
  if (env.HOME) return join(env.HOME, '.config');
  throw new Error('browser_paths: cannot resolve config root; HOME and XDG_CONFIG_HOME both unset');
};

export const manifestDirForBrowser = (
  browser: BrowserConfig,
  env: { HOME?: string; XDG_CONFIG_HOME?: string },
  platform: NodeJS.Platform,
): string => {
  const root = userConfigRoot(env, platform);
  return join(root, ...browser.configDirSegments, NMH_DIR);
};

const browserProfileRoot = (
  browser: BrowserConfig,
  env: { HOME?: string; XDG_CONFIG_HOME?: string },
  platform: NodeJS.Platform,
): string => join(userConfigRoot(env, platform), ...browser.configDirSegments);

export const findInstalledBrowsers = async (
  env: { HOME?: string; XDG_CONFIG_HOME?: string },
  platform: NodeJS.Platform,
  exists: (absPath: string) => Promise<boolean>,
): Promise<readonly InstalledBrowser[]> => {
  const supported = listSupportedBrowsers(platform);
  const out: InstalledBrowser[] = [];
  for (const browser of supported) {
    const profileRoot = browserProfileRoot(browser, env, platform);
    if (await exists(profileRoot)) {
      out.push({
        name: browser.name,
        manifestDir: manifestDirForBrowser(browser, env, platform),
      });
    }
  }
  return out;
};
