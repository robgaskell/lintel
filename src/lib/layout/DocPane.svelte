<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import Editor from '../editor/Editor.svelte';
  import Toolbar from '../ui/Toolbar.svelte';
  import { attachEditorContextMenu } from '../editor/contextMenu';
  import { registerView } from '../editor/views';
  import type { DocState } from '../docs/store.svelte';

  let { doc }: { doc: DocState } = $props();

  const cleanups: (() => void)[] = [];

  function onReady(view: EditorView) {
    cleanups.push(registerView(doc.id, view), attachEditorContextMenu(view));
  }

  onDestroy(() => {
    for (const cleanup of cleanups) cleanup();
  });
</script>

<div class="doc-pane" data-doc-pane={doc.id}>
  <Toolbar docId={doc.id} />
  <div class="editor-host">
    <Editor {doc} onChange={(text) => (doc.text = text)} {onReady} />
  </div>
</div>

<style>
  .doc-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--editor-bg);
  }

  .editor-host {
    flex: 1;
    min-height: 0;
  }
</style>
