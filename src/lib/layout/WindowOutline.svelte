<script lang="ts">
  import Outline from '../ui/Outline.svelte';
  import { outline, outlineSources } from './outline.svelte';

  // One outline per window, for the active doc in whichever group it is (Ruling 181).
  let { docId }: { docId: string | null } = $props();

  const source = $derived(docId === null ? undefined : outlineSources.get(docId));
</script>

{#if outline.visible && source}
  {#key docId}
    <Outline headings={source.headings} activeLine={source.activeLine} onPick={(h) => source.pick(h)} />
  {/key}
{/if}
