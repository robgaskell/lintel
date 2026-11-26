<script lang="ts">
  import Editor from '../editor/Editor.svelte';
  import type { DocState } from '../docs/store.svelte';

  let { doc }: { doc: DocState } = $props();
</script>

<div class="doc-pane" data-doc-pane={doc.id}>
  <Editor {doc} onChange={(text) => (doc.text = text)} />
</div>

<style>
  .doc-pane {
    height: 100%;
    background: var(--editor-bg);
  }
</style>
