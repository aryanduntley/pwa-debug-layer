import { describe, it, expect } from 'vitest';
import { correlatePopupFailures } from '../../src/popup_failures/correlate.js';
import type { HostStoredEvent } from '../../src/captures_in/captures_in.js';

let seq = 0;
const ev = (
  kind: string,
  ts: number,
  extra: Record<string, unknown> = {},
): HostStoredEvent =>
  ({
    kind,
    ts,
    receivedAt: ts,
    sessionId: 's',
    extensionId: 'e',
    sequenceNumber: (seq += 1),
    frameKey: 'top',
    ...extra,
  }) as HostStoredEvent;

const popup = (ts: number, extra: Record<string, unknown>): HostStoredEvent =>
  ev('library_popup', ts, {
    popupId: 'p1',
    library: 'walletconnect',
    detection: 'portal',
    phase: 'appeared',
    ...extra,
  });

describe('correlatePopupFailures', () => {
  it('correlates in-window same-frame console + network errors with the popup failure', () => {
    const popups = [
      popup(100, { phase: 'appeared' }),
      popup(150, { phase: 'updated', state: { failure: { reason: 'Connection failed' } } }),
    ];
    const consoleEvents = [
      ev('console', 120, { level: 'error', args: ['WC: user rejected'] }),
      ev('console', 50, { level: 'error', args: ['too early'] }), // before window
      ev('console', 120, { level: 'error', args: ['other frame'], frameKey: 'top/0' }), // wrong frame
      ev('console', 125, { level: 'log', args: ['not an error'] }), // not error
    ];
    const networkEvents = [
      ev('fetch', 130, { phase: 'error', url: '/connect', method: 'POST' }),
      ev('fetch', 131, { phase: 'response', status: 200, url: '/ok' }), // success
    ];

    const reports = correlatePopupFailures({
      popups,
      consoleEvents,
      networkEvents,
      now: 200,
    });

    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r.popupId).toBe('p1');
    expect(r.library).toBe('walletconnect');
    expect(r.reason).toBe('Connection failed');
    expect(r.window).toEqual({ from: 100, to: 200, open: true });
    expect(r.console).toHaveLength(1);
    expect(r.console[0]!.text).toBe('WC: user rejected');
    expect(r.network).toHaveLength(1);
    expect(r.network[0]!.url).toBe('/connect');
  });

  it('uses the disappeared ts as the window end and excludes post-close errors', () => {
    const popups = [
      popup(100, { phase: 'appeared' }),
      popup(200, { phase: 'disappeared' }),
    ];
    const consoleEvents = [
      ev('console', 150, { level: 'error', args: ['in window'] }),
      ev('console', 250, { level: 'error', args: ['after close'] }),
    ];

    const reports = correlatePopupFailures({
      popups,
      consoleEvents,
      networkEvents: [],
      now: 999,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]!.window).toEqual({ from: 100, to: 200, open: false });
    expect(reports[0]!.console).toHaveLength(1);
    expect(reports[0]!.console[0]!.text).toBe('in window');
  });

  it("falls back to the first console error text as the reason when there's no in-widget failure", () => {
    const popups = [popup(100, { phase: 'appeared' })];
    const consoleEvents = [
      ev('console', 120, { level: 'error', args: ['boom'] }),
    ];
    const reports = correlatePopupFailures({
      popups,
      consoleEvents,
      networkEvents: [],
      now: 200,
    });
    expect(reports[0]!.reason).toBe('boom');
  });

  it('excludes popups with no failure signal unless includeAll', () => {
    const popups = [popup(100, { phase: 'appeared', state: { visible: true } })];
    const base = { popups, consoleEvents: [], networkEvents: [], now: 200 };

    expect(correlatePopupFailures(base)).toHaveLength(0);
    expect(correlatePopupFailures({ ...base, includeAll: true })).toHaveLength(1);
  });

  it('surfaces in-widget alerts and flags failing status codes', () => {
    const popups = [
      popup(100, {
        phase: 'appeared',
        state: { alerts: ['Network error, try again'] },
      }),
    ];
    const networkEvents = [
      ev('xhr', 110, { status: 500, url: '/rpc', phase: 'response' }),
    ];
    const reports = correlatePopupFailures({
      popups,
      consoleEvents: [],
      networkEvents,
      now: 200,
    });
    expect(reports[0]!.alerts).toEqual(['Network error, try again']);
    expect(reports[0]!.network).toHaveLength(1);
    expect(reports[0]!.network[0]!.status).toBe(500);
  });

  it('reports only PRIMARY popups by default; include_nested adds nested', () => {
    const popups = [
      popup(100, {
        popupId: 'modal',
        role: 'primary',
        parentPopupId: null,
        phase: 'appeared',
        state: { failure: { reason: 'connect rejected' } },
      }),
      popup(110, {
        popupId: 'inner',
        role: 'nested',
        parentPopupId: 'modal',
        phase: 'appeared',
        state: { failure: { reason: 'connect rejected' } },
      }),
    ];
    const base = { popups, consoleEvents: [], networkEvents: [], now: 200 };

    const def = correlatePopupFailures(base);
    expect(def).toHaveLength(1);
    expect(def[0]!.popupId).toBe('modal');
    expect(def[0]!.role).toBe('primary');
    expect(def[0]!.parentPopupId).toBeNull();

    const all = correlatePopupFailures({ ...base, includeNested: true });
    expect(all.map((r) => r.popupId).sort()).toEqual(['inner', 'modal']);
    const nested = all.find((r) => r.popupId === 'inner')!;
    expect(nested.role).toBe('nested');
    expect(nested.parentPopupId).toBe('modal');
  });

  it('treats a roleless (pre-two-tier) popup as primary', () => {
    const popups = [popup(100, { phase: 'appeared', state: { failure: { reason: 'x' } } })];
    const reports = correlatePopupFailures({
      popups,
      consoleEvents: [],
      networkEvents: [],
      now: 200,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.role).toBe('primary');
  });

  it('unwraps a structured-logger console arg to its message for the reason', () => {
    const popups = [popup(100, { role: 'primary', phase: 'appeared' })];
    const consoleEvents = [
      ev('console', 120, {
        level: 'error',
        args: [{ level: 50, time: 123, msg: 'WalletConnect: user rejected' }],
      }),
    ];
    const reports = correlatePopupFailures({
      popups,
      consoleEvents,
      networkEvents: [],
      now: 200,
    });
    expect(reports[0]!.reason).toBe('WalletConnect: user rejected');
    expect(reports[0]!.console[0]!.text).toBe('WalletConnect: user rejected');
  });

  it('correlates uncaught page errors and prefers them over console in the reason', () => {
    const popups = [popup(100, { role: 'primary', phase: 'appeared' })];
    const errorEvents = [
      ev('page_error', 120, {
        subkind: 'unhandledrejection',
        message: 'User rejected the request',
        name: 'UserRejectedRequestError',
      }),
    ];
    const consoleEvents = [
      ev('console', 121, { level: 'error', args: ['noisy console line'] }),
    ];
    const reports = correlatePopupFailures({
      popups,
      consoleEvents,
      networkEvents: [],
      errorEvents,
      now: 200,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.errors).toHaveLength(1);
    expect(reports[0]!.errors[0]!.message).toBe('User rejected the request');
    expect(reports[0]!.errors[0]!.subkind).toBe('unhandledrejection');
    // page error outranks the console line in the reason fallback
    expect(reports[0]!.reason).toBe('User rejected the request');
  });

  it('filters to a single popupId when requested', () => {
    const popups = [
      popup(100, { popupId: 'p1', phase: 'appeared', state: { failure: { reason: 'a' } } }),
      popup(100, { popupId: 'p2', phase: 'appeared', state: { failure: { reason: 'b' } } }),
    ];
    const reports = correlatePopupFailures({
      popups,
      consoleEvents: [],
      networkEvents: [],
      now: 200,
      popupId: 'p2',
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.popupId).toBe('p2');
    expect(reports[0]!.reason).toBe('b');
  });
});
