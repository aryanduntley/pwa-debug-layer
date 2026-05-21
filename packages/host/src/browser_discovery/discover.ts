/**
 * Browser-discovery orchestrator — the single public entry point.
 *
 * Thin composition: locate executables (discover_binaries) + the system
 * default (default_browser), then stamp `isDefault` on the matching row. No OS
 * logic lives here. The future pdl_browser_status MCP tool (M17) consumes this.
 */
import { discoverBinaries } from './discover_binaries.js';
import { detectDefaultBrowser } from './default_browser.js';
import type {
  BrowserDiscoveryResult,
  DiscoveredBrowser,
  DiscoveryDeps,
  EnvSnapshot,
} from './types.js';

export const discoverBrowsers = async (
  platform: NodeJS.Platform,
  env: EnvSnapshot,
  deps: DiscoveryDeps,
): Promise<BrowserDiscoveryResult> => {
  const located = await discoverBinaries(platform, env, deps);
  const defaultBrowser = await detectDefaultBrowser(platform, deps);
  const browsers: readonly DiscoveredBrowser[] = Object.freeze(
    located.map((b) =>
      Object.freeze({ ...b, isDefault: b.browser === defaultBrowser }),
    ),
  );
  return Object.freeze({ platform, browsers, defaultBrowser });
};
