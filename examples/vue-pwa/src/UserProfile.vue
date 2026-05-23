<script setup lang="ts">
defineOptions({ name: 'UserProfile' });

defineProps<{ name: string; role: string }>();
</script>

<template>
  <section role="region" aria-label="user profile">
    <h2>user-profile-marker</h2>
    <p>name: {{ name }}</p>
    <p>role: {{ role }}</p>
  </section>
</template>
