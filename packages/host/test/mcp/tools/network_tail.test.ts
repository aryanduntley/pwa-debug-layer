import { describe, it, expect } from 'vitest';
import {
  networkTailHandler,
  networkTailTool,
} from '../../../src/mcp/tools/network_tail.js';
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
import { encodeCursor } from '@pwa-debug/shared';

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

const fetchEvent = (
  ts: number,
  url: string,
  status: number,
  phase: 'request' | 'response' | 'error' = 'response',
): HostCapturedEvent =>
  ({
    kind: 'fetch',
    ts,
    phase,
    captureId: `cap-${ts}`,
    method: 'GET',
    url,
    status,
    frameUrl: 'about:blank',
    frameKey: 'frame-1',
  }) as HostCapturedEvent;

const xhrEvent = (ts: number, url: string): HostCapturedEvent =>
  ({
    kind: 'xhr',
    ts,
    phase: 'response',
    captureId: `xhr-${ts}`,
    method: 'POST',
    url,
    status: 200,
    frameUrl: 'about:blank',
    frameKey: 'frame-1',
  }) as HostCapturedEvent;

const wsEvent = (ts: number, subkind: string, url: string): HostCapturedEvent =>
  ({
    kind: 'websocket',
    ts,
    subkind,
    connectionId: `ws-${ts}`,
    url,
    frameUrl: 'about:blank',
    frameKey: 'frame-1',
  }) as HostCapturedEvent;

type NetworkTailData = {
  entries: ReadonlyArray<{
    ts: number;
    kind: string;
    sequenceNumber: number;
    cursor: string;
    [k: string]: unknown;
  }>;
  cursor: string | null;
  hasMore: boolean;
};

describe('network_tail — target resolution errors', () => {
  it('errors when no NMH is connected', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await networkTailHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no NMH connected/);
    expect(r.next_steps.some((s) => s.includes('FilterSpec'))).toBe(true);
  });

  it('errors when explicit extension_id is not connected', async () => {
    const ctx = buildCtx({ connections: [conn('aaa')] });
    const r = await networkTailHandler({ extension_id: 'bbb' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bbb/);
  });
});

describe('network_tail — empty registry (no events yet)', () => {
  it('returns empty entries / null cursor / hasMore=false with lazy-creation hint', async () => {
    const ctx = buildCtx({ connections: [conn('aaa')] });
    const r = await networkTailHandler({}, ctx);
    expect(r.ok).toBe(true);
    const data = r.data as NetworkTailData;
    expect(data.entries).toEqual([]);
    expect(data.cursor).toBeNull();
    expect(data.hasMore).toBe(false);
    expect(
      r.next_steps.some((s) => s.includes('lazily on first event')),
    ).toBe(true);
  });
});

describe('network_tail — happy path (mixed kinds)', () => {
  it('returns fetch + xhr + websocket oldest→newest with per-entry cursor', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        fetchEvent(1, 'https://example.com/api', 200),
        xhrEvent(2, 'https://example.com/data'),
        wsEvent(3, 'open', 'wss://example.com/sock'),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await networkTailHandler({}, ctx);
    expect(r.ok).toBe(true);
    const data = r.data as NetworkTailData;
    expect(data.entries.map((e) => e.kind)).toEqual(['fetch', 'xhr', 'websocket']);
    expect(data.entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    expect(data.cursor).not.toBeNull();
    expect(data.hasMore).toBe(false);
    for (const e of data.entries) {
      expect(typeof e.cursor).toBe('string');
      expect(e.cursor.length).toBeGreaterThan(0);
    }
  });

  it('pattern.include matches a URL substring', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        fetchEvent(1, 'https://example.com/api/users', 200),
        fetchEvent(2, 'https://example.com/static/main.js', 200),
        fetchEvent(3, 'https://example.com/api/orders', 200),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await networkTailHandler(
      { filter: { pattern: { include: ['/api/'] } } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as NetworkTailData;
    expect(data.entries.map((e) => e.sequenceNumber)).toEqual([1, 3]);
  });

  it('pattern.exclude rejects a URL substring', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        fetchEvent(1, 'https://example.com/static/main.js', 200),
        fetchEvent(2, 'https://example.com/api/users', 200),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await networkTailHandler(
      { filter: { pattern: { exclude: ['/static/'] } } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as NetworkTailData;
    expect(data.entries.map((e) => e.sequenceNumber)).toEqual([2]);
  });

  it('level filter on network buffer returns empty (network events lack level field)', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        fetchEvent(1, 'https://example.com/x', 200),
        xhrEvent(2, 'https://example.com/y'),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await networkTailHandler(
      { filter: { level: ['error'] } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as NetworkTailData;
    expect(data.entries).toEqual([]);
    expect(
      r.next_steps.some((s) => s.includes('does not apply to network')),
    ).toBe(true);
  });

  it('cursor round-trip: feed prior cursor as filter.since → only newer events', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        fetchEvent(1, 'https://example.com/a', 200),
        fetchEvent(2, 'https://example.com/b', 200),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const first = await networkTailHandler({}, ctx);
    expect(first.ok).toBe(true);
    const firstData = first.data as NetworkTailData;
    expect(firstData.cursor).not.toBeNull();
    captures.receive({
      events: [
        fetchEvent(3, 'https://example.com/c', 200),
        fetchEvent(4, 'https://example.com/d', 200),
      ],
    });
    const second = await networkTailHandler(
      { filter: { since: firstData.cursor as string } },
      ctx,
    );
    expect(second.ok).toBe(true);
    const secondData = second.data as NetworkTailData;
    expect(secondData.entries.map((e) => e.sequenceNumber)).toEqual([3, 4]);
    expect(secondData.hasMore).toBe(false);
  });

  it('hasMore=true wording surfaces in next_steps when limit truncates', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    const events: HostCapturedEvent[] = [];
    for (let i = 1; i <= 30; i++) {
      events.push(fetchEvent(i, `https://example.com/p${i}`, 200));
    }
    captures.receive({ events });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const sessionId = captures.getStats().sessionId;
    const since = encodeCursor({ sessionId, sequenceNumber: 0 });
    const r = await networkTailHandler(
      { filter: { since: since as string, limit: 10 } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as NetworkTailData;
    expect(data.entries.length).toBe(10);
    expect(data.hasMore).toBe(true);
    expect(r.next_steps.some((s) => s.includes('hasMore=true'))).toBe(true);
  });
});

describe('network_tail — FilterSpec error mapping', () => {
  it('cursor_invalid: malformed base64 since → errorResponse', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [fetchEvent(1, 'https://example.com/x', 200)],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await networkTailHandler(
      { filter: { since: '!!!!' } },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/filter\.since/);
    expect(r.next_steps.some((s) => s.includes('FilterSpec'))).toBe(true);
  });

  it('cursor_session_mismatch → errorResponse with both session ids', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [fetchEvent(1, 'https://example.com/x', 200)],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const stranger = encodeCursor({
      sessionId: 'OTHER-SESSION',
      sequenceNumber: 0,
    });
    const r = await networkTailHandler(
      { filter: { since: stranger as string } },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/OTHER-SESSION/);
  });

  it('pattern_invalid: bad regex source → errorResponse with fieldPath in error', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [fetchEvent(1, 'https://example.com/x', 200)],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await networkTailHandler(
      { filter: { pattern: { exclude: ['ok', '('] } } },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/filter\.pattern\.exclude\[1\]/);
  });

  it('limit_invalid: limit=0 → errorResponse', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [fetchEvent(1, 'https://example.com/x', 200)],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await networkTailHandler({ filter: { limit: 0 } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/filter\.limit/);
  });

  it('limit_invalid: limit=2000 → errorResponse', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [fetchEvent(1, 'https://example.com/x', 200)],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await networkTailHandler({ filter: { limit: 2000 } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/<= 1000/);
  });
});

describe('network_tail — tool registration', () => {
  it('exports tool with snake_case name and a filter input slot', () => {
    expect(networkTailTool.name).toBe('network_tail');
    expect(networkTailTool.handler).toBe(networkTailHandler);
    expect(networkTailTool.inputSchema.extension_id).toBeDefined();
    expect(networkTailTool.inputSchema.filter).toBeDefined();
  });
});
