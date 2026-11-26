<script lang="ts">
  import type { Heading } from '../render/markdown';

  let {
    headings,
    activeLine,
    onPick,
  }: { headings: Heading[]; activeLine: number; onPick: (h: Heading) => void } = $props();

  // The last heading at or above the line in view; binary search, as this runs per scroll.
  const active = $derived.by(() => {
    let lo = 0;
    let hi = headings.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (headings[mid]!.line <= activeLine) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  });

  function pick(event: MouseEvent, heading: Heading) {
    event.preventDefault();
    onPick(heading);
  }
</script>

<nav class="outline" aria-label="Outline">
  <div class="label">Outline</div>
  {#if headings.length === 0}
    <p class="empty">No headings</p>
  {:else}
    <div class="rows">
      {#each headings as heading, i (heading.id)}
        <a
          href="#{heading.id}"
          class="row level-{heading.level}"
          class:active={i === active}
          aria-current={i === active ? 'true' : undefined}
          title={heading.text}
          style:padding-left="{8 + 12 * (heading.level - 1)}px"
          onclick={(event) => pick(event, heading)}>{heading.text}</a
        >
      {/each}
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

  .empty {
    margin: 0;
    padding: 0 8px;
    color: var(--outline-label);
  }
</style>
