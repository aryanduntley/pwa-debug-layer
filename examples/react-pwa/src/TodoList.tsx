import { useReducer } from 'react';

type Todo = { readonly id: number; readonly text: string; readonly done: boolean };

type Action =
  | { readonly type: 'add'; readonly text: string }
  | { readonly type: 'toggle'; readonly id: number }
  | { readonly type: 'remove'; readonly id: number };

const INITIAL: readonly Todo[] = [
  { id: 1, text: 'todo-marker-A', done: false },
  { id: 2, text: 'todo-marker-B', done: true },
];

const reducer = (state: readonly Todo[], action: Action): readonly Todo[] => {
  switch (action.type) {
    case 'add':
      return [
        ...state,
        { id: Math.max(0, ...state.map((t) => t.id)) + 1, text: action.text, done: false },
      ];
    case 'toggle':
      return state.map((t) => (t.id === action.id ? { ...t, done: !t.done } : t));
    case 'remove':
      return state.filter((t) => t.id !== action.id);
    default:
      return state;
  }
};

export const TodoList = (): JSX.Element => {
  const [todos, dispatch] = useReducer(reducer, INITIAL);
  return (
    <section>
      <h2>todos</h2>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => dispatch({ type: 'toggle', id: todo.id })}
              />
              {todo.text}
            </label>
            <button
              type="button"
              onClick={() => dispatch({ type: 'remove', id: todo.id })}
            >
              x
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => dispatch({ type: 'add', text: 'new-todo' })}>
        add
      </button>
    </section>
  );
};

TodoList.displayName = 'TodoList';
