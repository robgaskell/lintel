<script lang="ts">
  import { isDirty, type DocState } from '../docs/store.svelte';

  let { doc, onClose }: { doc: DocState; onClose: () => void } = $props();

  const dirty = $derived(isDirty(doc));
</script>

<div class="lintel-tab" class:is-dirty={dirty} data-doc-id={doc.id} title={doc.path ?? doc.title}>
  {#if doc.pinned}
    <svg class="pin" aria-label="Pinned" role="img" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 17v5" /><path d="M9 10.76V6h6v4.76l2 3.24H7z" /><path d="M8 3h8" />
    </svg>
  {/if}
  <span class="name">{doc.title}</span>
  {#if dirty}
    <span class="dirty" role="img" aria-label="Unsaved changes"></span>
  {/if}
  {#if !doc.pinned}
    <!-- Stop pointerdown so dockview neither starts a drag nor activates the tab being closed,
         and click so the tab's own select action never sees a close (Ruling 168). -->
    <button
      class="close"
      type="button"
      aria-label="Close {doc.title}"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  {/if}
</div>

<style>
  .lintel-tab {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
    white-space: nowrap;
  }

  .pin {
    flex-shrink: 0;
  }

  .dirty,
  .close {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
  }

  .dirty {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .dirty::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted-strong);
  }

  .close {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--tab-close);
    cursor: pointer;
  }

  .close:hover {
    background: var(--tab-close-hover-bg);
    color: var(--text);
  }

  /* A dirty tab shows the dot in the close button's place until hovered. */
  .is-dirty .close {
    display: none;
  }

  .is-dirty:hover .dirty {
    display: none;
  }

  .is-dirty:hover .close,
  .is-dirty:focus-within .close {
    display: flex;
  }
</style>
