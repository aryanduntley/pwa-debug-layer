/**
 * Pure update-propagation / version-skew analyzer. Correlates three
 * already-exposed primitives — a service-worker snapshot, cached asset ages,
 * and recent network failures — into a structured UpdateAnalysisResult. No I/O:
 * the host tool gathers the inputs and hands them in, keeping this unit-testable
 * with plain objects.
 *
 * Detections:
 *  - waiting_update_active_client: a worker is installed and WAITING while this
 *    client is still controlled by the old active worker (the classic "update
 *    won't show until all tabs close / skipWaiting").
 *  - html_older_js: cached navigation HTML is materially OLDER than cached JS,
 *    so the stale HTML references chunk hashes the newer JS no longer ships —
 *    the setup for chunk 404s.
 *  - chunk_404: recent JS/CSS chunk requests that failed (status ≥ 400),
 *    corroborating the skew with observed misses.
 */

import type {
  CacheEntryRecord,
  CachedAssetAge,
  NetworkFailure,
  UpdateAnalysisResult,
  UpdateFinding,
  SwStatusSnapshot,
} from '@pwa-debug/shared';
import { classifyAsset } from './classify.js';

/** Cached HTML older than cached JS by this many seconds ⇒ flag version skew. */
export const SKEW_THRESHOLD_SECONDS = 3600;

/** Keep result arrays bounded so a large cache cannot blow the payload. */
const MAX_LISTED = 50;

export type AnalyzeOptions = {
  /** Override the HTML-older-than-JS skew threshold (seconds). */
  readonly skewThresholdSeconds?: number;
};

type CacheEntryWithName = CacheEntryRecord & { readonly cacheName: string };

const toAssetAge = (entry: CacheEntryWithName): CachedAssetAge => ({
  url: entry.url,
  kind: classifyAsset(entry.url, entry.contentType),
  ageSeconds: entry.ageSeconds,
  cacheName: entry.cacheName,
});

const hasAge = (a: CachedAssetAge): a is CachedAssetAge & { ageSeconds: number } =>
  a.ageSeconds !== null;

/** Analyze the gathered SW + cache + network inputs into a structured diagnosis. */
export const analyzeUpdateSkew = (
  sw: SwStatusSnapshot,
  cacheEntries: readonly CacheEntryWithName[],
  failures: readonly NetworkFailure[],
  options: AnalyzeOptions = {},
): UpdateAnalysisResult => {
  const threshold = options.skewThresholdSeconds ?? SKEW_THRESHOLD_SECONDS;

  const assets = cacheEntries.map(toAssetAge);
  // HTML oldest first; JS newest first (smallest age first).
  const cachedHtml = assets
    .filter((a) => a.kind === 'html')
    .sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1))
    .slice(0, MAX_LISTED);
  const cachedJs = assets
    .filter((a) => a.kind === 'js')
    .sort((a, b) => (a.ageSeconds ?? Infinity) - (b.ageSeconds ?? Infinity))
    .slice(0, MAX_LISTED);

  const chunk404s = failures
    .filter((f) => {
      const kind = classifyAsset(f.url, null);
      return (kind === 'js' || kind === 'css') && f.status >= 400;
    })
    .slice(0, MAX_LISTED);

  const findings: UpdateFinding[] = [];

  if (sw.hasWaitingUpdate && sw.controller !== null) {
    findings.push({
      code: 'waiting_update_active_client',
      severity: 'warning',
      message:
        'An updated service worker is installed and WAITING, but this page is still controlled by the old active worker. The update will not take effect until every client (tab) for this scope is closed, or the worker calls skipWaiting() + clients.claim().',
    });
  }

  const htmlAges = cachedHtml.filter(hasAge);
  const jsAges = cachedJs.filter(hasAge);
  if (htmlAges.length > 0 && jsAges.length > 0) {
    const oldestHtml = Math.max(...htmlAges.map((a) => a.ageSeconds));
    const newestJs = Math.min(...jsAges.map((a) => a.ageSeconds));
    if (oldestHtml - newestJs >= threshold) {
      findings.push({
        code: 'html_older_js',
        severity: 'warning',
        message: `Cached HTML is ~${Math.round((oldestHtml - newestJs) / 60)} min older than cached JS (oldest HTML ${oldestHtml}s vs newest JS ${newestJs}s). Stale cached HTML can reference chunk hashes the newer JS no longer ships — the cause of chunk 404s after a deploy. Consider a network-first / shorter cache for navigation HTML.`,
      });
    }
  }

  if (chunk404s.length > 0) {
    findings.push({
      code: 'chunk_404',
      severity: 'error',
      message: `${chunk404s.length} recent JS/CSS chunk request(s) failed (status ≥ 400) — e.g. ${chunk404s[0]!.url} → ${chunk404s[0]!.status}. This is the live symptom of version skew: clients running stale HTML are requesting chunks that no longer exist.`,
    });
  }

  const summary = !sw.supported
    ? 'Service workers are unavailable in this context — no update-propagation analysis possible.'
    : findings.length === 0
      ? 'No update-propagation or version-skew issues detected.'
      : findings.map((f) => f.code).join(', ');

  return {
    supported: sw.supported,
    hasWaitingUpdate: sw.hasWaitingUpdate,
    controller: sw.controller,
    findings,
    cachedHtml,
    cachedJs,
    chunk404s,
    summary,
  };
};
