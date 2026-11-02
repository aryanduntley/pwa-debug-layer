import {
  resolveChecksConfig,
  type ChecksConfig,
  type ChecksInput,
  type LayoutFinding,
  type LayoutMeasureResult,
} from '@pwa-debug/shared';
import { createMeasureContext, domGeometry, type LayoutGeometry } from './geometry.js';
import {
  checkEdgeContact,
  checkOffscreen,
  checkPageOverflow,
  checkPinnedVisible,
} from './checks_box.js';
import { checkTapTargets } from './checks_tap.js';
import { checkContrast, checkTextClipped, checkTextPatterns, renderedText } from './checks_text.js';
import { freezeAnimations, unfreezeAnimations } from './freeze.js';

/** Findings kept per view; the rest are counted out via `truncated`. */
export const FINDINGS_CAP = 300;

export type LayoutMeasureInput = {
  readonly op: 'measure' | 'freeze' | 'unfreeze';
  readonly root_selector?: string;
  readonly exempt_selectors: readonly string[];
  readonly checks: ChecksConfig;
};

type Fail = { readonly error: { readonly message: string } };
const fail = (message: string): Fail => ({ error: { message } });

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Validate the layout_measure payload and resolve its check config. */
export const readLayoutMeasureInput = (
  raw: unknown,
): { readonly ok: true; readonly input: LayoutMeasureInput } | { readonly ok: false; readonly error: string } => {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const op = r['op'] ?? 'measure';
  if (op !== 'measure' && op !== 'freeze' && op !== 'unfreeze') {
    return { ok: false, error: 'layout_measure: op must be measure, freeze or unfreeze' };
  }
  const root = r['root_selector'];
  if (root !== undefined && typeof root !== 'string') {
    return { ok: false, error: 'layout_measure: root_selector must be a string' };
  }
  const exempt = r['exempt_selectors'] ?? [];
  if (!isStringArray(exempt)) {
    return { ok: false, error: 'layout_measure: exempt_selectors must be an array of strings' };
  }
  const checks = resolveChecksConfig(r['checks'] as ChecksInput | undefined);
  if (!checks.ok) return { ok: false, error: `layout_measure: ${checks.error}` };
  return {
    ok: true,
    input: {
      op,
      ...(root !== undefined ? { root_selector: root } : {}),
      exempt_selectors: exempt,
      checks: checks.config,
    },
  };
};

/** First selector the document refuses to parse, or null. */
export const findInvalidSelector = (doc: Document, selectors: readonly string[]): string | null =>
  selectors.find((sel) => {
    try {
      doc.querySelector(sel);
      return false;
    } catch {
      return true;
    }
  }) ?? null;

/**
 * Run every enabled page-world check over the root (document.body unless
 * root_selector names another element). Read-only. `errors` and `timeout`
 * are recorded by the host, not here.
 */
export const measureLayout = (
  doc: Document,
  input: LayoutMeasureInput,
  geometry: LayoutGeometry,
): LayoutMeasureResult | Fail => {
  const { checks } = input;
  const badSel = findInvalidSelector(doc, [
    ...(input.root_selector !== undefined ? [input.root_selector] : []),
    ...input.exempt_selectors,
    ...checks.pinned_visible.pinned_selectors,
  ]);
  if (badSel !== null) return fail(`layout_measure: invalid CSS selector ${JSON.stringify(badSel)}`);
  const root =
    input.root_selector !== undefined ? doc.querySelector(input.root_selector) : doc.body;
  if (root === null) {
    return fail(
      input.root_selector !== undefined
        ? `layout_measure: root_selector ${JSON.stringify(input.root_selector)} matched nothing`
        : 'layout_measure: the document has no body',
    );
  }
  const ctx = createMeasureContext(geometry, root, input.exempt_selectors);
  const elements: readonly Element[] = [root, ...root.querySelectorAll('*')];
  const all: readonly LayoutFinding[] = [
    ...(checks.page_overflow_x.enabled ? checkPageOverflow(ctx, geometry.docScrollWidth()) : []),
    ...(checks.offscreen.enabled ? checkOffscreen(ctx, elements) : []),
    ...(checks.pinned_visible.enabled ? checkPinnedVisible(ctx, elements, checks.pinned_visible) : []),
    ...(checks.tap_target.enabled ? checkTapTargets(ctx, elements, checks.tap_target) : []),
    ...(checks.text_clipped.enabled ? checkTextClipped(ctx, elements) : []),
    ...(checks.edge_contact.enabled ? checkEdgeContact(ctx, elements, checks.edge_contact) : []),
    ...(checks.text_patterns.enabled ? checkTextPatterns(renderedText(root), checks.text_patterns) : []),
    ...(checks.contrast.enabled ? checkContrast(ctx, elements) : []),
  ];
  return {
    url: doc.location?.href ?? '',
    viewport: ctx.viewport,
    scroll: geometry.scrollOffset(),
    findings: all.slice(0, FINDINGS_CAP),
    truncated: all.length > FINDINGS_CAP,
  };
};

export type LayoutOpResult =
  | LayoutMeasureResult
  | { readonly frozen: boolean }
  | Fail;

/**
 * layout_measure bridge entry: parse the payload, then measure, or install /
 * remove the animation freeze. `geometry` defaults to the live DOM.
 */
export const runLayoutMeasure = (
  win: Window,
  raw: unknown,
  geometry: LayoutGeometry = domGeometry(win),
): LayoutOpResult => {
  const parsed = readLayoutMeasureInput(raw);
  if (!parsed.ok) return fail(parsed.error);
  const { input } = parsed;
  if (input.op === 'freeze') return { frozen: freezeAnimations(win.document) };
  if (input.op === 'unfreeze') {
    unfreezeAnimations(win.document);
    return { frozen: false };
  }
  return measureLayout(win.document, input, geometry);
};
