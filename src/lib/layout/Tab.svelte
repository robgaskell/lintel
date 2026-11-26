<script lang="ts">
  import { isDirty, type DocState } from '../docs/store.svelte';

  let { doc, onClose }: { doc: DocState; onClose: () => void } = $props();

  const dirty = $derived(isDirty(doc));

  // Set while the pointer is down on the close mark, so only a real press closes.
  let armed = false;
  let closedByPointer = false;
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
    <!-- Not a button: WebKit sends an accessibility press on the tab to a native control
         inside it, which closed the tab. Hidden from assistive tech and closed by pointer only;
         Cmd+W, Delete and the tab menu close it from the keyboard (Rulings 135, 171).
         Stopping pointerdown keeps dockview from dragging or activating the tab. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <span
      class="close"
      aria-hidden="true"
      onpointerdown={(e) => {
        e.stopPropagation();
        armed = e.button === 0;
      }}
      onpointerleave={() => (armed = false)}
      onpointerup={() => {
        if (!armed) return;
        armed = false;
        closedByPointer = true;
        onClose();
      }}
      onclick={(e) => {
        // A click with no press (an accessibility press) goes on to select the tab.
        if (!closedByPointer) return;
        closedByPointer = false;
        e.stopPropagation();
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </span>
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
    border-radius: 4px;
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

  .is-dirty:hover .close {
    display: flex;
  }
</style>
