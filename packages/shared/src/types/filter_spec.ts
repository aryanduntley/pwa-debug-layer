import type { ConsoleLevel } from './captured_event.js';

export type Cursor = string & { readonly __brand: 'PwaDebugCursor' };

export type CursorParts = {
  readonly sessionId: string;
  readonly sequenceNumber: number;
};

export type CursorDecodeResult =
  | { readonly ok: true; readonly value: CursorParts }
  | { readonly ok: false; readonly error: string };

export type FilterPattern = {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
};

export type FilterSpec = {
  readonly level?: readonly ConsoleLevel[];
  readonly pattern?: FilterPattern;
  readonly since?: Cursor;
  readonly until?: Cursor;
  readonly limit?: number;
  readonly selectors?: readonly string[];
};

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const encodeAsciiToBase64Url = (ascii: string): string => {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < ascii.length; i++) {
    buffer = (buffer << 8) | (ascii.charCodeAt(i) & 0xff);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64_ALPHABET.charAt((buffer >> bits) & 0x3f);
    }
  }
  if (bits > 0) {
    out += B64_ALPHABET.charAt((buffer << (6 - bits)) & 0x3f);
  }
  return out;
};

const decodeBase64UrlToAscii = (s: string): string | null => {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
};

export const encodeCursor = (parts: CursorParts): Cursor => {
  const json = JSON.stringify({
    sid: parts.sessionId,
    seq: parts.sequenceNumber,
  });
  return encodeAsciiToBase64Url(json) as Cursor;
};

export const decodeCursor = (cursor: string): CursorDecodeResult => {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return { ok: false, error: 'cursor is empty' };
  }
  const json = decodeBase64UrlToAscii(cursor);
  if (json === null) {
    return { ok: false, error: 'cursor contains non-base64url characters' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'cursor payload is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'cursor payload is not an object' };
  }
  const obj = parsed as { readonly sid?: unknown; readonly seq?: unknown };
  if (typeof obj.sid !== 'string' || obj.sid.length === 0) {
    return { ok: false, error: 'cursor.sid missing or not a non-empty string' };
  }
  if (
    typeof obj.seq !== 'number' ||
    !Number.isFinite(obj.seq) ||
    !Number.isInteger(obj.seq)
  ) {
    return { ok: false, error: 'cursor.seq missing or not a finite integer' };
  }
  return {
    ok: true,
    value: { sessionId: obj.sid, sequenceNumber: obj.seq },
  };
};
