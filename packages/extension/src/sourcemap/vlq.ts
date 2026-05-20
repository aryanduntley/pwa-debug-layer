/**
 * Base64 VLQ (variable-length quantity) decoder used by Source Map v3.
 *
 * Each character encodes 6 bits. The lowest bit of the FIRST 6-bit group is
 * the sign bit; every subsequent 6-bit group's high bit is the continuation
 * flag. Values are little-endian within the encoded form.
 *
 * Pure: no I/O, no mutation past the local accumulators.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const CHAR_TO_VAL: Readonly<Record<string, number>> = ((): Record<string, number> => {
  const m: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) {
    m[ALPHABET.charAt(i)] = i;
  }
  return m;
})();

const CONTINUATION_BIT = 1 << 5; // 0b100000
const VALUE_MASK = (1 << 5) - 1; // 0b011111

export type VlqDecodeResult =
  | { readonly ok: true; readonly values: readonly number[] }
  | { readonly ok: false; readonly error: string };

export const decodeVlqList = (s: string): VlqDecodeResult => {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const digit = CHAR_TO_VAL[ch];
    if (digit === undefined) {
      return { ok: false, error: `invalid base64 char '${ch}' at ${i}` };
    }
    const continuation = (digit & CONTINUATION_BIT) !== 0;
    const payload = digit & VALUE_MASK;
    value |= payload << shift;
    if (continuation) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    const magnitude = value >>> 1;
    out.push(negative ? -magnitude : magnitude);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) {
    return { ok: false, error: 'truncated VLQ — last value missing terminator' };
  }
  return { ok: true, values: out };
};
