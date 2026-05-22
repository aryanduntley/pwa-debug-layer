/**
 * Jotai fixture store — canonical live target for pwa-debug's unified store_*
 * tools with framework:'jotai' (Path 4 M5).
 *
 * Jotai has no addressable state tree, so the pwa-debug handoff is the WRAPPED
 * { store, atoms } shape the adapter expects: an explicit createStore() instance
 * plus a name->atom registry. The adapter projects that into a name-keyed
 * snapshot (state.count / state.todos), so assertions stay parallel with the
 * Redux/Zustand fixtures. Markers below are locked for M5.
 */
import { atom, createStore } from 'jotai';

export type JTodo = { readonly id: number; readonly text: string };

export const countAtom = atom(0);
export const todosAtom = atom<readonly JTodo[]>([]);

// Explicit store so the same instance can back the React Provider AND the
// window.__pwaDebug_jotai handoff (createStore() returns { get, set, sub }).
export const jotaiStore = createStore();

// Name->atom registry the adapter introspects. Keep names stable for assertions.
export const jotaiAtoms = {
  count: countAtom,
  todos: todosAtom,
} as const;
