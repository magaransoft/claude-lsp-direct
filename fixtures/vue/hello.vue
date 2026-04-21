<script setup lang="ts">
import { ref, computed } from 'vue';

type Props = {
  name: string;
};

const props = defineProps<Props>();

const count = ref(0);
const greeting = computed(() => `hello, ${props.name} (${count.value})`);

function increment() {
  count.value += 1;
}
</script>

<template>
  <div class="greeter">
    <p>{{ greeting }}</p>
    <button @click="increment">+</button>
  </div>
</template>

<style scoped>
.greeter {
  padding: 1rem;
}
</style>
