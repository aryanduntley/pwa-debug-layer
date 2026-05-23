<script setup lang="ts">
import DeepChild from './DeepChild.vue';

defineOptions({ name: 'NestedSection' });
</script>

<template>
  <section>
    <h2>nested-section</h2>
    <DeepChild />
  </section>
</template>
