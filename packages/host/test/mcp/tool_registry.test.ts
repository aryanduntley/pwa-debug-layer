import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  registerTools,
  okResponse,
  errorResponse,
  type ToolDef,
  type ToolContext,
} from '../../src/mcp/tool_registry.js';
import type { IpcServer } from '../../src/mcp/ipc/ipc_server.js';

const stubIpcServer: IpcServer = Object.freeze({
  close: async () => {},
  sendTo: () => Object.freeze({ ok: true as const }),
  request: async () =>
    Object.freeze({
      type: 'response' as const,
      requestId: 'stub',
      payload: {},
    }),
  listConnections: () => Object.freeze([]),
});

const stubCtx: ToolContext = Object.freeze({
  ipcServer: stubIpcServer,
  hostVersion: '0.0.0-test',
});

describe('okResponse / errorResponse', () => {
  it('okResponse builds the success envelope and freezes it', () => {
    const r = okResponse({ x: 1 }, ['next a', 'next b']);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ x: 1 });
    expect(r.error).toBeUndefined();
    expect(r.next_steps).toEqual(['next a', 'next b']);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.next_steps)).toBe(true);
  });

  it('errorResponse builds the failure envelope', () => {
    const r = errorResponse('boom', ['retry later']);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
    expect(r.data).toBeUndefined();
    expect(r.next_steps).toEqual(['retry later']);
  });
});

describe('registerTools', () => {
  it('registers each tool with the SDK and wraps the handler in CallToolResult shape', async () => {
    const calls: Array<{
      name: string;
      cfg: { description?: string; inputSchema?: unknown };
      cb: (args: unknown) => Promise<unknown>;
    }> = [];

    const fakeServer = {
      registerTool: vi.fn(
        (
          name: string,
          cfg: { description?: string; inputSchema?: unknown },
          cb: (args: unknown) => Promise<unknown>,
        ) => {
          calls.push({ name, cfg, cb });
        },
      ),
    } as unknown as Parameters<typeof registerTools>[0];

    const tool: ToolDef<{ id: z.ZodString }> = {
      name: 'test_tool',
      description: 'desc',
      inputSchema: { id: z.string() },
      handler: async (args) =>
        okResponse({ echoed: args.id }, ['call other tool next']),
    };

    registerTools(fakeServer, [tool], stubCtx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('test_tool');
    expect(calls[0]!.cfg.description).toBe('desc');

    const result = (await calls[0]!.cb({ id: 'abc' })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { ok: boolean; data: { echoed: string }; next_steps: string[] };
    };
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.data).toEqual({ echoed: 'abc' });
    expect(result.structuredContent.next_steps).toEqual(['call other tool next']);
    expect(result.content[0]!.type).toBe('text');
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.echoed).toBe('abc');
  });
});
