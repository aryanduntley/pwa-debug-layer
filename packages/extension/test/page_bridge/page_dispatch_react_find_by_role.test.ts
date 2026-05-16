import { describe, it, expect, afterEach } from 'vitest';
import {
  readReactFindByRoleInput,
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
  requestId = 'rr1',
): PageBridgeRequestEnvelope =>
  Object.freeze({
    ns: PAGE_BRIDGE_NS,
    dir: 'cs->page' as const,
    requestId,
    tool: 'react_find_by_role',
    payload,
  });

describe('readReactFindByRoleInput', () => {
  it('rejects null/non-object/missing/empty role', () => {
    expect(readReactFindByRoleInput(null)).toBeNull();
    expect(readReactFindByRoleInput('x')).toBeNull();
    expect(readReactFindByRoleInput({})).toBeNull();
    expect(readReactFindByRoleInput({ role: 9 })).toBeNull();
    expect(readReactFindByRoleInput({ role: '' })).toBeNull();
  });

  it('normalizes a minimal payload (role only)', () => {
    expect(readReactFindByRoleInput({ role: 'button' })).toEqual({
      role: 'button',
    });
  });

  it('keeps a non-empty name and well-formed numerics, drops malformed', () => {
    expect(
      readReactFindByRoleInput({
        role: 'button',
        name: 'Save',
        root_index: 1,
        max_matches: 3,
      }),
    ).toEqual({ role: 'button', name: 'Save', rootIndex: 1, maxMatches: 3 });
    expect(
      readReactFindByRoleInput({
        role: 'button',
        name: '',
        root_index: -1,
        max_matches: 0,
      }),
    ).toEqual({ role: 'button' });
  });
});

describe('dispatchPageRequest — react_find_by_role', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns a tool-level error payload for a bad payload', async () => {
    const env = await dispatchPageRequest(makeRequest({ no: 'role' }));
    expect(env.error).toBeUndefined();
    expect(
      (env.payload as { error: { message: string } }).error.message,
    ).toMatch(/payload must be/);
  });

  it('returns a tool-level error payload for an invalid name regex', async () => {
    const env = await dispatchPageRequest(
      makeRequest({ role: 'button', name: '(' }),
    );
    expect(env.error).toBeUndefined();
    expect(
      (env.payload as { error: { message: string } }).error.message,
    ).toMatch(/invalid name regex/);
  });

  it('returns an empty result when the page has no React roots', async () => {
    const env = await dispatchPageRequest(makeRequest({ role: 'button' }));
    expect(env.error).toBeUndefined();
    expect(env.payload).toEqual({
      matches: [],
      truncated: false,
      rootCount: 0,
    });
  });

  it('finds a matching component end-to-end against a real container', async () => {
    const mk = (overrides: Partial<Fiber>): Fiber =>
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
    btnEl.setAttribute('aria-label', 'Submit form');
    const btn = mk({ tag: 5, type: 'button', stateNode: btnEl });
    const app = mk({ tag: 0, type: { displayName: 'App' } });
    const root = mk({ tag: 3 });
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
      makeRequest({ role: 'button', name: 'Submit' }),
    );
    expect(env.error).toBeUndefined();
    const payload = env.payload as {
      matches: {
        stableId: string;
        displayName: string;
        role: string;
        name?: string;
      }[];
      rootCount: number;
    };
    expect(payload.rootCount).toBe(1);
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]!.role).toBe('button');
    expect(payload.matches[0]!.name).toBe('Submit form');
    expect(payload.matches[0]!.stableId.startsWith('root0/App[0]/button')).toBe(
      true,
    );
  });
});
