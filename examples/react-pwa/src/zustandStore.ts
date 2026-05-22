/**
 * Zustand fixture store — canonical live target for pwa-debug's unified store_*
 * tools with framework:'zustand' (Path 4 M3).
 *
 * Shape deliberately mirrors the Redux fixture (store.ts) so assertions stay
 * parallel: a `count` number + a `todos` list, plus idiomatic in-store actions.
 * The Zustand adapter's synthesized dispatch invokes these by name
 * (dispatch({ type: 'increment' }) -> getState().increment()), and the
 * type:'setState' escape hatch merges a partial.
 *
 * The hook returned by create() also exposes getState/setState/subscribe, so it
 * doubles as the vanilla store handed off on window.__pwaDebug_zustand in
 * main.tsx. Markers below are locked for M3 assertions.
 */
import { create } from 'zustand';

export type ZTodo = { readonly id: number; readonly text: string };

export type ZustandState = {
  readonly count: number;
  readonly todos: readonly ZTodo[];
  readonly increment: () => void;
  readonly decrement: () => void;
  readonly addBy: (n: number) => void;
  readonly reset: () => void;
  readonly addTodo: (text: string) => void;
  readonly removeTodo: (id: number) => void;
};

export const useZustandStore = create<ZustandState>((set) => ({
  count: 0,
  todos: [],
  increment: () => set((s) => ({ count: s.count + 1 })),
  decrement: () => set((s) => ({ count: s.count - 1 })),
  addBy: (n: number) => set((s) => ({ count: s.count + n })),
  reset: () => set({ count: 0 }),
  addTodo: (text: string) =>
    set((s) => {
      const id = s.todos.length
        ? Math.max(...s.todos.map((t) => t.id)) + 1
        : 1;
      return { todos: [...s.todos, { id, text }] };
    }),
  removeTodo: (id: number) =>
    set((s) => ({ todos: s.todos.filter((t) => t.id !== id) })),
}));
