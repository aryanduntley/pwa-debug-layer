import { describe, it, expect } from 'vitest';
import { CDP_EMIT_BINDING } from '@pwa-debug/shared';
import {
  buildDispatchExpression,
  capturesEnvelope,
  cdpConnectionId,
  normalizeNavigateUrl,
  parseBindingEvent,
  parseDispatchResult,
  stripTabId,
} from '../../src/cdp_session/protocol.js';

describe('buildDispatchExpression', () => {
  it('passes the request as one JSON string literal, safe for any payload', () => {
    const req = { requestId: 'r1', tool: 'evaluate', payload: { expression: `"); alert('x'); ("` } };
    const expr = buildDispatchExpression(req);
    expect(expr.startsWith('globalThis.__pwaDebugCdp.dispatch(')).toBe(true);
    const arg = expr.slice('globalThis.__pwaDebugCdp.dispatch('.length, -1);
    expect(JSON.parse(JSON.parse(arg) as string)).toEqual(req);
  });
});

describe('parseDispatchResult', () => {
  const wrap = (page: unknown) => ({ result: { type: 'string', value: JSON.stringify(page) } });

  it('carries payload under the original request id', () => {
    const r = parseDispatchResult('host-1', wrap({ ns: 'pwa-debug', dir: 'page->cs', requestId: 'host-1', payload: { a: 1 } }));
    expect(r).toEqual({ type: 'response', requestId: 'host-1', payload: { a: 1 } });
  });

  it('maps a page error envelope to an error response', () => {
    const r = parseDispatchResult('x', wrap({ requestId: 'x', error: { message: 'unknown tool: nope' } }));
    expect(r).toEqual({ type: 'response', requestId: 'x', error: { message: 'unknown tool: nope' } });
  });

  it('explains a missing bridge instead of leaking the TypeError', () => {
    const r = parseDispatchResult('x', {
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: { text: 'Uncaught', exception: { description: "TypeError: Cannot read properties of undefined (reading 'dispatch')" } },
    });
    expect(r.error?.message).toMatch(/CDP bridge is not present/);
  });

  it('reports other page exceptions verbatim', () => {
    const r = parseDispatchResult('x', { exceptionDetails: { text: 'Uncaught', exception: { description: 'SyntaxError: bad' } } });
    expect(r.error?.message).toBe('cdp: page threw: SyntaxError: bad');
  });

  it('handles non-string values, bad JSON and empty results', () => {
    expect(parseDispatchResult('x', { result: { type: 'undefined' } }).error?.message).toMatch(/not present/);
    expect(parseDispatchResult('x', { result: { value: '{oops' } }).error?.message).toMatch(/non-JSON/);
    expect(parseDispatchResult('x', null).error?.message).toMatch(/empty/);
  });
});

describe('parseBindingEvent', () => {
  const call = (payload: unknown, name = CDP_EMIT_BINDING) => ({ name, payload, executionContextId: 1 });

  it('returns the event from a bridge binding call', () => {
    const event = { kind: 'console', ts: 5, level: 'log', args: ['hi'] };
    expect(parseBindingEvent(call(JSON.stringify({ v: 1, event })))).toEqual(event);
  });

  it.each([
    ['another binding', call(JSON.stringify({ v: 1, event: { kind: 'console', ts: 1 } }), 'otherBinding')],
    ['non-string payload', call(42)],
    ['bad JSON', call('{x')],
    ['missing kind', call(JSON.stringify({ v: 1, event: { ts: 1 } }))],
    ['missing ts', call(JSON.stringify({ v: 1, event: { kind: 'console' } }))],
    ['not an object', 'nope'],
  ])('rejects %s', (_label, params) => {
    expect(parseBindingEvent(params)).toBeNull();
  });
});

describe('capturesEnvelope', () => {
  it('builds the intake envelope for the connection', () => {
    const ev = { kind: 'fetch', ts: 1 };
    expect(capturesEnvelope('cdp:127.0.0.1:9334:ABCDEF12', [ev])).toEqual({
      type: 'event',
      tool: 'captures',
      extensionId: 'cdp:127.0.0.1:9334:ABCDEF12',
      payload: { events: [ev] },
    });
  });
});

describe('cdpConnectionId', () => {
  it('uses host:port and the first 8 chars of the target id', () => {
    expect(cdpConnectionId('http://127.0.0.1:9334', 'BF6AE835C52D9DBC4A087B596D33048D')).toBe('cdp:127.0.0.1:9334:BF6AE835');
  });
});

describe('normalizeNavigateUrl', () => {
  it('shares the extension rules', () => {
    expect(normalizeNavigateUrl('localhost:5173')).toEqual({ ok: true, url: 'localhost:5173' });
    expect(normalizeNavigateUrl('example.com')).toEqual({ ok: true, url: 'https://example.com' });
    expect(normalizeNavigateUrl('http://localhost:5173/')).toEqual({ ok: true, url: 'http://localhost:5173/' });
    expect(normalizeNavigateUrl('javascript:alert(1)').ok).toBe(false);
    expect(normalizeNavigateUrl(7).ok).toBe(false);
  });
});

describe('stripTabId', () => {
  it('drops tab_id only', () => {
    expect(stripTabId({ tab_id: 3, expression: '1' })).toEqual({ expression: '1' });
    expect(stripTabId({ expression: '1' })).toEqual({ expression: '1' });
    expect(stripTabId(undefined)).toBeUndefined();
  });
});
