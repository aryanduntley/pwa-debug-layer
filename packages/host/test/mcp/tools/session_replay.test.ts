import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  sessionReplayHandler,
  sessionReplayTool,
} from '../../../src/mcp/tools/session_replay.js';
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
import { z } from 'zod';

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
    listConnections: () =>
      opts.connections ?? [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
  });
  return Object.freeze({
    ipcServer: fake,
    hostVersion: '0.0.0-test',
    capturesRegistry: opts.registry ?? createCapturesRegistry(),
    settingsStore: mockSettingsStore(),
  });
};

const replayEvent = (
  ts: number,
  sessionId: string,
  rrwebType: number,
  data: unknown,
): HostCapturedEvent =>
  ({
    kind: 'replay',
    ts,
    sessionId,
    rrwebType,
    data,
    timestamp: ts,
    frameUrl: 'https://test.local/',
    frameKey: 'top',
  }) as HostCapturedEvent;

type ReplayTailData = {
  entries: ReadonlyArray<{
    ts: number;
    sequenceNumber: number;
    sessionId: string;
    rrwebType: number;
    data: unknown;
    cursor: string;
  }>;
  cursor: string | null;
  hasMore: boolean;
};

const schema = z.object(sessionReplayTool.inputSchema);

describe('sessionReplayTool — input schema', () => {
  it('accepts empty args', () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('accepts FilterSpec subset', () => {
    expect(
      schema.safeParse({ filter: { pattern: { include: ['IncrementalSnapshot'] }, limit: 50 } }).success,
    ).toBe(true);
  });
});

describe('sessionReplayHandler — target resolution', () => {
  it('errors when no NMH connected', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await sessionReplayHandler({}, ctx);
    expect(r.ok).toBe(false);
  });

  it('returns empty entries when no captures registry for the extension', async () => {
    const ctx = buildCtx();
    const r = await sessionReplayHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as ReplayTailData;
    expect(d.entries).toEqual([]);
    expect(d.cursor).toBeNull();
    expect(d.hasMore).toBe(false);
  });
});

describe('sessionReplayHandler — happy path', () => {
  it('returns replay events oldest→newest with cursors', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        replayEvent(1, 'sess-1', 4, { meta: 'init' }),
        replayEvent(2, 'sess-1', 2, { fullSnapshot: true }),
        replayEvent(3, 'sess-1', 3, { incremental: 0 }),
      ],
    });
    const ctx = buildCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      registry,
    });
    const r = await sessionReplayHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as ReplayTailData;
    expect(d.entries.length).toBe(3);
    expect(d.entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    expect(d.entries.map((e) => e.rrwebType)).toEqual([4, 2, 3]);
    expect(d.cursor).not.toBeNull();
    expect(d.hasMore).toBe(false);
    for (const e of d.entries) {
      expect(typeof e.cursor).toBe('string');
      expect(e.cursor.length).toBeGreaterThan(0);
    }
  });

  it('applies pattern filter via JSON.stringify', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        replayEvent(1, 's', 2, { fullSnapshot: true }),
        replayEvent(2, 's', 3, { incremental: 0 }),
      ],
    });
    const ctx = buildCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      registry,
    });
    const r = await sessionReplayHandler(
      { filter: { pattern: { include: ['fullSnapshot'] } } },
      ctx,
    );
    const d = r.data as ReplayTailData;
    expect(d.entries.length).toBe(1);
    expect(d.entries[0]?.sequenceNumber).toBe(1);
  });

  it('respects filter.limit (returns latest N)', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        replayEvent(1, 's', 0, { a: 1 }),
        replayEvent(2, 's', 0, { a: 2 }),
        replayEvent(3, 's', 0, { a: 3 }),
      ],
    });
    const ctx = buildCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      registry,
    });
    const r = await sessionReplayHandler({ filter: { limit: 2 } }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as ReplayTailData;
    expect(d.entries.length).toBe(2);
    expect(d.entries.map((e) => e.sequenceNumber)).toEqual([2, 3]);
  });
});
