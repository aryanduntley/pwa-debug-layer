/**
 * Locate the source-map URL for a script. Scans the tail of the script text
 * for canonical //# sourceMappingURL=... (or deprecated //@) comments and
 * resolves the URL against the script's own URL. Data URLs are returned as-is
 * (a future step would base64-decode them; out of scope for M13 T1).
 *
 * Pure.
 */

const TAIL_BYTES = 4096;

// Matches //# sourceMappingURL=<url>  or //@ sourceMappingURL=<url>
const MAPPING_URL_RE = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/im;

export const discoverSourceMapUrl = (
  scriptUrl: string,
  scriptText: string,
): string | null => {
  const tail = scriptText.length > TAIL_BYTES
    ? scriptText.slice(scriptText.length - TAIL_BYTES)
    : scriptText;
  const match = MAPPING_URL_RE.exec(tail);
  if (match === null) return null;
  const raw = match[1];
  if (raw === undefined || raw.length === 0) return null;
  if (raw.startsWith('data:')) return raw;
  try {
    return new URL(raw, scriptUrl).toString();
  } catch {
    return null;
  }
};
