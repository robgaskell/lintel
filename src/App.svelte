<script lang="ts">
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { ask, message, open } from '@tauri-apps/plugin-dialog';
  import Editor from './lib/editor/Editor.svelte';
  import {
    createDoc,
    docs,
    isDirty,
    saveDoc,
    saveDocAs,
    type DocState,
  } from './lib/docs/store.svelte';
  import { readTextFile } from './lib/ipc';

  // One document for now; tabs arrive in a later step.
  let doc: DocState = $state(createDoc({ path: null, raw: '', hash: '', mode: 'edit' }));

  async function openFile() {
    if (isDirty(doc) && !(await ask('Discard unsaved changes?', { title: 'Lintel', kind: 'warning' }))) {
      return;
    }
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (path === null) return;
    const result = await readTextFile(path);
    docs.delete(doc.id);
    doc = createDoc({ path, raw: result.text, hash: result.hash, mode: 'edit' });
  }

  async function runMenu(id: string) {
    try {
      if (id === 'open') await openFile();
      else if (id === 'save') await saveDoc(doc.id);
      else if (id === 'save-as') await saveDocAs(doc.id);
    } catch (err) {
      await message(String(err), { title: 'Lintel', kind: 'error' });
    }
  }

  onMount(() => {
    // Temporary File menu events from Rust; M1.3 replaces them.
    const unlisten = listen<string>('lintel://menu', (event) => runMenu(event.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  });
</script>

<main class="app">
  <header class="titlebar">
    <span class="title">{doc.title}</span>
    {#if isDirty(doc)}
      <span class="dirty" aria-label="Unsaved changes"></span>
    {/if}
  </header>
  <section class="pane" aria-label="Editor">
    {#key doc.id}
      <Editor {doc} onChange={(text) => (doc.text = text)} />
    {/key}
  </section>
</main>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .titlebar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 14px;
    background: var(--chrome);
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }

  .title {
    font-weight: 600;
  }

  .dirty {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted-strong);
  }

  .pane {
    flex: 1;
    min-height: 0;
    background: var(--editor-bg);
  }
</style>
