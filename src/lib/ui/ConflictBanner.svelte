<script lang="ts">
  let { fileName, onKeep, onLoad }: { fileName: string; onKeep: () => void; onLoad: () => void } =
    $props();
</script>

<div class="conflict" role="alert">
  <span class="message"><strong>{fileName} changed on disk</strong> while you have unsaved edits.</span>
  <!-- One row, so a later "Compare" button can join it (spec: room for a diff view). -->
  <span class="actions">
    <button type="button" class="keep" onclick={onKeep}>Keep my edits</button>
    <button type="button" class="load" onclick={onLoad}>Load disk version</button>
  </span>
</div>

<style>
  /* The Reload artboard's amber, mixed from the theme so it holds in dark mode too. */
  .conflict {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    background: color-mix(in srgb, var(--lint-warning) 12%, var(--bg));
    border-bottom: 1px solid color-mix(in srgb, var(--lint-warning) 45%, var(--bg));
    color: var(--text);
    font-size: 13px;
  }

  /* The buttons stay on one line; a narrow pane wraps the message instead (Ruling 265). */
  .message {
    flex: 1 1 auto;
    min-width: 0;
  }

  .actions {
    display: flex;
    flex: none;
    flex-wrap: nowrap;
    gap: 8px;
  }

  button {
    white-space: nowrap;
    height: 30px;
    padding: 0 12px;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }

  .keep {
    border: 1px solid color-mix(in srgb, var(--lint-warning) 55%, var(--bg));
    background: var(--bg);
    color: var(--text);
  }

  .load {
    border: 0;
    background: var(--accent);
    color: var(--bg);
    font-weight: 600;
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
