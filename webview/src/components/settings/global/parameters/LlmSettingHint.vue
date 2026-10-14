<script setup lang="ts">
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
defineProps<{ text: string; details?: string }>();
</script>

<template>
  <span class="llm-setting-hint">
    <span>{{ text }}</span>
    <HoverTooltipPanel v-if="details" :panel-title="text" :rows="[{ label: '说明', value: details }]">
      <button type="button" class="hint-button" :aria-label="`${text}：说明`">?</button>
    </HoverTooltipPanel>
  </span>
</template>

<style scoped>
.llm-setting-hint { display: inline-flex; align-items: baseline; gap: 6px; color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); line-height: 1.45; }
.hint-button { padding: 0 4px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); background: transparent; color: inherit; font: inherit; cursor: help; }
.hint-button:hover, .hint-button:focus-visible { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); outline: 1px solid var(--vscode-panel-border); }
</style>
