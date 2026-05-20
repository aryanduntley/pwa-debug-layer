import { describe, it, expect } from 'vitest';
import { mockSettingsStore } from '../../_helpers/mock_settings_store.js';
import {
  reduxTailHandler,
  reduxTailTool,
} from '../../../src/mcp/tools/redux_tail.js';
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

const storeEvent = (
  ts: number,
  snapshot: unknown,
  diff = { added: [], changed: ['value'], removed: [] },
): HostCapturedEvent =>
  ({
    kind: 'store_change',
    ts,
    storeId: 'store-1',
    diff,
    snapshot,
    frameUrl: 'https://test.local/',
    frameKey: 'top',
  }) as HostCapturedEvent;

type ReduxTailData = {
  entries: ReadonlyArray<{
    ts: number;
    sequenceNumber: number;
    storeId: string;
    diff: { added: readonly string[]; changed: readonly string[]; removed: readonly string[] };
    snapshot: unknown;
    cursor: string;
  }>;
  cursor: string | null;
  hasMore: boolean;
};

const schema = z.object(reduxTailTool.inputSchema);

describe('reduxTailTool — input schema', () => {
  it('accepts empty args', () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('accepts FilterSpec subset', () => {
    expect(
      schema.safeParse({ filter: { pattern: { include: ['todos'] }, limit: 50 } }).success,
    ).toBe(true);
  });
});

describe('reduxTailHandler — target resolution', () => {
  it('errors when no NMH connected', async () => {
    const ctx = buildCtx({ connections: [] });
    const r = await reduxTailHandler({}, ctx);
    expect(r.ok).toBe(false);
  });

  it('returns empty entries when registry not yet created for the extension', async () => {
    const ctx = buildCtx();
    const r = await reduxTailHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as ReduxTailData;
    expect(d.entries).toEqual([]);
    expect(d.cursor).toBeNull();
    expect(d.hasMore).toBe(false);
  });
});

describe('reduxTailHandler — happy path', () => {
  it('returns store_change events oldest→newest with cursors', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        storeEvent(1, { counter: { value: 1 } }),
        storeEvent(2, { counter: { value: 2 } }),
        storeEvent(3, { counter: { value: 3 } }),
      ],
    });
    const ctx = buildCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      registry,
    });
    const r = await reduxTailHandler({}, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as ReduxTailData;
    expect(d.entries.length).toBe(3);
    expect(d.entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    expect(d.entries.map((e) => e.snapshot)).toEqual([
      { counter: { value: 1 } },
      { counter: { value: 2 } },
      { counter: { value: 3 } },
    ]);
    expect(d.cursor).not.toBeNull();
    expect(d.hasMore).toBe(false);
    for (const e of d.entries) {
      expect(typeof e.cursor).toBe('string');
      expect(e.cursor.length).toBeGreaterThan(0);
    }
  });

  it('applies pattern filter via JSON.stringify of the entry', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        storeEvent(1, { counter: { value: 1 } }),
        storeEvent(2, { todos: { items: ['buy milk'] } }),
        storeEvent(3, { counter: { value: 3 } }),
      ],
    });
    const ctx = buildCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      registry,
    });
    const r = await reduxTailHandler(
      { filter: { pattern: { include: ['todos'] } } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const d = r.data as ReduxTailData;
    expect(d.entries.length).toBe(1);
    expect(d.entries[0]?.sequenceNumber).toBe(2);
  });

  it('respects filter.limit and reports hasMore=false for memory-only tail', async () => {
    const registry = createCapturesRegistry();
    const captures = registry.getOrCreate('aaa');
    captures.receive({
      events: [
        storeEvent(1, { v: 1 }),
        storeEvent(2, { v: 2 }),
        storeEvent(3, { v: 3 }),
      ],
    });
    const ctx = buildCtx({
      connections: [{ extensionId: 'aaa', connectedAt: 1, lastSeenAt: 1 }],
      registry,
    });
    const r = await reduxTailHandler({ filter: { limit: 2 } }, ctx);
    expect(r.ok).toBe(true);
    const d = r.data as ReduxTailData;
    // Latest-N semantics: returns the 2 newest, no hasMore for memory-only.
    expect(d.entries.length).toBe(2);
    expect(d.entries.map((e) => e.sequenceNumber)).toEqual([2, 3]);
    expect(d.hasMore).toBe(false);
  });
});
