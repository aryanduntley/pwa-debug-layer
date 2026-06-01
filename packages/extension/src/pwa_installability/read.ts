/**
 * Async edge: discover + fetch + parse the web app manifest, then run the pure
 * installability rules. Manifest href / base URL / context / fetch are injected
 * so this is unit-testable; the page-world handler supplies the real DOM + fetch.
 */

import type { ManifestSummary, InstallabilityResult } from '@pwa-debug/shared';
import { summarizeManifest, evaluateInstallability } from './project.js';

export type FetchTextResult = {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
};

export type InstallabilityEnv = {
  readonly manifestHref: string | null;
  readonly baseUrl: string;
  readonly secureContext: boolean;
  readonly hasServiceWorker: boolean;
  readonly fetchText: (url: string) => Promise<FetchTextResult>;
};

const resolveUrl = (href: string, base: string): string | null => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

export const readInstallability = async (
  env: InstallabilityEnv,
): Promise<InstallabilityResult> => {
  const finish = (
    manifestUrl: string | null,
    manifestFound: boolean,
    manifestParseError: boolean,
    manifest: ManifestSummary | null,
  ): InstallabilityResult => {
    const { installable, gaps } = evaluateInstallability({
      manifestFound,
      manifestParseError,
      manifest,
      secureContext: env.secureContext,
      hasServiceWorker: env.hasServiceWorker,
    });
    return {
      supported: true,
      manifestUrl,
      manifestFound,
      secureContext: env.secureContext,
      hasServiceWorker: env.hasServiceWorker,
      manifest,
      installable,
      gaps,
    };
  };

  if (env.manifestHref === null) return finish(null, false, false, null);

  const manifestUrl = resolveUrl(env.manifestHref, env.baseUrl);
  if (manifestUrl === null) return finish(null, false, false, null);

  let fetched: FetchTextResult;
  try {
    fetched = await env.fetchText(manifestUrl);
  } catch {
    return finish(manifestUrl, false, false, null);
  }
  if (!fetched.ok) return finish(manifestUrl, false, false, null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.text);
  } catch {
    return finish(manifestUrl, true, true, null);
  }

  return finish(manifestUrl, true, false, summarizeManifest(parsed));
};
