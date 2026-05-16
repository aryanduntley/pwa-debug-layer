import { describe, it, expect, afterEach } from 'vitest';
import {
  readReactFindByTextInput,
  dispatchPageRequest,
} from '../../src/page_bridge/page_dispatch.js';
import {
  PAGE_BRIDGE_NS,
  type PageBridgeRequestEnvelope,
} from '../../src/page_bridge/protocol.js';
import {
  REACT_CONTAINER_KEY_PREFIX,
  type Fiber,
} from '../../src/react/types.js';

const makeRequest = (
  payload: unknown,
  requestId = 'rf1',
): PageBridgeRequestEnvelope =>
  Object.freeze({
    ns: PAGE_BRIDGE_NS,
    dir: 'cs->page' as const,
    requestId,
    tool: 'react_find_by_text',
    payload,
  });

describe('readReactFindByTextInput', () => {
  it('rejects null/non-object/missing/empty pattern', () => {
    expect(readReactFindByTextInput(null)).toBeNull();
    expect(readReactFindByTextInput('x')).toBeNull();
    expect(readReactFindByTextInput({})).toBeNull();
    expect(readReactFindByTextInput({ pattern: 42 })).toBeNull();
    expect(readReactFindByTextInput({ pattern: '' })).toBeNull();
  });

  it('normalizes a minimal payload with exact defaulting to false', () => {
    expect(readReactFindByTextInput({ pattern: 'foo' })).toEqual({
      pattern: 'foo',
      exact: false,
    });
  });

  it('passes exact through only when boolean true', () => {
    expect(readReactFindByTextInput({ pattern: 'a', exact: true })).toEqual({
      pattern: 'a',
      exact: true,
    });
    expect(
      readReactFindByTextInput({ pattern: 'a', exact: 'yes' }),
    ).toEqual({ pattern: 'a', exact: false });
  });

  it('keeps well-formed root_index/max_matches and drops malformed ones', () => {
    expect(
      readReactFindByTextInput({
        pattern: 'a',
        root_index: 2,
        max_matches: 5,
      }),
    ).toEqual({ pattern: 'a', exact: false, rootIndex: 2, maxMatches: 5 });
    expect(
      readReactFindByTextInput({
        pattern: 'a',
        root_index: -1,
        max_matches: 0,
      }),
    ).toEqual({ pattern: 'a', exact: false });
    expect(
      readReactFindByTextInput({
        pattern: 'a',
        root_index: 1.5,
        max_matches: 'lots',
      }),
    ).toEqual({ pattern: 'a', exact: false });
  });
});

describe('dispatchPageRequest — react_find_by_text', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns a tool-level error payload (not a wire error) for a bad payload', async () => {
    const env = await dispatchPageRequest(makeRequest({ no: 'pattern' }));
    expect(env.dir).toBe('page->cs');
    expect(env.error).toBeUndefined();
    expect(
      (env.payload as { error: { message: string } }).error.message,
    ).toMatch(/payload must be/);
  });

  it('returns a tool-level error payload for an invalid regex', async () => {
    const env = await dispatchPageRequest(makeRequest({ pattern: '(' }));
    expect(env.error).toBeUndefined();
    expect(
      (env.payload as { error: { message: string } }).error.message,
    ).toMatch(/invalid regex pattern/);
  });

  it('returns an empty result when the page has no React roots', async () => {
    const env = await dispatchPageRequest(makeRequest({ pattern: 'x' }));
    expect(env.error).toBeUndefined();
    expect(env.payload).toEqual({
      matches: [],
      truncated: false,
      rootCount: 0,
    });
  });

  it('finds a matching component end-to-end against a real container in the document', async () => {
    const mkFiber = (overrides: Partial<Fiber>): Fiber =>
      ({
        type: null,
        elementType: null,
        tag: 5,
        key: null,
        stateNode: null,
        child: null,
        sibling: null,
        return: null,
        memoizedProps: null,
        memoizedState: null,
        ...overrides,
      }) as Fiber;

    const btnEl = document.createElement('button');
    btnEl.textContent = 'Submit todo-marker-Z';
    const btn = mkFiber({ tag: 5, type: 'button', stateNode: btnEl });
    const app = mkFiber({ tag: 0, type: { displayName: 'App' } });
    const root = mkFiber({ tag: 3 });
    (root as { child: Fiber | null }).child = app;
    (app as { return: Fiber | null }).return = root;
    (app as { child: Fiber | null }).child = btn;
    (btn as { return: Fiber | null }).return = app;

    const container = document.createElement('div');
    (container as unknown as Record<string, unknown>)[
      `${REACT_CONTAINER_KEY_PREFIX}xyz`
    ] = { current: root };
    document.body.appendChild(container);

    const env = await dispatchPageRequest(
      makeRequest({ pattern: 'todo-marker-Z' }),
    );
    expect(env.error).toBeUndefined();
    const payload = env.payload as {
      matches: { stableId: string; displayName: string; matchedText: string }[];
      truncated: boolean;
      rootCount: number;
    };
    expect(payload.rootCount).toBe(1);
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.displayName).toBe('button');
    expect(payload.matches[0]!.matchedText).toBe('todo-marker-Z');
    expect(payload.matches[0]!.stableId.startsWith('root0/App[0]/button')).toBe(
      true,
    );
  });
});
