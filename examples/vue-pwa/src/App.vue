<script setup lang="ts">
import Counter from './Counter.vue';
import TodoList from './TodoList.vue';
import UserProfile from './UserProfile.vue';
import NestedSection from './NestedSection.vue';
import PiniaCounter from './PiniaCounter.vue';

defineOptions({ name: 'App' });
</script>

<template>
  <div class="app">
    <h1>pwa-debug Vue fixture</h1>
    <Counter :initial="0" :step="1" />
    <TodoList />
    <UserProfile name="Alice" role="admin" />
    <NestedSection />
    <PiniaCounter />
  </div>
</template>
