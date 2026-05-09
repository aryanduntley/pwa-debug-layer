import { describe, it, expect } from 'vitest';
import {
  evaluateHandler,
  dispatchPageRequest,
  type EvaluateOutput,
} from '../../src/page_bridge/page_dispatch.js';
import {
  PAGE_BRIDGE_NS,
  type PageBridgeRequestEnvelope,
} from '../../src/page_bridge/protocol.js';

const makeEnv = (
  payload: unknown,
  requestId = 'r-eval-1',
): PageBridgeRequestEnvelope =>
  Object.freeze({
    ns: PAGE_BRIDGE_NS,
    dir: 'cs->page' as const,
    requestId,
    tool: 'evaluate',
    payload,
  });

describe('evaluateHandler — sync paths', () => {
  it('returns value:2 for expression "1+1"', async () => {
    const out = await evaluateHandler(makeEnv({ expression: '1+1' }));
    expect(out.value).toBe(2);
    expect(out.error).toBeUndefined();
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('returns evaluated DocumentReadyState string for expression "document.readyState"', async () => {
    const out = await evaluateHandler(
      makeEnv({ expression: 'document.readyState' }),
    );
    expect(['loading', 'interactive', 'complete']).toContain(out.value);
    expect(out.error).toBeUndefined();
  });

  it('captures synchronous Error throws into error:{message,stack}', async () => {
    const out = await evaluateHandler(
      makeEnv({ expression: '(()=>{throw new Error("boom")})()' }),
    );
    expect(out.value).toBeUndefined();
    expect(out.error?.message).toBe('boom');
    expect(typeof out.error?.stack).toBe('string');
  });

  it('captures syntax errors without throwing', async () => {
    const out = await evaluateHandler(makeEnv({ expression: '1 +' }));
    expect(out.value).toBeUndefined();
    expect(out.error?.message).toMatch(/Unexpected|SyntaxError|expected/i);
  });

  it('rejects malformed input (missing/empty expression)', async () => {
    const a = await evaluateHandler(makeEnv({}));
    expect(a.error?.message).toMatch(/payload must be/);
    const b = await evaluateHandler(makeEnv({ expression: '' }));
    expect(b.error?.message).toMatch(/payload must be/);
    const c = await evaluateHandler(makeEnv(null));
    expect(c.error?.message).toMatch(/payload must be/);
  });
});

describe('evaluateHandler — async paths', () => {
  it('awaits a thenable when await_promise=true and serializes the resolved value', async () => {
    const out = await evaluateHandler(
      makeEnv({ expression: 'Promise.resolve(42)', await_promise: true }),
    );
    expect(out.value).toBe(42);
    expect(out.error).toBeUndefined();
  });

  it('captures async rejections as error:{message,stack}', async () => {
    const out = await evaluateHandler(
      makeEnv({
        expression: 'Promise.reject(new Error("async-x"))',
        await_promise: true,
      }),
    );
    expect(out.value).toBeUndefined();
    expect(out.error?.message).toBe('async-x');
    expect(typeof out.error?.stack).toBe('string');
  });

  it('returns a Promise tag (NOT the resolved value) when await_promise is omitted', async () => {
    const out = await evaluateHandler(
      makeEnv({ expression: 'Promise.resolve(42)' }),
    );
    expect(out.value).toEqual({ __type: 'Promise' });
    expect(out.error).toBeUndefined();
  });

  it('times out a never-resolving thenable within the configured window', async () => {
    const startedAt = Date.now();
    const out = await evaluateHandler(
      makeEnv({
        expression: 'new Promise(()=>{})',
        await_promise: true,
        timeout_ms: 50,
      }),
    );
    const elapsedMs = Date.now() - startedAt;
    expect(out.error?.message).toMatch(/timeout after 50ms/);
    expect(out.value).toBeUndefined();
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('evaluateHandler — serialization', () => {
  it('truncates oversized values via captures/serialize and sets truncated:true', async () => {
    const out = await evaluateHandler(
      makeEnv({ expression: '"x".repeat(20000)' }),
    );
    expect(out.truncated).toBe(true);
    expect(out.value).toMatchObject({
      __type: 'Truncated',
      max: 16384,
    });
  });

  it('tags DOM nodes via the shared serializer', async () => {
    const out = await evaluateHandler(
      makeEnv({ expression: 'document.body' }),
    );
    expect(out.value).toMatchObject({ __type: 'DOMNode', nodeName: 'BODY' });
  });
});

describe('dispatchPageRequest — evaluate routing', () => {
  it('routes evaluate to the handler and wraps the result in a response envelope', async () => {
    const env = await dispatchPageRequest(
      Object.freeze({
        ns: PAGE_BRIDGE_NS,
        dir: 'cs->page' as const,
        requestId: 'r-disp-1',
        tool: 'evaluate',
        payload: { expression: '40+2' },
      }),
    );
    expect(env.dir).toBe('page->cs');
    expect(env.requestId).toBe('r-disp-1');
    expect(env.error).toBeUndefined();
    const payload = env.payload as EvaluateOutput;
    expect(payload.value).toBe(42);
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });
});
