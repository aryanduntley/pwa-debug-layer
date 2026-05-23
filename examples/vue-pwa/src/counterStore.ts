import { defineStore } from 'pinia';

export type Todo = { id: number; text: string; done: boolean };

// Parallel shape to the React fixture's redux/zustand/jotai stores: a `count`
// number plus a `todos` list, so store_* assertions stay symmetric across
// frameworks. Actions mirror the Zustand fixture's set so store_dispatch can
// be exercised the same way.
export const useCounterStore = defineStore('counter', {
  state: () => ({
    count: 0,
    todos: [
      { id: 1, text: 'pinia-todo-A', done: false },
      { id: 2, text: 'pinia-todo-B', done: true },
    ] as Todo[],
  }),
  actions: {
    increment(): void {
      this.count += 1;
    },
    decrement(): void {
      this.count -= 1;
    },
    addBy(n: number): void {
      this.count += n;
    },
    reset(): void {
      this.count = 0;
    },
    addTodo(text: string): void {
      const nextId = Math.max(0, ...this.todos.map((t) => t.id)) + 1;
      this.todos.push({ id: nextId, text, done: false });
    },
    removeTodo(id: number): void {
      this.todos = this.todos.filter((t) => t.id !== id);
    },
  },
});
