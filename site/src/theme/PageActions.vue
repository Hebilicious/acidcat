<script setup lang="ts">
defineProps<{ editUrl: string | undefined; issueUrl: string }>();
</script>

<template>
  <div class="page-actions">
    <a v-if="editUrl" :href="editUrl" target="_blank" rel="noopener noreferrer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
      Edit page
    </a>
    <a :href="issueUrl" target="_blank" rel="noopener noreferrer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></svg>
      Report issue
    </a>
  </div>
</template>
