<script lang="ts">
  let {
    onLoad,
    onAlwaysLoad,
    onDismiss,
  }: { onLoad: () => void; onAlwaysLoad: () => void; onDismiss: () => void } = $props();
</script>

<div class="notice remote-images" role="status">
  <span class="text">This document has remote images. They were blocked to protect your privacy.</span>
  <button type="button" class="action" onclick={onLoad}>Load images</button>
  <button type="button" class="action" onclick={onAlwaysLoad}>Always load</button>
  <button type="button" class="close" aria-label="Keep images blocked" title="Keep images blocked" onclick={onDismiss}>
    ×
  </button>
</div>

<style>
  .remote-images {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  button {
    flex: none;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    cursor: pointer;
  }

  .action {
    color: var(--accent);
  }

  .close {
    color: var(--muted-strong);
    font-size: 14px;
    line-height: 1;
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
</style>
