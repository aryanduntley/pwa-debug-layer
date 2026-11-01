// A bare javascript: URL would run script in the target page context on navigate;
// reject it. Everything else (http(s), file:, about:, data:, chrome:, localhost
// shorthand) is allowed — this is a debugging driver, not a sandbox.
const JAVASCRIPT_SCHEME = /^javascript:/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Normalize a caller-supplied navigation URL: trim, reject empty / javascript:,
 * and assume https:// when no scheme is given (so `example.com` works). Returns
 * null when the input is unusable so the caller can surface a clear error.
 * Shared by the extension (chrome.tabs) and the host (CDP Page.navigate) so both
 * navigation paths accept exactly the same URLs.
 */
export const normalizeUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (JAVASCRIPT_SCHEME.test(trimmed)) return null;
  return HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
};
