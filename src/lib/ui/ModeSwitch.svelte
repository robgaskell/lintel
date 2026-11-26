<script lang="ts">
  import type { ViewMode } from '../docs/store.svelte';
  import { isMac } from '../os/platform';

  let { mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void } = $props();

  const modes: { value: ViewMode; label: string; key: string }[] = [
    { value: 'edit', label: 'Edit', key: '1' },
    { value: 'split', label: 'Split', key: '2' },
    { value: 'read', label: 'Read', key: '3' },
  ];
  const mod = isMac() ? '⌘' : 'Ctrl+';
</script>

<div class="mode-switch" role="group" aria-label="View mode">
  {#each modes as m (m.value)}
    <button
      type="button"
      aria-pressed={mode === m.value}
      title={`${m.label} (${mod}${m.key})`}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onChange(m.value)}>{m.label}</button
    >
  {/each}
</div>

<style>
  .mode-switch {
    display: flex;
    padding: 2px;
    background: var(--mode-bg);
    border-radius: 8px;
  }

  button {
    height: 28px;
    padding: 0 12px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    font: inherit;
    color: var(--mode-text);
  }

  button[aria-pressed='true'] {
    background: var(--mode-selected-bg);
    font-weight: 600;
    color: var(--accent);
    box-shadow: var(--mode-selected-shadow);
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
</style>
