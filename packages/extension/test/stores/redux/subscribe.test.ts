import { describe, it, expect, beforeEach } from 'vitest';
import type {
  FrameMeta,
  StoreChangeCapturedEvent,
} from '../../../src/captures/capture_console.js';
import type { CapturedEvent } from '@pwa-debug/shared';
import {
  computeShallowDiff,
  installStoreSubscription,
} from '../../../src/stores/redux/subscribe.js';

type FakeStore = {
  state: Record<string, unknown>;
  listeners: Set<() => void>;
  getState: () => Record<string, unknown>;
  subscribe: (l: () => void) => () => void;
  dispatch: (a: { type: string }) => unknown;
  setState: (next: Record<string, unknown>) => void;
};

const makeStore = (initial: Record<string, unknown>): FakeStore => {
  const store: FakeStore = {
    state: initial,
    listeners: new Set(),
    getState: () => store.state,
    subscribe: (l) => {
      store.listeners.add(l);
      return () => store.listeners.delete(l);
    },
    dispatch: (a) => a,
    setState: (next) => {
      store.state = next;
      for (const l of store.listeners) l();
    },
  };
  return store;
};

const FRAME: FrameMeta = {
  ts: 1000,
  frameUrl: 'https://test.local/',
  frameKey: 'top',
};

describe('computeShallowDiff', () => {
  it('returns undefined when references are identical', () => {
    const x = { a: 1 };
    expect(computeShallowDiff(x, x)).toBeUndefined();
  });

  it('returns undefined when both shallow-equal objects but different refs (no changed keys)', () => {
    const a = { a: 1 };
    const b = { a: 1 };
    // values are === at the top level, so the diff is empty.
    expect(computeShallowDiff(a, b)).toBeUndefined();
  });

  it('detects an added top-level key', () => {
    expect(computeShallowDiff({ a: 1 }, { a: 1, b: 2 })).toEqual({
      added: ['b'],
      changed: [],
      removed: [],
    });
  });

  it('detects a changed top-level value', () => {
    expect(computeShallowDiff({ a: 1 }, { a: 2 })).toEqual({
      added: [],
      changed: ['a'],
      removed: [],
    });
  });

  it('detects a removed top-level key', () => {
    expect(computeShallowDiff({ a: 1, b: 2 }, { a: 1 })).toEqual({
      added: [],
      changed: [],
      removed: ['b'],
    });
  });

  it('compares non-objects as a whole', () => {
    expect(computeShallowDiff(0, 1)).toEqual({
      added: [],
      changed: ['value'],
      removed: [],
    });
    expect(computeShallowDiff('a', 'b')).toEqual({
      added: [],
      changed: ['value'],
      removed: [],
    });
  });
});

describe('installStoreSubscription', () => {
  let emits: StoreChangeCapturedEvent[];
  let nowCount: number;
  let now: () => number;

  beforeEach(() => {
    emits = [];
    nowCount = 0;
    now = () => 1000 + ++nowCount;
  });

  const capture = (e: CapturedEvent): void => {
    if (e.kind === 'store_change') emits.push(e);
  };

  it('does not emit on the listener firing with unchanged state', () => {
    const store = makeStore({ counter: { value: 0 } });
    const dispose = installStoreSubscription({
      store,
      emit: capture,
      frame: FRAME,
      now,
    });
    // Set the SAME state object — no diff.
    store.setState(store.state);
    expect(emits).toHaveLength(0);
    dispose();
  });

  it('emits with shape { kind, ts, frameUrl, frameKey, storeId, diff, snapshot }', () => {
    const store = makeStore({ counter: { value: 0 } });
    installStoreSubscription({ store, emit: capture, frame: FRAME, now });
    store.setState({ counter: { value: 1 } });
    expect(emits).toHaveLength(1);
    const e = emits[0]!;
    expect(e.kind).toBe('store_change');
    expect(e.ts).toBeGreaterThanOrEqual(1000);
    expect(e.frameUrl).toBe(FRAME.frameUrl);
    expect(e.frameKey).toBe(FRAME.frameKey);
    expect(typeof e.storeId).toBe('string');
    expect(e.diff).toEqual({ added: [], changed: ['counter'], removed: [] });
    expect(e.snapshot).toEqual({ counter: { value: 1 } });
  });

  it('emits once per change (no coalescing)', () => {
    const store = makeStore({ n: 0 });
    installStoreSubscription({ store, emit: capture, frame: FRAME, now });
    store.setState({ n: 1 });
    store.setState({ n: 2 });
    store.setState({ n: 3 });
    expect(emits).toHaveLength(3);
  });

  it('path-narrowing scopes emits to that slice', () => {
    const store = makeStore({
      counter: { value: 0 },
      todos: { items: [] },
    });
    installStoreSubscription({
      store,
      emit: capture,
      frame: FRAME,
      path: 'counter',
      now,
    });
    // Change ONLY the todos slice; counter slice ref unchanged.
    store.setState({
      counter: store.state['counter'] as Record<string, unknown>,
      todos: { items: ['new'] },
    });
    expect(emits).toHaveLength(0);
    // Now change counter; emit fires.
    store.setState({
      counter: { value: 1 },
      todos: { items: ['new'] },
    });
    expect(emits).toHaveLength(1);
    expect(emits[0]?.path).toBe('counter');
    expect(emits[0]?.snapshot).toEqual({ value: 1 });
  });

  it('dispose prevents further emits', () => {
    const store = makeStore({ x: 0 });
    const dispose = installStoreSubscription({
      store,
      emit: capture,
      frame: FRAME,
      now,
    });
    store.setState({ x: 1 });
    expect(emits).toHaveLength(1);
    dispose();
    store.setState({ x: 2 });
    expect(emits).toHaveLength(1);
  });

  it('includes a stable storeId across emits on the same subscription', () => {
    const store = makeStore({ x: 0 });
    installStoreSubscription({ store, emit: capture, frame: FRAME, now });
    store.setState({ x: 1 });
    store.setState({ x: 2 });
    expect(emits[0]?.storeId).toBe(emits[1]?.storeId);
  });
});
