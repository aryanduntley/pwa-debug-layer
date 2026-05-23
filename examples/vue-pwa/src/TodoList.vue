<script setup lang="ts">
import { reactive } from 'vue';

defineOptions({ name: 'TodoList' });

type Todo = { id: number; text: string; done: boolean };

const todos = reactive<Todo[]>([
  { id: 1, text: 'todo-marker-A', done: false },
  { id: 2, text: 'todo-marker-B', done: true },
]);

const toggle = (id: number): void => {
  const t = todos.find((x) => x.id === id);
  if (t) t.done = !t.done;
};
const remove = (id: number): void => {
  const i = todos.findIndex((x) => x.id === id);
  if (i >= 0) todos.splice(i, 1);
};
const add = (): void => {
  const nextId = Math.max(0, ...todos.map((t) => t.id)) + 1;
  todos.push({ id: nextId, text: 'new-todo', done: false });
};
</script>

<template>
  <section>
    <h2>todos</h2>
    <ul>
      <li v-for="todo in todos" :key="todo.id">
        <label>
          <input type="checkbox" :checked="todo.done" @change="toggle(todo.id)" />
          {{ todo.text }}
        </label>
        <button type="button" @click="remove(todo.id)">x</button>
      </li>
    </ul>
    <button type="button" @click="add">add</button>
  </section>
</template>
