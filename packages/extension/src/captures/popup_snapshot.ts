// Popup content snapshot (Path 6 M-B). Pure builder turning a detected popup's
// content subtree (shadow root or portal element) into a PopupState the AI can
// reason about: is it visible, what is it titled, what does it say, and what
// actions does it offer. Composes existing primitives — dom_serialize for the
// structural NodeSummary, dom_aria for ARIA role/accessible-name — rather than
// re-deriving any of that here. Side-effect-free; no module state.

import { summarizeNode } from './dom_serialize.js';
import { createNodeIdAllocator } from './node_ids.js';
import {
  computeAccessibleName,
  implicitRoleForElement,
} from '../dom_aria/aria.js';
import type { PopupActionButton, PopupFailure, PopupState } from './types.js';

const DEFAULT_DEPTH_CAP = 2;
const DEFAULT_TEXT_CAP = 4000;
const DEFAULT_MAX_BUTTONS = 20;
const DEFAULT_MAX_ALERTS = 8;
const ALERT_TEXT_CAP = 500;

// Copy that signals an auth/connect failure (case-insensitive). Tuned further
// against real widgets in M-D; kept deliberately broad so a failure is surfaced
// rather than missed.
const FAILURE_COPY =
  /\b(fail(?:ed|ure)?|reject(?:ed)?|denied|declined|cancell?ed|unable|went wrong|try again|error)\b/i;

const ALERT_SELECTOR = '[role="alert"], [aria-live="assertive"], [aria-live="polite"]';
const ERROR_STYLED_SELECTOR =
  '[class*="error" i], [class*="fail" i], [data-error]';

export type PopupSnapshotOptions = {
  readonly depthCap?: number;
  readonly textCap?: number;
  readonly maxButtons?: number;
};

const isVisible = (host: Element): boolean => {
  if (!host.isConnected) return false;
  if (typeof getComputedStyle !== 'function') return true;
  try {
    const style = getComputedStyle(host);
    return style.display !== 'none' && style.visibility !== 'hidden';
  } catch {
    return true;
  }
};

const roleOf = (el: Element): string | undefined =>
  el.getAttribute('role')?.trim() || implicitRoleForElement(el);

// Title uses only an EXPLICIT accessible name (aria-label / aria-labelledby) —
// not computeAccessibleName's textContent fallback, which would swallow the
// whole modal body. Falls back to the first heading's text.
const explicitName = (el: Element): string | undefined => {
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;
  const labelledby = el.getAttribute('aria-labelledby')?.trim();
  if (labelledby) {
    const ref = el.ownerDocument?.getElementById(labelledby);
    const t = ref?.textContent?.trim();
    if (t) return t;
  }
  return undefined;
};

const deriveTitle = (
  host: Element,
  contentRoot: ParentNode,
): string | undefined => {
  const name = explicitName(host);
  if (name) return name;
  const heading = contentRoot.querySelector(
    'h1, h2, h3, h4, h5, h6, [role="heading"]',
  );
  const text = heading?.textContent?.trim();
  return text ? text : undefined;
};

const collectButtons = (
  contentRoot: ParentNode,
  maxButtons: number,
): readonly PopupActionButton[] => {
  const out: PopupActionButton[] = [];
  const candidates = contentRoot.querySelectorAll('button, [role="button"]');
  for (let i = 0; i < candidates.length && out.length < maxButtons; i += 1) {
    const el = candidates[i];
    if (el === undefined) continue;
    if (roleOf(el) !== 'button') continue;
    const label = (computeAccessibleName(el) ?? el.textContent ?? '').trim();
    if (label === '') continue;
    out.push({ label, role: 'button' });
  }
  return out;
};

const collectAlerts = (contentRoot: ParentNode): readonly string[] => {
  const out: string[] = [];
  const nodes = contentRoot.querySelectorAll(ALERT_SELECTOR);
  for (let i = 0; i < nodes.length && out.length < DEFAULT_MAX_ALERTS; i += 1) {
    const text = nodes[i]?.textContent?.trim();
    if (text) out.push(text.slice(0, ALERT_TEXT_CAP));
  }
  return out;
};

// A failure is the first failure-copy match among: alert texts, then
// error-styled element text, then the widget's overall text.
const deriveFailure = (
  contentRoot: ParentNode,
  alerts: readonly string[],
  text: string,
): PopupFailure | undefined => {
  for (const alert of alerts) {
    if (FAILURE_COPY.test(alert)) return { reason: alert };
  }
  const styled = contentRoot.querySelectorAll(ERROR_STYLED_SELECTOR);
  for (let i = 0; i < styled.length; i += 1) {
    const t = styled[i]?.textContent?.trim();
    if (t && FAILURE_COPY.test(t)) return { reason: t.slice(0, ALERT_TEXT_CAP) };
  }
  const m = text.match(FAILURE_COPY);
  if (m) {
    const trimmed = text.trim();
    return { reason: trimmed.slice(0, ALERT_TEXT_CAP) };
  }
  return undefined;
};

export const buildPopupState = (
  host: Element,
  contentRoot: ParentNode & Node,
  opts?: PopupSnapshotOptions,
): PopupState => {
  const depthCap = opts?.depthCap ?? DEFAULT_DEPTH_CAP;
  const textCap = opts?.textCap ?? DEFAULT_TEXT_CAP;
  const maxButtons = opts?.maxButtons ?? DEFAULT_MAX_BUTTONS;

  const allocator = createNodeIdAllocator();
  const content = summarizeNode(contentRoot, depthCap, allocator);
  allocator.dispose();

  const rawText = (contentRoot.textContent ?? '').trim();
  const textTruncated = rawText.length > textCap;
  const text = textTruncated ? rawText.slice(0, textCap) : rawText;

  const title = deriveTitle(host, contentRoot);
  const buttons = collectButtons(contentRoot, maxButtons);
  const alerts = collectAlerts(contentRoot);
  const failure = deriveFailure(contentRoot, alerts, rawText);

  return {
    visible: isVisible(host),
    ...(title !== undefined ? { title } : {}),
    ...(text !== '' ? { text } : {}),
    ...(buttons.length > 0 ? { buttons } : {}),
    ...(alerts.length > 0 ? { alerts } : {}),
    ...(failure !== undefined ? { failure } : {}),
    content,
    ...(textTruncated || content.truncated === true ? { truncated: true } : {}),
  };
};
