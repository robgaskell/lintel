<script lang="ts" module>
  import type { Heading } from '../render/markdown';

  const MAX_ROWS = 5000;

  // Only `active` and `tabStop` are reactive, so a scroll redraws two rows (Ruling 119).
  class Row {
    active = $state(false);
    tabStop = $state(false);

    // Swapped without a redraw for an equal heading whose line moved.
    heading: Heading;

    constructor(heading: Heading) {
      this.heading = heading;
    }
  }

  function sameLabel(a: Heading, b: Heading): boolean {
    return a === b || (a.id === b.id && a.text === b.text && a.level === b.level);
  }
</script>

<script lang="ts">
  let {
    headings,
    activeLine,
    onPick,
  }: { headings: Heading[]; activeLine: number; onPick: (h: Heading) => void } = $props();

  let list: HTMLDivElement | undefined = $state();

  // Rows whose heading kept its id, text and level are reused, so a re-extract redraws nothing.
  let previous = new Map<string, Row>();
  const rows = $derived.by(() => {
    const next = new Map<string, Row>();
    const made = headings.slice(0, MAX_ROWS).map((heading) => {
      const old = previous.get(heading.id);
      const row = old && sameLabel(old.heading, heading) ? old : new Row(heading);
      row.heading = heading;
      next.set(heading.id, row);
      return row;
    });
    previous = next;
    return made;
  });

  // The last heading at or above the line in view; binary search, as this runs per scroll.
  const activeIndex = $derived.by(() => {
    let lo = 0;
    let hi = headings.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (headings[mid]!.line <= activeLine) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  });

  let lit: Row | null = null;
  let stop: Row | null = null;
  $effect(() => {
    const row = rows[activeIndex] ?? null;
    if (lit !== row) {
      if (lit) lit.active = false;
      if (row) row.active = true;
      lit = row;
    }
    // The tab stop follows the current heading unless the user is moving through the list.
    if (!list?.contains(document.activeElement)) moveStop(row ?? rows[0] ?? null);
  });

  function moveStop(row: Row | null) {
    if (stop === row) return;
    if (stop) stop.tabStop = false;
    if (row) row.tabStop = true;
    stop = row;
  }

  function onClick(event: MouseEvent, row: Row) {
    event.preventDefault();
    // Like the preview's links, a modified click does nothing (Ruling 122).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    onPick(row.heading);
  }

  // One tab stop for the whole list; arrows, Home and End move it (Ruling 122).
  function onKeydown(event: KeyboardEvent) {
    const link = event.target as HTMLElement;
    const index = Number(link.dataset.index);
    const row = rows[index];
    if (!row) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onPick(row.heading);
      return;
    }
    const target =
      event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowUp' ? index - 1
      : event.key === 'Home' ? 0
      : event.key === 'End' ? rows.length - 1
      : null;
    if (target === null) return;
    event.preventDefault();
    const next = Math.min(Math.max(target, 0), rows.length - 1);
    moveStop(rows[next] ?? null);
    list?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  }
</script>

<nav class="outline" aria-label="Outline">
  <div class="label">Outline</div>
  {#if headings.length === 0}
    <p class="empty">No headings</p>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="rows" bind:this={list} onkeydown={onKeydown}>
      {#each rows as row, i (row.heading.id)}
        {@const { id, text, level } = row.heading}
        <a
          href="#{id}"
          class="row level-{level}"
          class:active={row.active}
          aria-current={row.active ? 'true' : undefined}
          tabindex={row.tabStop ? 0 : -1}
          data-index={i}
          title={text}
          style:padding-left="{8 + 12 * (level - 1)}px"
          onclick={(event) => onClick(event, row)}
          onauxclick={(event) => event.preventDefault()}>{text}</a
        >
      {/each}
      {#if headings.length > MAX_ROWS}
        <p class="more">… {headings.length - MAX_ROWS} more headings</p>
      {/if}
    </div>
  {/if}
</nav>

<style>
  .outline {
    flex: 0 0 210px;
    box-sizing: border-box;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 10px;
    background: var(--outline-bg);
    border-right: 1px solid var(--toolbar-border);
  }

  .label {
    padding: 0 8px 8px;
    color: var(--outline-label);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row {
    display: block;
    padding: 6px 8px;
    border-radius: 6px;
    overflow: hidden;
    color: var(--outline-text-3);
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .level-1 {
    color: var(--text);
    font-weight: 600;
  }

  .level-2 {
    color: var(--outline-text-2);
  }

  .row:hover {
    background: var(--toolbar-hover);
  }

  .row.active {
    background: var(--outline-active);
    color: var(--text);
  }

  .row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .empty,
  .more {
    margin: 0;
    padding: 6px 8px;
    color: var(--outline-label);
  }

  .empty {
    padding-top: 0;
  }
</style>
