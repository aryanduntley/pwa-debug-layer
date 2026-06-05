/**
 * Wire types for the `pwa_update_analyze` tool — a T3 *analysis* surface that
 * composes already-exposed primitives (service-worker status, CacheStorage
 * entry ages, and recent network failures) into a structured update-propagation
 * / version-skew diagnosis. No new capture surface: every input is read by an
 * existing reader and correlated here.
 *
 * It answers the two classic "my deploy went out but users are broken" failure
 * modes: (1) an updated service worker is installed but waiting while clients
 * stay on the old worker, and (2) HTML cached longer than JS, so stale HTML
 * references chunk hashes the newer JS no longer ships — producing chunk 404s.
 *
 * Pure type module (no runtime). The pure analyzer lives in the host
 * `update_analysis` module; the page-world gather lives in the extension
 * `update_analysis` module.
 */

import type { CacheEntryRecord } from './cache_storage.js';
import type { SwStatusSnapshot, SwWorkerRecord } from './sw_status.js';

/** Coarse asset class of a cached entry, by content-type then URL extension. */
export type AssetKind = 'html' | 'js' | 'css' | 'other';

/** A cached asset reduced to the fields the skew analysis reasons over. */
export type CachedAssetAge = {
  readonly url: string;
  readonly kind: AssetKind;
  /** now − Date header, in seconds; null when the entry had no Date header. */
  readonly ageSeconds: number | null;
  readonly cacheName: string;
};

/** One recent network failure (status ≥ 400) pulled from the network buffer. */
export type NetworkFailure = {
  readonly url: string;
  readonly status: number;
};

/** A distinct diagnosis code the analyzer can emit. */
export type UpdateFindingCode =
  | 'waiting_update_active_client'
  | 'html_older_js'
  | 'chunk_404';

/** One finding in the diagnosis. */
export type UpdateFinding = {
  readonly code: UpdateFindingCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
};

/** Full structured diagnosis returned by `pwa_update_analyze`. */
export type UpdateAnalysisResult = {
  /** False when service workers are unavailable here (insecure/unsupported). */
  readonly supported: boolean;
  /** True if any registration has a waiting (installed-but-not-active) worker. */
  readonly hasWaitingUpdate: boolean;
  /** The worker controlling this client; null if none. */
  readonly controller: SwWorkerRecord | null;
  readonly findings: readonly UpdateFinding[];
  /** Cached HTML assets considered, oldest first. */
  readonly cachedHtml: readonly CachedAssetAge[];
  /** Cached JS assets considered, newest first. */
  readonly cachedJs: readonly CachedAssetAge[];
  /** JS-ish network failures (404 etc.) correlated as chunk misses. */
  readonly chunk404s: readonly NetworkFailure[];
  /** One-line human summary tying the findings together. */
  readonly summary: string;
};

/**
 * Page-world gather payload: the raw inputs the host analyzer needs in a single
 * IPC round-trip (service-worker snapshot + a capped, cross-cache list of
 * entries). The host pulls network failures from its own ring buffer and runs
 * the analysis.
 */
export type UpdateGatherResult = {
  readonly sw: SwStatusSnapshot;
  readonly cacheEntries: readonly (CacheEntryRecord & { readonly cacheName: string })[];
};
