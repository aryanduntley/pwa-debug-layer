<script setup lang="ts">
import { ref } from 'vue';

defineOptions({ name: 'Counter' });

const props = defineProps<{ initial: number; step: number }>();
const count = ref(props.initial);
</script>

<template>
  <section>
    <p>counter-marker: {{ count }}</p>
    <button type="button" @click="count -= props.step">-</button>
    <button type="button" @click="count += props.step">+</button>
  </section>
</template>
