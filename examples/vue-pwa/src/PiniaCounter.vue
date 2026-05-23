<script setup lang="ts">
import { useCounterStore } from './counterStore';

defineOptions({ name: 'PiniaCounter' });

const store = useCounterStore();
</script>

<template>
  <section role="region" aria-label="pinia-counter">
    <h2>pinia-counter-marker</h2>
    <p data-testid="pinia-counter-value">count: {{ store.count }}</p>
    <button type="button" @click="store.decrement()">-</button>
    <button type="button" @click="store.increment()">+</button>
    <ul>
      <li v-for="todo in store.todos" :key="todo.id">{{ todo.text }}</li>
    </ul>
  </section>
</template>
