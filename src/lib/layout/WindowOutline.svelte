<script lang="ts">
  import Outline from '../ui/Outline.svelte';
  import { outline, outlineSources } from './outline.svelte';

  // One outline per window, for the active doc in whichever group it is (Ruling 181).
  let { docId }: { docId: string | null } = $props();

  const source = $derived(docId === null ? undefined : outlineSources.get(docId));

  // The outline sits in another group's pane: a press here must not make that group
  // active, or the outline would switch to its doc before the click (Ruling 195).
  function keepGroup(event: Event) {
    event.stopPropagation();
    // Cancelling the mousedown keeps focus, and so the active group, where it was.
    if (event.type === 'mousedown' && event.target instanceof Element && event.target.closest('a')) {
      event.preventDefault();
    }
  }

  // Svelte delegates onpointerdown and onmousedown to the root, too late to stop them here.
  function guard(box: HTMLElement) {
    box.addEventListener('pointerdown', keepGroup);
    box.addEventListener('mousedown', keepGroup);
    return () => {
      box.removeEventListener('pointerdown', keepGroup);
      box.removeEventListener('mousedown', keepGroup);
    };
  }
</script>

{#if outline.visible && source}
  <div class="window-outline" {@attach guard}>
    {#key docId}
      <Outline headings={source.headings} activeLine={source.activeLine} onPick={(h) => source.pick(h)} />
    {/key}
  </div>
{/if}

<style>
  .window-outline {
    display: contents;
  }
</style>
