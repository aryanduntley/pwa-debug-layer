import { describe, it, expect } from 'vitest';
import {
  captureDebugStatsHandler,
  captureDebugStatsTool,
} from '../../../src/mcp/tools/capture_debug_stats.js';
import type { ToolContext } from '../../../src/mcp/tool_registry.js';
import type {
  IpcConnectionInfo,
  IpcServer,
} from '../../../src/mcp/ipc/ipc_server.js';
import {
  createCapturesRegistry,
  type CapturesRegistry,
  type HostCapturedEvent,
} from '../../../src/captures_in/captures_in.js';

type FakeOpts = {
  readonly connections?: readonly IpcConnectionInfo[];
  readonly registry?: CapturesRegistry;
};

const buildCtx = (opts: FakeOpts = {}): ToolContext => {
  const fake: IpcServer = Object.freeze({
    close: async () => {},
    sendTo: () => Object.freeze({ ok: true as const }),
    request: async () =>
      Object.freeze({
        type: 'response' as const,
        requestId: 'stub',
        payload: {},
      }),
    listConnections: () => opts.connections ?? [],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: opts.registry ?? createCapturesRegistry(),
  });
};

const conn = (id: string): IpcConnectionInfo => ({
  extensionId: id,
  connectedAt: 1,
  lastSeenAt: 1,
});

describe('capture_debug_stats — target resolution errors', () => {
  it('errors when no NMH is connected', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await captureDebugStatsHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no NMH connected/);
    expect(r.next_steps.some((s) => s.includes('host_status'))).toBe(true);
  });

  it('errors when extension_id specified but not connected', async () => {
    const ctx = buildCtx({ connections: [conn('aaa')] });
    const r = await captureDebugStatsHandler({ extension_id: 'bbb' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bbb/);
  });

  it('errors when multiple connections without explicit extension_id', async () => {
    const ctx = buildCtx({ connections: [conn('aaa'), conn('bbb')] });
    const r = await captureDebugStatsHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/multiple/);
  });
});

describe('capture_debug_stats — happy path', () => {
  it('returns zero-stats when extension is connected but registry is empty', async () => {
    const ctx = buildCtx({ connections: [conn('aaa')] });
    const r = await captureDebugStatsHandler({}, ctx);
    expect(r.ok).toBe(true);
    const data = r.data as {
      perKind: Record<string, { received: number; dropped: number; size: number }>;
      droppedUnknown: number;
      totals: { received: number; dropped: number };
      sessionId: string;
      extensionId: string;
    };
    expect(data.extensionId).toBe('aaa');
    expect(data.sessionId).toBe('no-events-yet');
    expect(data.droppedUnknown).toBe(0);
    expect(data.totals).toEqual({ received: 0, dropped: 0 });
    for (const kind of ['console', 'network', 'dom_mutations', 'lifecycle']) {
      expect(data.perKind[kind]).toEqual({ received: 0, dropped: 0, size: 0 });
    }
    expect(
      r.next_steps.some((s) => s.includes('connected but no captures-flavor events')),
    ).toBe(true);
  });

  it('returns live CapturesIn.getStats() when registry has entry', async () => {
    const registry = createCapturesRegistry({ getNow: () => 1 });
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        { kind: 'console', ts: 1, level: 'log' } as HostCapturedEvent,
        { kind: 'fetch', ts: 2, phase: 'request' } as HostCapturedEvent,
        { kind: 'fetch', ts: 3, phase: 'response' } as HostCapturedEvent,
        { kind: 'garbage', ts: 4 } as HostCapturedEvent,
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await captureDebugStatsHandler({}, ctx);
    expect(r.ok).toBe(true);
    const data = r.data as {
      perKind: Record<string, { received: number; dropped: number; size: number }>;
      droppedUnknown: number;
      totals: { received: number; dropped: number };
      sessionId: string;
      extensionId: string;
    };
    expect(data.extensionId).toBe('aaa');
    expect(data.sessionId).not.toBe('no-events-yet');
    expect(data.perKind.console).toEqual({ received: 1, dropped: 0, size: 1 });
    expect(data.perKind.network).toEqual({ received: 2, dropped: 0, size: 2 });
    expect(data.perKind.dom_mutations).toEqual({ received: 0, dropped: 0, size: 0 });
    expect(data.perKind.lifecycle).toEqual({ received: 0, dropped: 0, size: 0 });
    expect(data.droppedUnknown).toBe(1);
    expect(data.totals.received).toBe(3);
    expect(data.totals.dropped).toBe(1);
  });

  it('respects explicit extension_id when multiple connections exist', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [{ kind: 'console', ts: 1 } as HostCapturedEvent],
    });
    registry.getOrCreate('bbb').receive({
      events: [
        { kind: 'console', ts: 1 } as HostCapturedEvent,
        { kind: 'console', ts: 2 } as HostCapturedEvent,
      ],
    });
    const ctx = buildCtx({
      connections: [conn('aaa'), conn('bbb')],
      registry,
    });
    const rA = await captureDebugStatsHandler({ extension_id: 'aaa' }, ctx);
    const rB = await captureDebugStatsHandler({ extension_id: 'bbb' }, ctx);
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect((rA.data as { perKind: { console: { received: number } } }).perKind.console.received).toBe(1);
    expect((rB.data as { perKind: { console: { received: number } } }).perKind.console.received).toBe(2);
  });
});

describe('capture_debug_stats — next_steps', () => {
  it('always mentions the M11-temporary lifespan', async () => {
    const ctx = buildCtx({ connections: [conn('aaa')] });
    const r = await captureDebugStatsHandler({}, ctx);
    expect(r.next_steps.some((s) => /TEMPORARY M11|M4/.test(s))).toBe(true);
  });
});

describe('capture_debug_stats — tool registration', () => {
  it('exports tool with the snake_case name and inputSchema', () => {
    expect(captureDebugStatsTool.name).toBe('capture_debug_stats');
    expect(captureDebugStatsTool.handler).toBe(captureDebugStatsHandler);
    expect(captureDebugStatsTool.inputSchema.extension_id).toBeDefined();
  });
});
