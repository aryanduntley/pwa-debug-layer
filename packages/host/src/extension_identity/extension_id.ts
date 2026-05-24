import { createHash } from 'node:crypto';

/**
 * Chrome derives an unpacked/keyed extension's ID from its public key: take the
 * SHA-256 of the DER-encoded SPKI public key, keep the first 16 bytes, and map
 * each hex nibble 0-f onto a-p ("mpdecimal"). When a manifest pins a `key`
 * (base64 SPKI), the ID is therefore deterministic across machines and load
 * paths — which is exactly why we pin one. This module owns that derivation so
 * the host can compute the bundled extension's expected ID and compare it to
 * what is actually registered/loaded.
 */

const HEX_TO_MPDECIMAL = 'abcdefghijklmnop';

/**
 * Pure: derive the Chrome extension ID from a manifest `key` (base64 SPKI DER).
 * Returns the 32-char a-p id. Does not validate that the input is a real key —
 * any base64 produces a deterministic id (Chrome behaves the same way).
 */
export const deriveExtensionIdFromKey = (keyB64: string): string => {
  const der = Buffer.from(keyB64, 'base64');
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = digest[i] ?? 0;
    id += HEX_TO_MPDECIMAL[(byte >> 4) & 0xf];
    id += HEX_TO_MPDECIMAL[byte & 0xf];
  }
  return id;
};

/**
 * Read a bundled extension's manifest.json and derive the ID its pinned `key`
 * resolves to. Returns null when the manifest is missing/unreadable, not valid
 * JSON, or carries no string `key` (an unkeyed manifest has a path-derived ID
 * the host cannot predict). readFile is injected so the derivation is testable
 * without touching the filesystem.
 */
export const deriveBundledExtensionId = async (
  manifestPath: string,
  readFile: (path: string) => Promise<string>,
): Promise<string | null> => {
  let raw: string;
  try {
    raw = await readFile(manifestPath);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const key =
    typeof parsed === 'object' && parsed !== null && 'key' in parsed
      ? (parsed as { readonly key?: unknown }).key
      : undefined;
  if (typeof key !== 'string' || key.length === 0) return null;
  return deriveExtensionIdFromKey(key);
};
