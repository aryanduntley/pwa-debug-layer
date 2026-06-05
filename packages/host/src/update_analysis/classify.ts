/**
 * Pure classification of a cached/requested asset into a coarse AssetKind, by
 * content-type first (authoritative) then URL extension (fallback when the
 * cached response had no content-type). No I/O — used by the update-skew
 * analyzer to separate HTML from JS when reasoning about version skew.
 */

import type { AssetKind } from '@pwa-debug/shared';

const stripUrl = (url: string): string => {
  // Drop query + fragment so `app.abc123.js?v=2` classifies by its .js path.
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const cut = [q, h].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return cut === undefined ? url : url.slice(0, cut);
};

const extensionKind = (url: string): AssetKind => {
  const path = stripUrl(url).toLowerCase();
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'js';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'html';
  // A bare navigation URL (no file extension, e.g. "/", "/app") is HTML.
  const lastSegment = path.split('/').pop() ?? '';
  if (!lastSegment.includes('.')) return 'html';
  return 'other';
};

const contentTypeKind = (contentType: string): AssetKind | null => {
  const ct = contentType.toLowerCase();
  if (ct.includes('html')) return 'html';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
  if (ct.includes('css')) return 'css';
  return null;
};

/**
 * Classify an asset. content-type wins when it maps to a known kind; otherwise
 * fall back to the URL extension (a bare navigation path counts as HTML).
 */
export const classifyAsset = (
  url: string,
  contentType: string | null,
): AssetKind => {
  if (contentType !== null) {
    const byType = contentTypeKind(contentType);
    if (byType !== null) return byType;
  }
  return extensionKind(url);
};
