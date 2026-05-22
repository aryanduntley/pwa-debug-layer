# pwa-debug React fixture

Minimal React 18 + TypeScript app used as the canonical test target for the
React introspection tools shipped under Path 3 of pwa-debug-layer.

This is a **standalone npm project** — it intentionally lives outside the
pnpm workspace so its build/dependencies are isolated.

## Run

```sh
cd examples/react-pwa
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173/` by default.

## Component tree (locked shape — M2-M5 assert against this)

```
<App>                                       # displayName: 'App'
  <Counter initial={0} step={1} />          # useState(0)
  <TodoList />                              # useReducer over Todo[]; 2 initial items
  <UserProfile name="Alice" role="admin" /> # role="region" aria-label="user profile"
  <NestedSection>                           # parent
    <DeepChild />                           # leaf
  </NestedSection>
</App>
```

## Markers (for findByText testing)

| Marker | Component |
|--------|-----------|
| `counter-marker: <n>` | Counter (the `<n>` is current state) |
| `todo-marker-A` | TodoList (first initial item) |
| `todo-marker-B` | TodoList (second initial item, starts done) |
| `user-profile-marker` | UserProfile heading |
| `deep-child-marker` | DeepChild |

## ARIA roles (for findByRole testing)

| Role | Name | Component |
|------|------|-----------|
| `region` | `user profile` | UserProfile |
| `heading` | (heading text) | implicit on `<h1>`/`<h2>` tags |
| `button` | (button text) | implicit on `<button>` tags |

## Store fixtures (Path 4 — `store_*` tools)

Two JS stores are mounted and handed off on `window` for the unified
`store_*` tools (auto-detect framework, or pass `framework`):

| Framework | Handoff (`window.*`) | Hook/store | Component | Value marker |
|-----------|----------------------|------------|-----------|--------------|
| `redux`   | `__pwaDebug_redux`   | `store` (`store.ts`) | `<ReduxCounter>` (`aria-label="redux-counter"`) | `data-testid="redux-counter-value"` |
| `zustand` | `__pwaDebug_zustand` | `useZustandStore` (`zustandStore.ts`) | `<ZustandCounter>` (`aria-label="zustand-counter"`) | `data-testid="zustand-counter-value"` |
| `jotai`   | `__pwaDebug_jotai` (`{ store, atoms }`) | `jotaiStore` + `countAtom`/`todosAtom` (`jotaiStore.ts`) | `<JotaiCounter>` (`aria-label="jotai-counter"`) | `data-testid="jotai-counter-value"` |

All three stores share a parallel shape — a `count`/`counter.value` number plus
a todos list — so assertions stay symmetric across frameworks.

**Jotai specifics (M5):** Jotai has no addressable state tree, so the handoff
is the wrapped `{ store, atoms }` shape (the `createStore()` instance + a
name→atom registry). The adapter projects it into a **name-keyed snapshot**
(`state.count`, `state.todos`), and `store_dispatch` sets an atom by name:
`{ type: 'count', payload: 9 }` → `store.set(countAtom, 9)`.

**Zustand specifics (M3):**
- `useZustandStore` (from `create()`) also exposes `getState`/`setState`/`subscribe`,
  so it doubles as the vanilla store the adapter duck-types.
- In-store actions: `increment`, `decrement`, `addBy(n)`, `reset`, `addTodo(text)`, `removeTodo(id)`.
- `store_dispatch` against Zustand: `{ type: 'increment' }` invokes the named
  in-store action; `{ type: 'setState', payload: { count: 9 } }` merges a partial.
- Detection is via the explicit `__pwaDebug_zustand` handoff only — there is no
  Zustand devtools auto-capture shim yet (deferred; Zustand devtools use
  `__REDUX_DEVTOOLS_EXTENSION__.connect()`, not the enhancer pattern our Redux
  shim intercepts).

## Constraints baked into the fixture

- **No `React.StrictMode`** — its double-render confuses fiber walking.
- **No `Suspense` / `lazy` components** — out of scope for the v1 introspection.
- **Every component sets `.displayName` explicitly** — fiber type → string mapping is unambiguous.
- **TodoList uses `key={todo.id}`** — sibling reorder testing needs stable keys.
