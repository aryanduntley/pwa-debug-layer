// Popup content snapshot (Path 6 M-B; shadow-piercing in M-D). Pure builder
// turning a detected popup's content subtree (shadow root or portal element)
// into a PopupState the AI can reason about: is it visible, what is it titled,
// what does it say, and what actions it offers. Composes existing primitives —
// dom_serialize for the structural NodeSummary, dom_aria for ARIA
// role/accessible-name — rather than re-deriving any of that here.
//
// Component-based widgets (e.g. Reown/Web3Modal) render their visible content
// into PER-COMPONENT open shadow roots nested under the top-level host, where
// textContent/querySelectorAll do NOT reach. So text/title/buttons/alerts are
// gathered across open shadow boundaries (composedScopes / collectComposedText)
// — otherwise a primary popup's state would be empty (just the {#fragment}).
// Side-effect-free; no module state.

import { summarizeNode } from './dom_serialize.js';
import { createNodeIdAllocator } from './node_ids.js';
import { discoverShadowRoots } from './walk_shadow.js';
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
const BUTTON_LABEL_CAP = 120;

// Copy that signals an auth/connect failure (case-insensitive). Tuned further
// against real widgets in M-D; kept deliberately broad so a failure is surfaced
// rather than missed.
// Includes AppKit/Web3Modal in-modal error-view copy ('Connection declined',
// 'Connection interrupted', 'Connection request reset', 'Try again', 'timed out')
// so a real-widget error state is surfaced via the shadow-piercing snapshot.
const FAILURE_COPY =
  /\b(fail(?:ed|ure)?|reject(?:ed)?|denied|declined|cancell?ed|unable|went wrong|try again|interrupted|reset|timed out|timeout|error)\b/i;

const ALERT_SELECTOR = '[role="alert"], [aria-live="assertive"], [aria-live="polite"]';
const ERROR_STYLED_SELECTOR =
  '[class*="error" i], [class*="fail" i], [data-error]';

export type PopupSnapshotOptions = {
  readonly depthCap?: number;
  readonly textCap?: number;
  readonly maxButtons?: number;
};

// --- shadow-piercing query scopes -------------------------------------------

// The content root plus every nested OPEN shadow root, each a separate scope
// for querySelectorAll (which does not cross shadow boundaries). Closed shadow
// roots are invisible to discoverShadowRoots and intentionally out of scope.
const composedScopes = (contentRoot: ParentNode & Node): readonly ParentNode[] => {
  const scopes: ParentNode[] = [contentRoot];
  try {
    for (const shadow of discoverShadowRoots(contentRoot)) scopes.push(shadow);
  } catch {
    // Discovery must never break snapshotting.
  }
  return scopes;
};

const pierceQueryAll = (
  scopes: readonly ParentNode[],
  selector: string,
): Element[] => {
  const out: Element[] = [];
  for (const scope of scopes) {
    try {
      const found = scope.querySelectorAll(selector);
      for (let i = 0; i < found.length; i += 1) {
        const el = found[i];
        if (el !== undefined) out.push(el);
      }
    } catch {
      // A faulty selector in one scope must not abort the rest.
    }
  }
  return out;
};

const pierceQueryFirst = (
  scopes: readonly ParentNode[],
  selector: string,
): Element | null => {
  for (const scope of scopes) {
    try {
      const el = scope.querySelector(selector);
      if (el !== null) return el;
    } catch {
      // Ignore and continue with the next scope.
    }
  }
  return null;
};

// Visible text composed over the FLATTENED tree (across open shadow boundaries
// AND through <slot> projection). A shadow host's rendered content lives in its
// shadow root, and the host's light children appear wherever a <slot> projects
// them — so we descend into the shadow, and at each <slot> we visit its
// assignedNodes (the projected light DOM). This recovers slotted text that
// component-based widgets (Reown's wui-*/w3m-*) render via slots, which a
// skip-light-children walk would lose. Falls back to a slot's own children when
// nothing is assigned, and to plain child traversal for non-host elements.
const collectComposedText = (
  root: Node,
  cap: number,
): { text: string; truncated: boolean } => {
  const parts: string[] = [];
  let len = 0;
  let truncated = false;
  const visit = (node: Node): void => {
    if (len >= cap) {
      truncated = true;
      return;
    }
    if (node.nodeType === 3) {
      const t = node.nodeValue ?? '';
      if (t.trim() !== '') {
        parts.push(t);
        len += t.length;
      }
      return;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      // <slot>: render the projected (assigned) light-DOM nodes in its place.
      if (
        el.tagName === 'SLOT' &&
        typeof (el as HTMLSlotElement).assignedNodes === 'function'
      ) {
        let assigned: readonly Node[] = [];
        try {
          assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
        } catch {
          assigned = [];
        }
        if (assigned.length > 0) {
          for (const a of assigned) {
            if (len >= cap) break;
            visit(a);
          }
          return;
        }
        // No assigned nodes: fall through to the slot's fallback children.
      } else {
        let shadow: ShadowRoot | null = null;
        try {
          shadow = el.shadowRoot;
        } catch {
          shadow = null;
        }
        if (shadow !== null) {
          visit(shadow);
          return;
        }
      }
    }
    const children = node.childNodes;
    for (let i = 0; i < children.length && len < cap; i += 1) {
      const child = children[i];
      if (child !== undefined) visit(child);
    }
  };
  try {
    visit(root);
  } catch {
    // A traversal failure yields whatever was gathered so far.
  }
  let raw = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (raw.length > cap) {
    raw = raw.slice(0, cap);
    truncated = true;
  }
  return { text: raw, truncated };
};

// --- field derivation --------------------------------------------------------

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
// whole modal body. Falls back to the first heading's text (across shadows).
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
  scopes: readonly ParentNode[],
): string | undefined => {
  const name = explicitName(host);
  if (name) return name;
  const heading = pierceQueryFirst(
    scopes,
    'h1, h2, h3, h4, h5, h6, [role="heading"]',
  );
  const text = heading?.textContent?.trim();
  return text ? text : undefined;
};

const collectButtons = (
  scopes: readonly ParentNode[],
  maxButtons: number,
): readonly PopupActionButton[] => {
  const out: PopupActionButton[] = [];
  const seen = new Set<string>();
  const candidates = pierceQueryAll(scopes, 'button, [role="button"]');
  for (let i = 0; i < candidates.length && out.length < maxButtons; i += 1) {
    const el = candidates[i];
    if (el === undefined) continue;
    if (roleOf(el) !== 'button') continue;
    // Accessible name first; fall back to the button's composed text so labels
    // rendered inside the button's own shadow root (e.g. <wui-button>) survive.
    const named = (computeAccessibleName(el) ?? '').trim();
    const label = named !== '' ? named : collectComposedText(el, BUTTON_LABEL_CAP).text;
    if (label === '' || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, role: 'button' });
  }
  return out;
};

const collectAlerts = (scopes: readonly ParentNode[]): readonly string[] => {
  const out: string[] = [];
  const nodes = pierceQueryAll(scopes, ALERT_SELECTOR);
  for (let i = 0; i < nodes.length && out.length < DEFAULT_MAX_ALERTS; i += 1) {
    const text = nodes[i]?.textContent?.trim();
    if (text) out.push(text.slice(0, ALERT_TEXT_CAP));
  }
  return out;
};

// A failure is the first failure-copy match among: alert texts, then
// error-styled element text, then the widget's overall text.
const deriveFailure = (
  scopes: readonly ParentNode[],
  alerts: readonly string[],
  text: string,
): PopupFailure | undefined => {
  for (const alert of alerts) {
    if (FAILURE_COPY.test(alert)) return { reason: alert };
  }
  const styled = pierceQueryAll(scopes, ERROR_STYLED_SELECTOR);
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

  // Text, title, buttons, alerts are gathered across open shadow boundaries so
  // component-based widgets surface readable content instead of an empty shell.
  const scopes = composedScopes(contentRoot);
  const { text: rawText, truncated: textTruncated } = collectComposedText(
    contentRoot,
    textCap,
  );

  const title = deriveTitle(host, scopes);
  const buttons = collectButtons(scopes, maxButtons);
  const alerts = collectAlerts(scopes);
  const failure = deriveFailure(scopes, alerts, rawText);

  return {
    visible: isVisible(host),
    ...(title !== undefined ? { title } : {}),
    ...(rawText !== '' ? { text: rawText } : {}),
    ...(buttons.length > 0 ? { buttons } : {}),
    ...(alerts.length > 0 ? { alerts } : {}),
    ...(failure !== undefined ? { failure } : {}),
    content,
    ...(textTruncated || content.truncated === true ? { truncated: true } : {}),
  };
};
