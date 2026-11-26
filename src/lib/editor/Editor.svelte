<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorState } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import type { DocState } from '../docs/store.svelte';
  import { editorExtensions } from './setup';

  let {
    doc,
    onChange,
    onReady,
  }: {
    doc: DocState;
    onChange: (text: string) => void;
    onReady?: (view: EditorView) => void;
  } = $props();

  let host: HTMLDivElement;

  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: doc.text,
        extensions: editorExtensions((text) => onChange(text)),
      }),
    });
    onReady?.(view);
    return () => view.destroy();
  });
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    height: 100%;
    min-height: 0;
  }
</style>
