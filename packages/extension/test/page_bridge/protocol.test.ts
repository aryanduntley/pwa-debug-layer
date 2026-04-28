import { describe, it, expect } from 'vitest';
import {
  PAGE_BRIDGE_NS,
  encodeRequest,
  encodeResponse,
  isInboundCsToPage,
  isInboundPageToCs,
} from '../../src/page_bridge/protocol.js';

const makeEvent = (data: unknown, source: unknown = window): MessageEvent =>
  new MessageEvent('message', {
    data,
    source: source as MessageEventSource | null,
  });

describe('encodeRequest', () => {
  it('stamps ns + dir and freezes the result', () => {
    const env = encodeRequest({
      requestId: 'r1',
      tool: 'session_ping',
    });
    expect(env).toEqual({
      ns: PAGE_BRIDGE_NS,
      dir: 'cs->page',
      requestId: 'r1',
      tool: 'session_ping',
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('includes payload only when provided (preserves absent vs undefined)', () => {
    const without = encodeRequest({ requestId: 'r1', tool: 't' });
    expect('payload' in without).toBe(false);
    const withP = encodeRequest({ requestId: 'r2', tool: 't', payload: { x: 1 } });
    expect(withP.payload).toEqual({ x: 1 });
  });
});

describe('encodeResponse', () => {
  it('stamps page->cs envelope with payload', () => {
    const env = encodeResponse({ requestId: 'r1', payload: { ok: true } });
    expect(env.ns).toBe(PAGE_BRIDGE_NS);
    expect(env.dir).toBe('page->cs');
    expect(env.requestId).toBe('r1');
    expect(env.payload).toEqual({ ok: true });
    expect(env.error).toBeUndefined();
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('stamps page->cs envelope with error', () => {
    const env = encodeResponse({
      requestId: 'r1',
      error: { message: 'boom' },
    });
    expect(env.error).toEqual({ message: 'boom' });
    expect(env.payload).toBeUndefined();
  });
});

describe('isInboundCsToPage', () => {
  it('accepts a well-formed cs->page event with source=window', () => {
    const env = encodeRequest({ requestId: 'r1', tool: 'session_ping' });
    expect(isInboundCsToPage(makeEvent(env))).toBe(true);
  });

  it('rejects events whose source is not window (cross-frame postMessage)', () => {
    const env = encodeRequest({ requestId: 'r1', tool: 'session_ping' });
    expect(isInboundCsToPage(makeEvent(env, null))).toBe(false);
    expect(isInboundCsToPage(makeEvent(env, {} as MessageEventSource))).toBe(
      false,
    );
  });

  it('rejects wrong namespace (third-party postMessage spoof)', () => {
    expect(
      isInboundCsToPage(
        makeEvent({
          ns: 'other-extension',
          dir: 'cs->page',
          requestId: 'r1',
          tool: 't',
        }),
      ),
    ).toBe(false);
  });

  it('rejects wrong direction (does not match page->cs)', () => {
    expect(
      isInboundCsToPage(
        makeEvent({
          ns: PAGE_BRIDGE_NS,
          dir: 'page->cs',
          requestId: 'r1',
          tool: 't',
        }),
      ),
    ).toBe(false);
  });

  it('rejects malformed shape (missing requestId/tool)', () => {
    expect(
      isInboundCsToPage(
        makeEvent({ ns: PAGE_BRIDGE_NS, dir: 'cs->page', tool: 't' }),
      ),
    ).toBe(false);
    expect(
      isInboundCsToPage(
        makeEvent({ ns: PAGE_BRIDGE_NS, dir: 'cs->page', requestId: 'r1' }),
      ),
    ).toBe(false);
    expect(isInboundCsToPage(makeEvent(null))).toBe(false);
    expect(isInboundCsToPage(makeEvent('string'))).toBe(false);
  });
});

describe('isInboundPageToCs', () => {
  it('accepts a well-formed page->cs event', () => {
    const env = encodeResponse({ requestId: 'r1', payload: { ok: true } });
    expect(isInboundPageToCs(makeEvent(env))).toBe(true);
  });

  it("rejects cs->page direction so the CS doesn't see its own emitted requests", () => {
    const env = encodeRequest({ requestId: 'r1', tool: 't' });
    expect(isInboundPageToCs(makeEvent(env))).toBe(false);
  });

  it('rejects wrong source', () => {
    const env = encodeResponse({ requestId: 'r1' });
    expect(isInboundPageToCs(makeEvent(env, null))).toBe(false);
  });
});
