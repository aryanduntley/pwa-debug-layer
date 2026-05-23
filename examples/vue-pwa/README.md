# pwa-debug Vue fixture

Minimal Vue 3 + TypeScript + Pinia app used as the canonical test target for
the Vue introspection tools shipped under **Path 5** of pwa-debug-layer
(`vue_tree`, `vue_get_state`, `vue_find_by_text`, `vue_find_by_role`) and for
live-verifying the unified `store_*` tools with `framework: 'pinia'`.

It deliberately mirrors `examples/react-pwa` component-for-component and
marker-for-marker, so the Vue tools can be asserted against the same shape as
the React tools.

This is a **standalone npm project** — it lives outside the pnpm workspace so
its build/dependencies are isolated.

## Run

```sh
cd examples/vue-pwa
npm install
npm run dev
```

Vite serves the app at `http://localhost:5174/` by default (5173 is the React
fixture, so both can run at once).

## Component tree (locked shape — Path 5 M38–M40 assert against this)

```
<App>                                       # name: 'App'
  <Counter :initial="0" :step="1" />        # ref(0)
  <TodoList />                              # reactive Todo[]; 2 initial items
  <UserProfile name="Alice" role="admin" /> # role="region" aria-label="user profile"
  <NestedSection>                           # parent
    <DeepChild />                           # leaf
  </NestedSection>
  <PiniaCounter />                          # Pinia 'counter' store
</App>
```

## Markers (for `vue_find_by_text` testing)

| Marker | Component |
|--------|-----------|
| `counter-marker: <n>` | Counter (the `<n>` is current state) |
| `todo-marker-A` | TodoList (first initial item) |
| `todo-marker-B` | TodoList (second initial item, starts done) |
| `user-profile-marker` | UserProfile heading |
| `nested-section` | NestedSection heading |
| `deep-child-marker` | DeepChild |
| `pinia-counter-marker` | PiniaCounter heading |

## ARIA roles (for `vue_find_by_role` testing)

| Role | Name | Component |
|------|------|-----------|
| `region` | `user profile` | UserProfile |
| `region` | `pinia-counter` | PiniaCounter |
| `heading` | (heading text) | implicit on `<h1>`/`<h2>` tags |
| `button` | (button text) | implicit on `<button>` tags |

## Store fixture (Path 4 — `store_*` tools)

A single Pinia `counter` store is mounted and handed off on `window` for the
unified `store_*` tools (auto-detect framework, or pass `framework: 'pinia'`):

| Framework | Handoff (`window.*`) | Store | Component | Value marker |
|-----------|----------------------|-------|-----------|--------------|
| `pinia`   | `__pwaDebug_pinia`   | `useCounterStore` (`counterStore.ts`) | `<PiniaCounter>` (`aria-label="pinia-counter"`) | `data-testid="pinia-counter-value"` |

The store shape (`count` number + `todos` list) parallels the React fixture's
redux/zustand/jotai stores so assertions stay symmetric across frameworks.

**Pinia specifics:**
- The handoff is a single **store instance** exposing the `$state`/`$patch`/
  `$subscribe` surface the adapter duck-types (distinct from Redux `dispatch`
  and Zustand `setState`).
- In-store actions: `increment`, `decrement`, `addBy(n)`, `reset`,
  `addTodo(text)`, `removeTodo(id)`.
- `store_dispatch` against Pinia: `{ type: 'increment' }` invokes the named
  action; `{ type: '$patch', payload: { count: 9 } }` merges a partial.
- Detection is via the explicit `__pwaDebug_pinia` handoff only — Pinia
  auto-discovery (`getActivePinia()` / `__VUE_DEVTOOLS_GLOBAL_HOOK__`) is a
  Path 5 follow-on task in this milestone.

## Constraints baked into the fixture

- **Every component sets an explicit `name`** (via `defineOptions({ name })`) —
  component-type → string mapping stays unambiguous for the M38 stable-id work.
- **`v-for` uses `:key="todo.id"`** — sibling-reorder testing needs stable keys.
- **No async / `<Suspense>` components** — out of scope for the v1 introspection.
