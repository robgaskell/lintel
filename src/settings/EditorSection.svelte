<script lang="ts">
  import type { ViewMode } from '../lib/docs/store.svelte';
  import { settings } from '../lib/settings/settings.svelte';
  import { save } from './save.svelte';

  const modes: { id: ViewMode; label: string }[] = [
    { id: 'edit', label: 'Edit' },
    { id: 'split', label: 'Split' },
    { id: 'read', label: 'Read' },
  ];
</script>

<div class="field">
  <span class="field-label" id="default-mode-label">Default mode for new tabs</span>
  <div class="choices" role="group" aria-labelledby="default-mode-label">
    {#each modes as mode (mode.id)}
      <button
        type="button"
        class="choice"
        aria-pressed={settings.defaultMode === mode.id}
        onclick={() => save({ defaultMode: mode.id })}>{mode.label}</button
      >
    {/each}
  </div>
</div>
