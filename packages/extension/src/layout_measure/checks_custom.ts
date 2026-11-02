/**
 * Caller-defined checks (layout_sweep custom_checks). Each expression is
 * compiled in the page (same new Function path as `evaluate` and
 * states.apply, so a CSP without unsafe-eval blocks it there too) and called
 * with the view's variables and a read-only helper bag built on the same
 * measurement context as the built-in checks.
 */
import {
  CUSTOM_CHECK_LIMITS,
  customCheckId,
  type CustomCheck,
  type CustomCheckError,
  type LayoutFinding,
} from '@pwa-debug/shared';
import type { MeasureContext } from './geometry.js';
import { accessibleName, elementFinding, elementSignature } from './element_info.js';
import { effectiveBackground, inkExtents, visibleEdges } from './paint.js';

const MESSAGE_MAX = 300;
const SIGNATURE_MAX = 120;

const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const isElement = (v: unknown): v is Element =>
  v !== null && typeof v === 'object' && (v as { nodeType?: unknown }).nodeType === 1;

/**
 * The `pdl` object a custom check receives. Every read goes through the
 * measurement context, so visibility and edges are judged exactly as the
 * built-in checks judge them.
 */
export const customHelpers = (ctx: MeasureContext) =>
  Object.freeze({
    root: ctx.root,
    viewport: ctx.viewport,
    /** Visible, non-exempt elements under the root, optionally matching a selector. */
    elements: (selector?: string): readonly Element[] =>
      [...ctx.root.querySelectorAll(selector ?? '*')].filter((el) => ctx.isVisible(el) && !ctx.isExempt(el)),
    isVisible: (el: Element): boolean => ctx.isVisible(el),
    isExempt: (el: Element): boolean => ctx.isExempt(el),
    rect: (el: Element) => ctx.rect(el),
    style: (el: Element, prop: string): string => ctx.style(el, prop),
    px: (el: Element, prop: string): number => ctx.px(el, prop),
    name: (el: Element): string => accessibleName(el),
    signature: (el: Element): string => elementSignature(el),
    edges: (el: Element) => visibleEdges(ctx, el),
    ink: (el: Element) => inkExtents(ctx, el),
    background: (el: Element) => effectiveBackground(ctx, el),
  });

type Normalized =
  | { readonly kind: 'finding'; readonly finding: LayoutFinding }
  | { readonly kind: 'skip' }
  | { readonly kind: 'bad'; readonly index: number };

const asList = (raw: unknown): readonly unknown[] => {
  if (raw === undefined || raw === null || typeof raw === 'boolean') return [];
  if (typeof raw === 'string' || isElement(raw) || Array.isArray(raw)) return Array.isArray(raw) ? raw : [raw];
  if (typeof raw === 'object' && typeof (raw as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    return [...(raw as Iterable<unknown>)];
  }
  return [raw];
};

const normalizeItem = (ctx: MeasureContext, name: string, item: unknown, index: number): Normalized => {
  const id = customCheckId(name);
  const fromElement = (el: Element, message: string | undefined, signature: string | undefined): Normalized => {
    if (ctx.isExempt(el)) return { kind: 'skip' };
    const base = elementFinding(ctx, id, el, clip(message ?? `${name}: "${accessibleName(el)}"`, MESSAGE_MAX));
    return {
      kind: 'finding',
      finding: signature !== undefined ? { ...base, signature: clip(signature, SIGNATURE_MAX) } : base,
    };
  };
  if (isElement(item)) return fromElement(item, undefined, undefined);
  if (typeof item === 'string') {
    return item.trim() === ''
      ? { kind: 'skip' }
      : { kind: 'finding', finding: { check: id, signature: `text "${clip(item, 80)}"`, message: clip(item, MESSAGE_MAX) } };
  }
  if (item !== null && typeof item === 'object') {
    const o = item as { element?: unknown; message?: unknown; signature?: unknown };
    const message = typeof o.message === 'string' && o.message.trim() !== '' ? o.message : undefined;
    const signature = typeof o.signature === 'string' && o.signature.trim() !== '' ? o.signature : undefined;
    if (isElement(o.element)) return fromElement(o.element, message, signature);
    if (o.element === undefined && message !== undefined) {
      return {
        kind: 'finding',
        finding: { check: id, signature: clip(signature ?? message, SIGNATURE_MAX), message: clip(message, MESSAGE_MAX) },
      };
    }
  }
  return { kind: 'bad', index };
};

/**
 * Turn what one custom check returned into findings: an element, a string, or
 * { element?, message?, signature? }, alone or in an array / NodeList /
 * iterable; null, undefined and booleans mean "nothing found". Exempt
 * elements are dropped, the list is capped, and the first unusable item is
 * reported as the check's error without discarding the rest.
 */
export const normalizeCustomResult = (
  ctx: MeasureContext,
  name: string,
  raw: unknown,
): { readonly findings: readonly LayoutFinding[]; readonly error?: string } => {
  if (raw !== null && typeof raw === 'object' && typeof (raw as { then?: unknown }).then === 'function') {
    return { findings: [], error: 'returned a promise; custom checks must return synchronously' };
  }
  const items = asList(raw).map((item, i) => normalizeItem(ctx, name, item, i));
  const findings = items.flatMap((n) => (n.kind === 'finding' ? [n.finding] : []));
  const bad = items.find((n) => n.kind === 'bad');
  const capped = findings.slice(0, CUSTOM_CHECK_LIMITS.max_findings);
  const notes = [
    ...(bad !== undefined && bad.kind === 'bad'
      ? [`item ${bad.index} is not an element, a string or { element?, message, signature? }`]
      : []),
    ...(findings.length > capped.length ? [`returned ${findings.length} findings; kept ${capped.length}`] : []),
  ];
  return { findings: capped, ...(notes.length > 0 ? { error: notes.join('; ') } : {}) };
};

const errorText = (err: unknown): string =>
  clip(err instanceof Error ? `${err.name}: ${err.message}` : String(err), MESSAGE_MAX);

type Compiled = (view: Readonly<Record<string, string>>, pdl: ReturnType<typeof customHelpers>) => unknown;

/** Compile one expression as the body of `(view, pdl) => (expression)`. */
const compile = (expression: string): Compiled =>
  new Function('view', 'pdl', `"use strict";\nreturn (${expression}\n);`) as Compiled;

/**
 * Run every custom check against one view. A check that fails to compile,
 * throws, returns a promise or returns unusable items yields a
 * CustomCheckError; it never stops the other checks or the view.
 */
export const runCustomChecks = (
  ctx: MeasureContext,
  checks: readonly CustomCheck[],
  view: Readonly<Record<string, string>>,
): { readonly findings: readonly LayoutFinding[]; readonly errors: readonly CustomCheckError[] } => {
  if (checks.length === 0) return { findings: [], errors: [] };
  const pdl = customHelpers(ctx);
  const frozenView = Object.freeze({ ...view });
  const results = checks.map((check) => {
    try {
      const out = normalizeCustomResult(ctx, check.name, compile(check.expression)(frozenView, pdl));
      return { findings: out.findings, errors: out.error !== undefined ? [{ name: check.name, error: out.error }] : [] };
    } catch (err) {
      return { findings: [], errors: [{ name: check.name, error: errorText(err) }] };
    }
  });
  return {
    findings: results.flatMap((r) => r.findings),
    errors: results.flatMap((r) => r.errors),
  };
};
