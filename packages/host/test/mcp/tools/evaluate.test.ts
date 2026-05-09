import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { evaluateHandler, evaluateTool } from '../../../src/mcp/tools/evaluate.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import type {
  IpcRequestEnvelope,
  IpcResponseEnvelope,
} from '../../../src/mcp/ipc/envelope.js';

type FakeOpts = {
  readonly connections?: readonly IpcConnectionInfo[];
  readonly responsePayload?: unknown;
  readonly responseError?: { readonly message: string };
  readonly throwOnRequest?: Error;
  readonly captureRequest?: { current: IpcRequestEnvelope | null };
};

const buildCtx = (opts: FakeOpts = {}): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async (
      _extId: string,
      env: IpcRequestEnvelope,
    ): Promise<IpcResponseEnvelope> => {
      if (opts.captureRequest !== undefined) {
        opts.captureRequest.current = env;
      }
      if (opts.throwOnRequest !== undefined) {
        throw opts.throwOnRequest;
      }
      if (opts.responseError !== undefined) {
        return Object.freeze({
          type: 'response' as const,
          requestId: env.requestId,
          error: opts.responseError,
        });
      }
      return Object.freeze({
        type: 'response' as const,
        requestId: env.requestId,
        payload: opts.responsePayload ?? {},
      });
    },
    listConnections: () =>
      opts.connections ?? [
        { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
      ],
  });
  return Object.freeze({ ipcServer: fake, hostVersion: '0.0.0-test' });
};

const schema = z.object(evaluateTool.inputSchema);

describe('evaluateTool — input schema', () => {
  it('rejects missing expression', () => {
    const r = schema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects empty expression', () => {
    const r = schema.safeParse({ expression: '' });
    expect(r.success).toBe(false);
  });

  it('accepts a minimal valid payload', () => {
    const r = schema.safeParse({ expression: '1+1' });
    expect(r.success).toBe(true);
  });

  it('accepts a full payload with all optional fields', () => {
    const r = schema.safeParse({
      extension_id: 'aaa',
      tab_id: 99,
      expression: 'document.title',
      timeout_ms: 1000,
      await_promise: true,
    });
    expect(r.success).toBe(true);
  });

  it('rejects timeout_ms above the 3500ms cap', () => {
    const r = schema.safeParse({ expression: '1+1', timeout_ms: 5000 });
    expect(r.success).toBe(false);
  });

  it('rejects timeout_ms <= 0', () => {
    const r = schema.safeParse({ expression: '1+1', timeout_ms: 0 });
    expect(r.success).toBe(false);
  });
});

describe('evaluateHandler — IPC envelope shape', () => {
  it('builds the envelope with tool=evaluate and includes only set optional fields', async () => {
    const captured: { current: IpcRequestEnvelope | null } = { current: null };
    const ctx = buildCtx({
      captureRequest: captured,
      responsePayload: { value: 2, durationMs: 1 },
    });
    await evaluateHandler({ expression: '1+1' }, ctx);
    expect(captured.current?.tool).toBe('evaluate');
    expect(captured.current?.extensionId).toBe('aaa');
    expect(captured.current?.payload).toEqual({ expression: '1+1' });
  });

  it('forwards tab_id, timeout_ms, and await_promise through the envelope payload', async () => {
    const captured: { current: IpcRequestEnvelope | null } = { current: null };
    const ctx = buildCtx({
      captureRequest: captured,
      responsePayload: { value: 'ok', durationMs: 1 },
    });
    await evaluateHandler(
      {
        expression: 'document.title',
        tab_id: 99,
        timeout_ms: 1000,
        await_promise: true,
      },
      ctx,
    );
    expect(captured.current?.payload).toEqual({
      expression: 'document.title',
      tab_id: 99,
      timeout_ms: 1000,
      await_promise: true,
    });
  });
});

describe('evaluateHandler — response mapping', () => {
  it('maps a successful page-world payload to ok:true with value+durationMs', async () => {
    const ctx = buildCtx({
      responsePayload: { value: 42, durationMs: 3 },
    });
    const r = await evaluateHandler({ expression: '40+2' }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      extensionId: string;
      tabId: number | null;
      value: unknown;
      durationMs: number;
    };
    expect(d.extensionId).toBe('aaa');
    expect(d.tabId).toBeNull();
    expect(d.value).toBe(42);
    expect(d.durationMs).toBe(3);
  });

  it('returns ok:true and surfaces payload.error (expression-level failure, not transport)', async () => {
    const ctx = buildCtx({
      responsePayload: {
        error: { message: 'boom', stack: 'Error: boom\n  at ...' },
        durationMs: 0,
      },
    });
    const r = await evaluateHandler({ expression: '(()=>{throw 1})()' }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as {
      error?: { message: string; stack?: string };
    };
    expect(d.error?.message).toBe('boom');
    expect(d.error?.stack).toMatch(/Error: boom/);
    expect(r.next_steps.join(' ')).toMatch(/expression failure/);
  });

  it('hints to set await_promise when value is a Promise tag and await_promise was omitted', async () => {
    const ctx = buildCtx({
      responsePayload: { value: { __type: 'Promise' }, durationMs: 0 },
    });
    const r = await evaluateHandler(
      { expression: 'Promise.resolve(42)' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.next_steps.join(' ')).toMatch(/await_promise:true/);
  });

  it('hints to reduce projection when truncated:true', async () => {
    const ctx = buildCtx({
      responsePayload: {
        value: { __type: 'Truncated', approxSize: 99999, max: 16384 },
        truncated: true,
        durationMs: 0,
      },
    });
    const r = await evaluateHandler({ expression: '"x".repeat(20000)' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.next_steps.join(' ')).toMatch(/truncated:true/);
  });

  it('maps an NMH error envelope to ok:false with diagnostic next_steps', async () => {
    const ctx = buildCtx({
      responseError: { message: 'no active tab' },
    });
    const r = await evaluateHandler({ expression: '1+1' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/evaluate nmh error: no active tab/);
    expect(r.next_steps.join(' ')).toMatch(/no active tab/i);
  });

  it('maps an IPC failure (timeout/disconnect) to ok:false with diagnostic next_steps', async () => {
    const ctx = buildCtx({
      throwOnRequest: new Error('IPC timeout after 5000ms'),
    });
    const r = await evaluateHandler({ expression: '1+1' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/evaluate failed: IPC timeout/);
    expect(r.next_steps.join(' ')).toMatch(/IPC request did not complete/);
  });

  it('errors when no extension is connected', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await evaluateHandler({ expression: '1+1' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.next_steps.join(' ')).toMatch(/host_register_extension/);
  });

  it('errors when multiple extensions are connected and no extension_id is given', async () => {
    const ctx = buildCtx({
      connections: [
        { extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 },
        { extensionId: 'bbb', connectedAt: 2, lastSeenAt: 2 },
      ],
    });
    const r = await evaluateHandler({ expression: '1+1' }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe('evaluateTool — registration shape', () => {
  it('exposes the expected tool name and a non-trivial description', () => {
    expect(evaluateTool.name).toBe('evaluate');
    expect(evaluateTool.description.length).toBeGreaterThan(100);
    expect(evaluateTool.description).toMatch(/MAIN world/);
  });
});
