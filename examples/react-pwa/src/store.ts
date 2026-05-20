import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';

type CounterState = { readonly value: number };
const counterInitial: CounterState = { value: 0 };

const counterSlice = createSlice({
  name: 'counter',
  initialState: counterInitial,
  reducers: {
    increment: (state) => {
      state.value += 1;
    },
    decrement: (state) => {
      state.value -= 1;
    },
    reset: (state) => {
      state.value = 0;
    },
    addBy: (state, action: PayloadAction<number>) => {
      state.value += action.payload;
    },
  },
});

type Todo = { readonly id: number; readonly text: string };
type TodosState = { readonly items: readonly Todo[] };
const todosInitial: TodosState = { items: [] };

const todosSlice = createSlice({
  name: 'todos',
  initialState: todosInitial,
  reducers: {
    add: (state, action: PayloadAction<string>) => {
      const id = state.items.length
        ? Math.max(...state.items.map((t) => t.id)) + 1
        : 1;
      state.items.push({ id, text: action.payload });
    },
    remove: (state, action: PayloadAction<number>) => {
      state.items = state.items.filter((t) => t.id !== action.payload);
    },
    clear: (state) => {
      state.items = [];
    },
  },
});

export const counterActions = counterSlice.actions;
export const todosActions = todosSlice.actions;

export const store = configureStore({
  reducer: {
    counter: counterSlice.reducer,
    todos: todosSlice.reducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
