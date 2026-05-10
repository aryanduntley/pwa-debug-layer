import { describe, it, expect } from 'vitest';
import {
  consoleTailHandler,
  consoleTailTool,
} from '../../../src/mcp/tools/console_tail.js';
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

const consoleEvent = (ts: number, level: string, args: readonly unknown[]): HostCapturedEvent =>
  ({ kind: 'console', ts, level, args, frameUrl: 'about:blank', frameKey: 'frame-1' }) as HostCapturedEvent;

type ConsoleTailData = {
  entries: ReadonlyArray<{
    ts: number;
    sequenceNumber: number;
    level: string;
    args: readonly unknown[];
    cursor: string;
  }>;
  cursor: string | null;
  hasMore: boolean;
};

describe('console_tail — target resolution errors', () => {
  it('errors when no NMH is connected', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await consoleTailHandler({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no NMH connected/);
    expect(r.next_steps.some((s) => s.includes('FilterSpec'))).toBe(true);
  });

  it('errors when explicit extension_id is not connected', async () => {
    const ctx = buildCtx({ connections: [conn('aaa')] });
    const r = await consoleTailHandler({ extension_id: 'bbb' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bbb/);
  });
});

describe('console_tail — empty registry (no events yet)', () => {
  it('returns empty entries / null cursor / hasMore=false with lazy-creation hint', async () => {
    const ctx = buildCtx({ connections: [conn('aaa')] });
    const r = await consoleTailHandler({}, ctx);
    expect(r.ok).toBe(true);
    const data = r.data as ConsoleTailData;
    expect(data.entries).toEqual([]);
    expect(data.cursor).toBeNull();
    expect(data.hasMore).toBe(false);
    expect(
      r.next_steps.some((s) => s.includes('lazily on first event')),
    ).toBe(true);
  });
});

describe('console_tail — happy path (no filter)', () => {
  it('returns all console events oldest→newest with cursor + per-entry cursor', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        consoleEvent(1, 'log', ['hello']),
        consoleEvent(2, 'warn', ['watchout']),
        consoleEvent(3, 'error', ['bang']),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await consoleTailHandler({}, ctx);
    expect(r.ok).toBe(true);
    const data = r.data as ConsoleTailData;
    expect(data.entries.length).toBe(3);
    expect(data.entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    expect(data.entries.map((e) => e.level)).toEqual(['log', 'warn', 'error']);
    expect(data.cursor).not.toBeNull();
    expect(data.hasMore).toBe(false);
    for (const e of data.entries) {
      expect(typeof e.cursor).toBe('string');
      expect(e.cursor.length).toBeGreaterThan(0);
    }
  });

  it('filters by level=[error]', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        consoleEvent(1, 'log', ['x']),
        consoleEvent(2, 'error', ['y']),
        consoleEvent(3, 'warn', ['z']),
        consoleEvent(4, 'error', ['w']),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await consoleTailHandler(
      { filter: { level: ['error'] } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as ConsoleTailData;
    expect(data.entries.map((e) => e.sequenceNumber)).toEqual([2, 4]);
  });

  it('filters by pattern.include', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        consoleEvent(1, 'log', ['hello world']),
        consoleEvent(2, 'log', ['TypeError: bad']),
        consoleEvent(3, 'log', ['ok']),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await consoleTailHandler(
      { filter: { pattern: { include: ['TypeError'] } } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as ConsoleTailData;
    expect(data.entries.map((e) => e.sequenceNumber)).toEqual([2]);
  });

  it('rejects events matching pattern.exclude', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        consoleEvent(1, 'log', ['extension://chrome-extension/abc']),
        consoleEvent(2, 'log', ['app://my-page']),
      ],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await consoleTailHandler(
      { filter: { pattern: { exclude: ['extension://'] } } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as ConsoleTailData;
    expect(data.entries.map((e) => e.sequenceNumber)).toEqual([2]);
  });

  it('cursor round-trip: feed prior cursor as filter.since → only newer events', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [consoleEvent(1, 'log', ['a']), consoleEvent(2, 'log', ['b'])],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const first = await consoleTailHandler({}, ctx);
    expect(first.ok).toBe(true);
    const firstData = first.data as ConsoleTailData;
    expect(firstData.cursor).not.toBeNull();
    captures.receive({
      events: [consoleEvent(3, 'log', ['c']), consoleEvent(4, 'log', ['d'])],
    });
    const second = await consoleTailHandler(
      { filter: { since: firstData.cursor as string } },
      ctx,
    );
    expect(second.ok).toBe(true);
    const secondData = second.data as ConsoleTailData;
    expect(secondData.entries.map((e) => e.sequenceNumber)).toEqual([3, 4]);
    expect(secondData.hasMore).toBe(false);
  });

  it('hasMore=true wording surfaces in next_steps when limit truncates', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    const events: HostCapturedEvent[] = [];
    for (let i = 1; i <= 30; i++) {
      events.push(consoleEvent(i, 'log', [`m${i}`]));
    }
    captures.receive({ events });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const sessionId = captures.getStats().sessionId;
    const since = encodeCursor({ sessionId, sequenceNumber: 0 });
    const r = await consoleTailHandler(
      { filter: { since: since as string, limit: 10 } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as ConsoleTailData;
    expect(data.entries.length).toBe(10);
    expect(data.hasMore).toBe(true);
    expect(r.next_steps.some((s) => s.includes('hasMore=true'))).toBe(true);
  });
});

describe('console_tail — FilterSpec error mapping', () => {
  it('cursor_invalid: malformed base64 since → errorResponse with FilterSpec hint', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [consoleEvent(1, 'log', ['x'])],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await consoleTailHandler(
      { filter: { since: '!!!!' } },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/filter\.since/);
    expect(r.next_steps.some((s) => s.includes('FilterSpec'))).toBe(true);
  });

  it('cursor_session_mismatch: cursor minted for a different session → errorResponse', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [consoleEvent(1, 'log', ['x'])],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const stranger = encodeCursor({
      sessionId: 'OTHER-SESSION',
      sequenceNumber: 0,
    });
    const r = await consoleTailHandler(
      { filter: { since: stranger as string } },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/OTHER-SESSION/);
    expect(r.error).toMatch(/host registry was reset|filter\.since cursor/);
  });

  it('pattern_invalid: bad regex source → errorResponse with fieldPath in error', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [consoleEvent(1, 'log', ['x'])],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await consoleTailHandler(
      { filter: { pattern: { include: ['('] } } },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/filter\.pattern\.include\[0\]/);
  });

  it('limit_invalid: limit=0 → errorResponse', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [consoleEvent(1, 'log', ['x'])],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await consoleTailHandler(
      { filter: { limit: 0 } },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/filter\.limit/);
  });

  it('limit_invalid: limit=2000 → errorResponse', async () => {
    const registry = createCapturesRegistry();
    registry.getOrCreate('aaa').receive({
      events: [consoleEvent(1, 'log', ['x'])],
    });
    const ctx = buildCtx({ connections: [conn('aaa')], registry });
    const r = await consoleTailHandler(
      { filter: { limit: 2000 } },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/<= 1000/);
  });
});

describe('console_tail — tool registration', () => {
  it('exports tool with snake_case name and a filter input slot', () => {
    expect(consoleTailTool.name).toBe('console_tail');
    expect(consoleTailTool.handler).toBe(consoleTailHandler);
    expect(consoleTailTool.inputSchema.extension_id).toBeDefined();
    expect(consoleTailTool.inputSchema.filter).toBeDefined();
  });
});
