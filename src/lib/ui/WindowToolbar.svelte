<script lang="ts">
  import { runHistory, type MenuHandlers } from '../os/menu';
  import { isMac } from '../os/platform';

  let {
    handlers,
    canSplit,
    outlineVisible,
  }: { handlers: MenuHandlers; canSplit: boolean; outlineVisible: boolean } = $props();

  // A shortcut only where the menu item has one (Ruling 1).
  const mod = isMac() ? 'Cmd' : 'Ctrl';
  const tip = (name: string, keys?: string) => (keys ? `${name} (${keys})` : name);

  // As in the formatting bar: focus stays in the editor or find field, so Undo acts there.
  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }
</script>

<div class="window-toolbar" role="toolbar" aria-label="Window toolbar">
  <button type="button" aria-label="New" title={tip('New', `${mod}+N`)} onmousedown={keepFocus} onclick={() => handlers.newDoc()}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"></path><path d="M14 3v5h5M12 11v6M9 14h6"></path></svg>
  </button>
  <button type="button" aria-label="Open" title={tip('Open', `${mod}+O`)} onmousedown={keepFocus} onclick={() => handlers.open()}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"></path></svg>
  </button>
  <button type="button" aria-label="Save" title={tip('Save', `${mod}+S`)} onmousedown={keepFocus} onclick={() => handlers.save()}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"></path><path d="M7 3v5h8M7 21v-7h10v7"></path></svg>
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button type="button" aria-label="Undo" title={tip('Undo', `${mod}+Z`)} onmousedown={keepFocus} onclick={() => void runHistory('undo')}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"></path><path d="M4 9h11a5 5 0 0 1 0 10h-3"></path></svg>
  </button>
  <button type="button" aria-label="Redo" title={tip('Redo', `Shift+${mod}+Z`)} onmousedown={keepFocus} onclick={() => void runHistory('redo')}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"></path><path d="M20 9H9a5 5 0 0 0 0 10h3"></path></svg>
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button type="button" aria-label="Split Right" title={tip('Split Right', `${mod}+\\`)} disabled={!canSplit} onmousedown={keepFocus} onclick={() => handlers.split('right')}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"></rect><path d="M12 4v16"></path></svg>
  </button>
  <button type="button" aria-label="Split Down" title={tip('Split Down')} disabled={!canSplit} onmousedown={keepFocus} onclick={() => handlers.split('below')}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"></rect><path d="M3 12h18"></path></svg>
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button type="button" aria-label="Outline" title={tip('Outline')} aria-pressed={outlineVisible} onmousedown={keepFocus} onclick={() => handlers.toggleOutline()}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M8 12h12M12 18h8"></path></svg>
  </button>
</div>

<style>
  /* Sizes, spacing, hover and focus copy the formatting bar in Toolbar.svelte (spec F2 exception). */
  .window-toolbar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    flex-wrap: wrap;
    padding: 6px 12px;
    background: var(--chrome);
    border-bottom: 1px solid var(--toolbar-border);
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--toolbar-icon);
    font: inherit;
  }

  button:hover:not(:disabled) {
    background: var(--toolbar-hover);
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Ruling 6: the formatting bar has no disabled or pressed state to copy. */
  button:disabled {
    opacity: 0.4;
  }

  button[aria-pressed='true'] {
    background: var(--hover);
    color: var(--accent);
  }

  .divider {
    width: 1px;
    height: 18px;
    margin: 0 6px;
    background: var(--toolbar-divider);
  }
</style>
