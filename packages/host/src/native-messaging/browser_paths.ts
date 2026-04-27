import { join } from 'node:path';

export type BrowserName =
  | 'chrome'
  | 'chromium'
  | 'edge'
  | 'brave'
  | 'vivaldi'
  | 'opera';

export type InstallKind = 'native' | 'snap' | 'flatpak' | 'registry';

export type EnvSnapshot = {
  readonly HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly APPDATA?: string;
  readonly LOCALAPPDATA?: string;
  readonly USERPROFILE?: string;
};

export type BrowserInstall =
  | {
      readonly browser: BrowserName;
      readonly kind: 'native' | 'snap' | 'flatpak';
      readonly manifestDir: string;
      readonly caveat?: string;
    }
  | {
      readonly browser: BrowserName;
      readonly kind: 'registry';
      readonly registryHive: 'HKCU';
      readonly registrySubkey: string;
      readonly caveat?: string;
    };

const NMH_DIR = 'NativeMessagingHosts';
const HOST_NAME = 'com.pwa_debug.host';

const SNAP_CAVEAT =
  'Snap confinement requires the host launcher and bundled main.js to be under $HOME (the snap home interface). If the connect fails, move the host into your home directory.';

const flatpakCaveat = (appId: string): string =>
  `Flatpak confinement may block host execution. If the connect fails, run \`flatpak override --user --filesystem=host ${appId}\` and retry.`;

type LinuxNativeEntry = {
  readonly name: BrowserName;
  readonly segments: readonly string[];
};

const LINUX_NATIVE: readonly LinuxNativeEntry[] = Object.freeze([
  { name: 'chrome', segments: Object.freeze(['google-chrome']) },
  { name: 'chromium', segments: Object.freeze(['chromium']) },
  { name: 'edge', segments: Object.freeze(['microsoft-edge']) },
  { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
  { name: 'vivaldi', segments: Object.freeze(['vivaldi']) },
  { name: 'opera', segments: Object.freeze(['opera']) },
]);

type LinuxSnapEntry = {
  readonly name: BrowserName;
  readonly snapPackage: string;
  readonly configRelative: readonly string[];
};

const LINUX_SNAP: readonly LinuxSnapEntry[] = Object.freeze([
  {
    name: 'chromium',
    snapPackage: 'chromium',
    configRelative: Object.freeze(['common', 'chromium']),
  },
  {
    name: 'chrome',
    snapPackage: 'google-chrome',
    configRelative: Object.freeze(['common', '.config', 'google-chrome']),
  },
]);

type LinuxFlatpakEntry = {
  readonly name: BrowserName;
  readonly appId: string;
  readonly configSegments: readonly string[];
};

const LINUX_FLATPAK: readonly LinuxFlatpakEntry[] = Object.freeze([
  {
    name: 'chromium',
    appId: 'org.chromium.Chromium',
    configSegments: Object.freeze(['chromium']),
  },
  {
    name: 'chrome',
    appId: 'com.google.Chrome',
    configSegments: Object.freeze(['google-chrome']),
  },
  {
    name: 'edge',
    appId: 'com.microsoft.Edge',
    configSegments: Object.freeze(['microsoft-edge']),
  },
  {
    name: 'brave',
    appId: 'com.brave.Browser',
    configSegments: Object.freeze(['BraveSoftware', 'Brave-Browser']),
  },
  {
    name: 'vivaldi',
    appId: 'com.vivaldi.Vivaldi',
    configSegments: Object.freeze(['vivaldi']),
  },
  {
    name: 'opera',
    appId: 'com.opera.Opera',
    configSegments: Object.freeze(['opera']),
  },
]);

type MacEntry = {
  readonly name: BrowserName;
  readonly segments: readonly string[];
};

const MAC_BROWSERS: readonly MacEntry[] = Object.freeze([
  { name: 'chrome', segments: Object.freeze(['Google', 'Chrome']) },
  { name: 'chromium', segments: Object.freeze(['Chromium']) },
  { name: 'edge', segments: Object.freeze(['Microsoft Edge']) },
  { name: 'brave', segments: Object.freeze(['BraveSoftware', 'Brave-Browser']) },
  { name: 'vivaldi', segments: Object.freeze(['Vivaldi']) },
  { name: 'opera', segments: Object.freeze(['com.operasoftware.Opera']) },
]);

type WinEntry = {
  readonly name: BrowserName;
  readonly vendorPath: string;
  readonly userDataSegments: readonly string[];
};

const WIN_BROWSERS: readonly WinEntry[] = Object.freeze([
  {
    name: 'chrome',
    vendorPath: 'Google\\Chrome',
    userDataSegments: Object.freeze(['Google', 'Chrome', 'User Data']),
  },
  {
    name: 'chromium',
    vendorPath: 'Chromium',
    userDataSegments: Object.freeze(['Chromium', 'User Data']),
  },
  {
    name: 'edge',
    vendorPath: 'Microsoft\\Edge',
    userDataSegments: Object.freeze(['Microsoft', 'Edge', 'User Data']),
  },
  {
    name: 'brave',
    vendorPath: 'BraveSoftware\\Brave-Browser',
    userDataSegments: Object.freeze(['BraveSoftware', 'Brave-Browser', 'User Data']),
  },
  {
    name: 'vivaldi',
    vendorPath: 'Vivaldi',
    userDataSegments: Object.freeze(['Vivaldi', 'User Data']),
  },
  {
    name: 'opera',
    vendorPath: 'Opera Software\\Opera Stable',
    userDataSegments: Object.freeze(['Opera Software', 'Opera Stable']),
  },
]);

const linuxConfigRoot = (env: EnvSnapshot): string => {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) return env.XDG_CONFIG_HOME;
  if (env.HOME) return join(env.HOME, '.config');
  throw new Error('browser_paths: cannot resolve config root; HOME and XDG_CONFIG_HOME both unset');
};

const macSupportRoot = (env: EnvSnapshot): string => {
  if (!env.HOME) throw new Error('browser_paths: HOME unset on darwin');
  return join(env.HOME, 'Library', 'Application Support');
};

const winLocalAppData = (env: EnvSnapshot): string | null => {
  if (env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0) return env.LOCALAPPDATA;
  if (env.USERPROFILE && env.USERPROFILE.length > 0) {
    return join(env.USERPROFILE, 'AppData', 'Local');
  }
  return null;
};

const detectLinux = async (
  env: EnvSnapshot,
  exists: (p: string) => Promise<boolean>,
): Promise<readonly BrowserInstall[]> => {
  const out: BrowserInstall[] = [];
  const cfg = linuxConfigRoot(env);
  for (const b of LINUX_NATIVE) {
    const profile = join(cfg, ...b.segments);
    if (await exists(profile)) {
      out.push(
        Object.freeze({
          browser: b.name,
          kind: 'native' as const,
          manifestDir: join(profile, NMH_DIR),
        }),
      );
    }
  }
  if (env.HOME) {
    for (const b of LINUX_SNAP) {
      const profile = join(env.HOME, 'snap', b.snapPackage, ...b.configRelative);
      if (await exists(profile)) {
        out.push(
          Object.freeze({
            browser: b.name,
            kind: 'snap' as const,
            manifestDir: join(profile, NMH_DIR),
            caveat: SNAP_CAVEAT,
          }),
        );
      }
    }
    for (const b of LINUX_FLATPAK) {
      const appRoot = join(env.HOME, '.var', 'app', b.appId);
      if (await exists(appRoot)) {
        out.push(
          Object.freeze({
            browser: b.name,
            kind: 'flatpak' as const,
            manifestDir: join(appRoot, 'config', ...b.configSegments, NMH_DIR),
            caveat: flatpakCaveat(b.appId),
          }),
        );
      }
    }
  }
  return Object.freeze(out);
};

const detectDarwin = async (
  env: EnvSnapshot,
  exists: (p: string) => Promise<boolean>,
): Promise<readonly BrowserInstall[]> => {
  const out: BrowserInstall[] = [];
  const root = macSupportRoot(env);
  for (const b of MAC_BROWSERS) {
    const profile = join(root, ...b.segments);
    if (await exists(profile)) {
      out.push(
        Object.freeze({
          browser: b.name,
          kind: 'native' as const,
          manifestDir: join(profile, NMH_DIR),
        }),
      );
    }
  }
  return Object.freeze(out);
};

const detectWin32 = async (
  env: EnvSnapshot,
  exists: (p: string) => Promise<boolean>,
): Promise<readonly BrowserInstall[]> => {
  const local = winLocalAppData(env);
  if (!local) return Object.freeze([]);
  const out: BrowserInstall[] = [];
  for (const b of WIN_BROWSERS) {
    const userDataDir = join(local, ...b.userDataSegments);
    if (await exists(userDataDir)) {
      out.push(
        Object.freeze({
          browser: b.name,
          kind: 'registry' as const,
          registryHive: 'HKCU' as const,
          registrySubkey: `Software\\${b.vendorPath}\\NativeMessagingHosts\\${HOST_NAME}`,
        }),
      );
    }
  }
  return Object.freeze(out);
};

export const detectBrowserInstalls = async (
  env: EnvSnapshot,
  platform: NodeJS.Platform,
  exists: (absPath: string) => Promise<boolean>,
): Promise<readonly BrowserInstall[]> => {
  if (platform === 'linux') return detectLinux(env, exists);
  if (platform === 'darwin') return detectDarwin(env, exists);
  if (platform === 'win32') return detectWin32(env, exists);
  return Object.freeze([]);
};
