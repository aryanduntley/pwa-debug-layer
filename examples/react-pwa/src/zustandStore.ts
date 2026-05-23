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
 *
 * M36: wrapped in the `devtools(...)` middleware so it ALSO drives
 * __REDUX_DEVTOOLS_EXTENSION__.connect at create-time — the live target for the
 * Zustand devtools auto-capture shim (installZustandDevtoolsShim). `enabled:
 * true` forces the devtools path on in production builds too (the middleware
 * otherwise gates on NODE_ENV !== 'production'). The middleware preserves the
 * store API, so the explicit __pwaDebug_zustand handoff still works unchanged;
 * deleting that handoff at runtime lets store_* fall through to the shim path.
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

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

export const useZustandStore = create<ZustandState>()(
  devtools(
    (set) => ({
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
    }),
    { name: 'pwa-debug-zustand-fixture', enabled: true },
  ),
);
