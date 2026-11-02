/** CSS color parsing and WCAG contrast math. Pure. */

export type Rgba = { readonly r: number; readonly g: number; readonly b: number; readonly a: number };

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const parseChannel = (s: string): number =>
  s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s);

const parseAlpha = (s: string | undefined): number =>
  s === undefined ? 1 : s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);

const fromHex = (hex: string): Rgba | null => {
  const h = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
};

/**
 * Parse rgb()/rgba() (comma or space syntax, optional / alpha), #rgb[a] /
 * #rrggbb[aa] and `transparent`. Anything else (color(), oklch(), named
 * colors) returns null so callers can skip rather than guess.
 */
export const parseCssColor = (input: string): Rgba | null => {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith('#')) return fromHex(s.slice(1));
  const m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m === null) return null;
  const parts = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const [r, g, b, a] = parts;
  const out = {
    r: parseChannel(r as string),
    g: parseChannel(g as string),
    b: parseChannel(b as string),
    a: clamp01(parseAlpha(a)),
  };
  return [out.r, out.g, out.b, out.a].every(Number.isFinite) ? out : null;
};

/** Source-over composite of `top` onto an opaque-or-not `bottom`. */
export const blendOver = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
};

const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an opaque color. */
export const relativeLuminance = (c: Rgba): number =>
  0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);

/** WCAG contrast ratio (1..21) between two opaque colors. */
export const contrastRatio = (a: Rgba, b: Rgba): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
