// Pure correlation of popup failures (Path 6 M-C C2). Given the host's three
// ring-buffer tails (library_popup, console, network), groups popups by id,
// derives each one's open window, reads its in-widget failure/alerts from the
// captured PopupState, and links the console errors + failed network requests
// that fired in that window (same frameKey). No I/O, no buffer access — the
// caller (popup_failures tool) supplies the tails so this stays unit-testable.

import type { HostStoredEvent } from '../captures_in/captures_in.js';
import type {
  PopupConsoleError,
  PopupFailureReport,
  PopupNetworkError,
  PopupPageError,
} from '@pwa-debug/shared';

const CONSOLE_TEXT_CAP = 1000;

export type CorrelateInput = {
  readonly popups: readonly HostStoredEvent[];
  readonly consoleEvents: readonly HostStoredEvent[];
  readonly networkEvents: readonly HostStoredEvent[];
  /** Uncaught window errors / unhandled rejections (page_error buffer). */
  readonly errorEvents?: readonly HostStoredEvent[];
  readonly now: number;
  readonly includeAll?: boolean;
  readonly popupId?: string;
  /**
   * Include NESTED component popups. Default false: only PRIMARY popups are
   * reported, so a component-heavy widget (Reown: ~hundreds of nested popups
   * sharing one frame+window) yields ONE failure report instead of hundreds —
   * the primary's window already correlates the whole widget's console/network
   * errors by frameKey.
   */
  readonly includeNested?: boolean;
};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

type PopupState = {
  readonly failure?: { readonly reason?: unknown };
  readonly alerts?: unknown;
};

const readState = (e: HostStoredEvent): PopupState | undefined => {
  const s = (e as { state?: unknown }).state;
  return s !== null && typeof s === 'object' ? (s as PopupState) : undefined;
};

const readAlerts = (state: PopupState | undefined): readonly string[] => {
  if (state === undefined || !Array.isArray(state.alerts)) return [];
  return state.alerts.filter((a): a is string => typeof a === 'string');
};

// Best readable text for a single console arg. Structured loggers (pino/bunyan)
// emit an object whose human message is under msg/message (level/time are
// noise), so prefer those before falling back to JSON.
const argText = (a: unknown): string => {
  if (typeof a === 'string') return a;
  if (a !== null && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    for (const key of ['msg', 'message', 'error', 'reason']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
};

const consoleText = (e: HostStoredEvent): string => {
  const args = (e as { args?: unknown }).args;
  const parts = Array.isArray(args) ? args : [];
  const text = parts
    .map(argText)
    .join(' ')
    .trim();
  return text.slice(0, CONSOLE_TEXT_CAP);
};

const isNetworkFailure = (e: HostStoredEvent): boolean => {
  const kind = str(e.kind);
  if (kind === 'websocket') {
    return str((e as { subkind?: unknown }).subkind) === 'error';
  }
  if (kind === 'fetch' || kind === 'xhr') {
    if (str((e as { phase?: unknown }).phase) === 'error') return true;
    const status = num((e as { status?: unknown }).status);
    if (status !== undefined && (status === 0 || status >= 400)) return true;
  }
  return false;
};

const toNetworkError = (e: HostStoredEvent): PopupNetworkError => {
  const url = str(e.url);
  const method = str(e.method);
  const status = num(e.status);
  const phase = str(e.phase) ?? str(e.subkind);
  return {
    kind: str(e.kind) ?? 'unknown',
    ...(url !== undefined ? { url } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ts: e.ts,
    sequenceNumber: e.sequenceNumber,
  };
};

const inWindow = (ts: number, from: number, to: number): boolean =>
  ts >= from && ts <= to;

export const correlatePopupFailures = (
  input: CorrelateInput,
): PopupFailureReport[] => {
  // Group popup events by id, preserving first-seen order.
  const order: string[] = [];
  const groups = new Map<string, HostStoredEvent[]>();
  for (const e of input.popups) {
    const id = str((e as { popupId?: unknown }).popupId);
    if (id === undefined) continue;
    if (input.popupId !== undefined && id !== input.popupId) continue;
    const existing = groups.get(id);
    if (existing === undefined) {
      groups.set(id, [e]);
      order.push(id);
    } else {
      existing.push(e);
    }
  }

  const reports: PopupFailureReport[] = [];

  for (const id of order) {
    const events = groups.get(id)!;
    const first = events[0]!;
    // Role/parent come from any event in the group (the producer stamps them on
    // every phase). Default to 'primary' when absent (pre-two-tier events).
    const roleRaw = events
      .map((e) => str((e as { role?: unknown }).role))
      .find((r) => r !== undefined);
    const role: 'primary' | 'nested' = roleRaw === 'nested' ? 'nested' : 'primary';
    // Primary-only by default — nested components of one widget share the
    // frame+window, so the primary's report already aggregates their errors.
    if (role === 'nested' && input.includeNested !== true) continue;
    const parentRaw = (first as { parentPopupId?: unknown }).parentPopupId;
    const parentPopupId =
      typeof parentRaw === 'string' ? parentRaw : null;
    const frameKey = str(first.frameKey) ?? '';
    const library = str((first as { library?: unknown }).library) ?? 'unknown';
    const detection =
      str((first as { detection?: unknown }).detection) === 'portal'
        ? 'portal'
        : 'shadow';

    const appeared =
      events.find((e) => str((e as { phase?: unknown }).phase) === 'appeared') ??
      first;
    const disappeared = [...events]
      .reverse()
      .find((e) => str((e as { phase?: unknown }).phase) === 'disappeared');
    const from = appeared.ts;
    const to = disappeared !== undefined ? disappeared.ts : input.now;
    const open = disappeared === undefined;

    // Latest state-bearing event (appeared/updated carry state).
    const latestWithState = [...events].reverse().find((e) => readState(e) !== undefined);
    const state = latestWithState !== undefined ? readState(latestWithState) : undefined;
    const alerts = readAlerts(state);
    const reasonFromState = str(state?.failure?.reason);

    const consoleErrors: PopupConsoleError[] = input.consoleEvents
      .filter(
        (e) =>
          str(e.frameKey) === frameKey &&
          str((e as { level?: unknown }).level) === 'error' &&
          inWindow(e.ts, from, to),
      )
      .map((e) => ({
        level: 'error',
        text: consoleText(e),
        ts: e.ts,
        sequenceNumber: e.sequenceNumber,
      }));

    const networkErrors: PopupNetworkError[] = input.networkEvents
      .filter(
        (e) =>
          str(e.frameKey) === frameKey &&
          isNetworkFailure(e) &&
          inWindow(e.ts, from, to),
      )
      .map(toNetworkError);

    const pageErrors: PopupPageError[] = (input.errorEvents ?? [])
      .filter((e) => str(e.frameKey) === frameKey && inWindow(e.ts, from, to))
      .map((e) => {
        const name = str((e as { name?: unknown }).name);
        return {
          subkind: str((e as { subkind?: unknown }).subkind) ?? 'error',
          message: str((e as { message?: unknown }).message) ?? '',
          ...(name !== undefined ? { name } : {}),
          ts: e.ts,
          sequenceNumber: e.sequenceNumber,
        };
      });

    const hasSignal =
      reasonFromState !== undefined ||
      alerts.length > 0 ||
      pageErrors.length > 0 ||
      consoleErrors.length > 0 ||
      networkErrors.length > 0;
    if (!hasSignal && input.includeAll !== true) continue;

    // An uncaught error/rejection is a stronger, more meaningful signal than a
    // generic console line, so it precedes console in the reason fallback.
    const reason =
      reasonFromState ??
      (pageErrors.find((p) => p.message !== '')?.message) ??
      (consoleErrors[0]?.text) ??
      (networkErrors[0] !== undefined
        ? `network ${networkErrors[0].kind} ${networkErrors[0].url ?? ''} ${networkErrors[0].status ?? networkErrors[0].phase ?? ''}`.trim()
        : undefined);

    reports.push({
      popupId: id,
      library,
      detection,
      frameKey,
      role,
      parentPopupId,
      ...(reason !== undefined ? { reason } : {}),
      ...(alerts.length > 0 ? { alerts } : {}),
      window: { from, to, open },
      console: consoleErrors,
      network: networkErrors,
      errors: pageErrors,
    });
  }

  return reports;
};
