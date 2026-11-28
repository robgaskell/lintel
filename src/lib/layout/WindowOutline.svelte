<script lang="ts">
  import { tick } from 'svelte';
  import Outline from '../ui/Outline.svelte';
  import {
    outline,
    outlineSources,
    resetOutlineWidth,
    setOutlineWidth,
    shownOutlineWidth,
  } from './outline.svelte';

  // One outline per window, for the active doc in whichever group it is (Ruling 181).
  let { docId }: { docId: string | null } = $props();

  const source = $derived(docId === null ? undefined : outlineSources.get(docId));
  let windowWidth = $state(window.innerWidth);
  const width = $derived(shownOutlineWidth(outline.width, windowWidth));
  let column = $state<HTMLElement>();
  let dragging = $state(false);

  // A click keeps focus where it was, as in the window toolbar. When focus was in the
  // column (a keyboard press), it moves to the button that replaces the one pressed.
  async function setCollapsed(collapsed: boolean) {
    const focusInColumn = column?.contains(document.activeElement) ?? false;
    outline.collapsed = collapsed;
    if (!focusInColumn) return;
    await tick();
    const next = collapsed ? 'Expand Outline' : 'Collapse Outline';
    column?.querySelector<HTMLElement>(`button[aria-label="${next}"]`)?.focus();
  }

  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }

  // As dockview's sashes: listeners on the document, not pointer capture, which jsdom lacks.
  function resizable(edge: HTMLElement) {
    const page = edge.ownerDocument;
    const win = page.defaultView ?? window;
    let stop = () => {};

    function start(event: PointerEvent) {
      if (event.button !== 0) return;
      // No text selection starts under the drag.
      event.preventDefault();
      stop();
      const startX = event.clientX;
      const startWidth = width;
      // What the drag shows is what is saved, so a narrow window caps it too.
      const move = (e: PointerEvent) => {
        // No button held: the pointerup went to another window.
        if (e.buttons === 0) end();
        else setOutlineWidth(shownOutlineWidth(startWidth + e.clientX - startX, windowWidth));
      };
      const end = () => {
        page.removeEventListener('pointermove', move);
        page.removeEventListener('pointerup', end);
        page.removeEventListener('pointercancel', end);
        page.removeEventListener('contextmenu', end);
        win.removeEventListener('blur', end);
        page.body.classList.remove('outline-resizing');
        dragging = false;
        stop = () => {};
      };
      stop = end;
      page.addEventListener('pointermove', move);
      page.addEventListener('pointerup', end);
      page.addEventListener('pointercancel', end);
      page.addEventListener('contextmenu', end);
      win.addEventListener('blur', end);
      page.body.classList.add('outline-resizing');
      dragging = true;
    }

    edge.addEventListener('pointerdown', start);
    edge.addEventListener('dblclick', resetOutlineWidth);
    return () => {
      edge.removeEventListener('pointerdown', start);
      edge.removeEventListener('dblclick', resetOutlineWidth);
      stop();
    };
  }
</script>

<svelte:window bind:innerWidth={windowWidth} />

{#if outline.visible && source}
  <div
    class="outline-column"
    class:collapsed={outline.collapsed}
    style:width={outline.collapsed ? null : `${width}px`}
    bind:this={column}
  >
    {#if outline.collapsed}
      <button
        type="button"
        class="expand"
        aria-label="Expand Outline"
        title="Expand Outline"
        onmousedown={keepFocus}
        onclick={() => setCollapsed(false)}
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 17l5-5-5-5M6 17l5-5-5-5"></path></svg>
      </button>
    {:else}
      {#key docId}
        <Outline
          headings={source.headings}
          activeLine={source.activeLine}
          onPick={(h) => source.pick(h)}
          onCollapse={() => setCollapsed(true)}
        />
      {/key}
      <div
        class="edge"
        class:dragging
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Outline"
        {@attach resizable}
      ></div>
    {/if}
  </div>
{/if}

<style>
  .outline-column {
    position: relative;
    display: flex;
    flex: none;
    min-height: 0;
  }

  /* The rail: the column at 28 px with one button (spec F2 exception). */
  .collapsed {
    flex-direction: column;
    align-items: center;
    box-sizing: border-box;
    width: 28px;
    padding-top: 9px;
    background: var(--outline-bg);
    border-right: 1px solid var(--toolbar-border);
  }

  .expand {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--toolbar-icon);
  }

  .expand:hover {
    background: var(--toolbar-hover);
  }

  .expand:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Sized, placed and lit like dockview's sashes between groups. */
  .edge {
    position: absolute;
    top: 0;
    right: -2px;
    bottom: 0;
    z-index: 99;
    width: 4px;
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .edge:hover,
  .edge.dragging {
    background-color: var(--accent);
    transition: background-color 0.1s ease-in-out 0.5s;
  }

  .edge.dragging {
    transition-delay: 0s;
  }

  /* While dragging, the page shows the resize arrow and selects no text. */
  :global(body.outline-resizing) {
    cursor: ew-resize;
    user-select: none;
    -webkit-user-select: none;
  }

  /* Nothing under the pointer takes hover or sets its own cursor, as dockview turns off
     pointer events on its views during a sash drag. */
  :global(body.outline-resizing *) {
    pointer-events: none;
  }
</style>
