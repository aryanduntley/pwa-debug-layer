/**
 * Pure PWA installability logic: summarize a parsed manifest, then run the
 * installability rules engine. No fetch / DOM — the edge (read.ts) gathers the
 * manifest + context and hands them here, so every rule is unit-testable.
 */

import type {
  ManifestSummary,
  ManifestIconSummary,
  InstallabilityGap,
  InstallabilityGapCode,
} from '@pwa-debug/shared';

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

const summarizeIcon = (raw: unknown): ManifestIconSummary | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const src = str(r['src']);
  if (src === null) return null;
  return {
    src,
    sizes: str(r['sizes']),
    type: str(r['type']),
    purpose: str(r['purpose']),
  };
};

export const summarizeManifest = (raw: unknown): ManifestSummary => {
  const r =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
  const iconsRaw = Array.isArray(r['icons']) ? r['icons'] : [];
  const icons = iconsRaw
    .map(summarizeIcon)
    .filter((i): i is ManifestIconSummary => i !== null);
  return {
    name: str(r['name']),
    shortName: str(r['short_name']),
    startUrl: str(r['start_url']),
    scope: str(r['scope']),
    display: str(r['display']),
    themeColor: str(r['theme_color']),
    backgroundColor: str(r['background_color']),
    icons,
  };
};

const APP_DISPLAY_MODES: readonly string[] = ['standalone', 'fullscreen', 'minimal-ui'];

const tokens = (raw: string | null): readonly string[] =>
  raw === null ? [] : raw.trim().toLowerCase().split(/\s+/);

const hasIconSize = (
  icons: readonly ManifestIconSummary[],
  target: string,
): boolean =>
  icons.some((i) => {
    const t = tokens(i.sizes);
    return t.includes(target) || t.includes('any');
  });

const hasMaskableIcon = (icons: readonly ManifestIconSummary[]): boolean =>
  icons.some((i) => tokens(i.purpose).includes('maskable'));

const gap = (
  code: InstallabilityGapCode,
  severity: 'error' | 'warning',
  message: string,
  fix: string,
): InstallabilityGap => ({ code, severity, message, fix });

export type InstallabilityInput = {
  readonly manifestFound: boolean;
  readonly manifestParseError: boolean;
  readonly manifest: ManifestSummary | null;
  readonly secureContext: boolean;
  readonly hasServiceWorker: boolean;
};

export const evaluateInstallability = (
  input: InstallabilityInput,
): { readonly installable: boolean; readonly gaps: InstallabilityGap[] } => {
  const gaps: InstallabilityGap[] = [];

  if (!input.secureContext) {
    gaps.push(
      gap(
        'not_secure_context',
        'error',
        'The page is not in a secure context.',
        'Serve the app over HTTPS (localhost is treated as secure for development).',
      ),
    );
  }
  if (!input.hasServiceWorker) {
    gaps.push(
      gap(
        'no_service_worker',
        'error',
        'No service worker is registered for this page.',
        'Register a service worker with a fetch handler via navigator.serviceWorker.register().',
      ),
    );
  }
  if (!input.manifestFound) {
    gaps.push(
      gap(
        'no_manifest',
        'error',
        'No web app manifest was found.',
        'Add <link rel="manifest" href="/manifest.webmanifest"> and serve a valid manifest.',
      ),
    );
    return { installable: false, gaps };
  }
  if (input.manifestParseError || input.manifest === null) {
    gaps.push(
      gap(
        'manifest_parse_error',
        'error',
        'The web app manifest could not be parsed as JSON.',
        'Ensure the manifest is valid JSON served with a JSON content type.',
      ),
    );
    return { installable: false, gaps };
  }

  const m = input.manifest;
  if (m.name === null && m.shortName === null) {
    gaps.push(
      gap(
        'no_name',
        'error',
        'The manifest has neither "name" nor "short_name".',
        'Add a "name" (and ideally a "short_name") to the manifest.',
      ),
    );
  }
  if (m.startUrl === null) {
    gaps.push(
      gap(
        'no_start_url',
        'error',
        'The manifest has no "start_url".',
        'Add a "start_url" (e.g. "/") to the manifest.',
      ),
    );
  }
  if (m.display === null || !APP_DISPLAY_MODES.includes(m.display)) {
    gaps.push(
      gap(
        'display_not_app',
        'error',
        `The manifest "display" is "${m.display ?? '(none)'}", not an app display mode.`,
        'Set "display" to "standalone", "fullscreen", or "minimal-ui".',
      ),
    );
  }
  if (!hasIconSize(m.icons, '192x192')) {
    gaps.push(
      gap(
        'no_192_icon',
        'error',
        'No 192x192 icon in the manifest.',
        'Add an icon entry with "sizes": "192x192".',
      ),
    );
  }
  if (!hasIconSize(m.icons, '512x512')) {
    gaps.push(
      gap(
        'no_512_icon',
        'error',
        'No 512x512 icon in the manifest.',
        'Add an icon entry with "sizes": "512x512".',
      ),
    );
  }
  if (!hasMaskableIcon(m.icons)) {
    gaps.push(
      gap(
        'no_maskable_icon',
        'warning',
        'No maskable icon in the manifest.',
        'Add an icon with "purpose": "maskable" for adaptive icons (recommended, not required).',
      ),
    );
  }

  const installable = gaps.every((g) => g.severity !== 'error');
  return { installable, gaps };
};
