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

## Constraints baked into the fixture

- **No `React.StrictMode`** — its double-render confuses fiber walking.
- **No `Suspense` / `lazy` components** — out of scope for the v1 introspection.
- **Every component sets `.displayName` explicitly** — fiber type → string mapping is unambiguous.
- **TodoList uses `key={todo.id}`** — sibling reorder testing needs stable keys.
