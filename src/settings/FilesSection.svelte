<script lang="ts">
  import { settings, updateSettings } from '../lib/settings/settings.svelte';
  import { showError } from './showError';

  const MAX_RECENT = 20;

  let draft = $state(String(settings.recentLimit));
  $effect(() => {
    draft = String(settings.recentLimit);
  });

  // Saved on blur or Enter, so typing 15 does not first rebuild the menu for 1 (Ruling 143).
  function commit() {
    const typed = draft.trim() === '' ? NaN : Number(draft);
    if (!Number.isFinite(typed)) {
      draft = String(settings.recentLimit);
      return;
    }
    const limit = Math.min(MAX_RECENT, Math.max(0, Math.round(typed)));
    draft = String(limit);
    if (limit !== settings.recentLimit) updateSettings({ recentLimit: limit }).catch(showError);
  }
</script>

<div class="field">
  <label class="field-label" for="recent-limit">Recent files to show</label>
  <input
    id="recent-limit"
    class="count"
    type="number"
    min="0"
    max={MAX_RECENT}
    step="1"
    value={draft}
    aria-describedby="recent-limit-hint"
    oninput={(e) => (draft = e.currentTarget.value)}
    onblur={commit}
    onkeydown={(e) => e.key === 'Enter' && commit()}
  />
  <span class="hint" id="recent-limit-hint">0 hides File &gt; Open Recent.</span>
</div>

<div class="field">
  <div class="action-row">
    <span>Open Markdown files in Lintel from a terminal</span>
    <button type="button" class="choice" disabled>Install command-line tool</button>
  </div>
  <div class="action-row">
    <span>Open .md and .markdown files in Lintel by default</span>
    <button type="button" class="choice" disabled>Make Lintel the default</button>
  </div>
  <span class="hint">These arrive in a later version.</span>
</div>

<style>
  .count {
    width: 80px;
  }

  .action-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
</style>
