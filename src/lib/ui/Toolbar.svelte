<script lang="ts">
  import type { EditorView } from '@codemirror/view';
  import {
    cycleHeading,
    insertCodeBlock,
    insertLink,
    insertTable,
    toggleBold,
    toggleBulletList,
    toggleItalic,
    toggleTaskList,
  } from '../editor/commands';
  import { viewFor } from '../editor/views';
  import type { ViewMode } from '../docs/store.svelte';
  import ModeSwitch from './ModeSwitch.svelte';

  let {
    docId,
    mode,
    onModeChange,
  }: { docId: string; mode: ViewMode; onModeChange: (m: ViewMode) => void } = $props();

  function run(command: (view: EditorView) => boolean) {
    const view = viewFor(docId);
    if (!view) return;
    command(view);
    view.focus();
  }

  function keepEditorFocus(event: MouseEvent) {
    event.preventDefault();
  }
</script>

<div class="toolbar" class:reading={mode === 'read'}>
  {#if mode !== 'read'}
    <div class="formatting" role="toolbar" aria-label="Formatting">
      <button class="bold" aria-label="Bold" title="Bold" onmousedown={keepEditorFocus} onclick={() => run(toggleBold)}>B</button>
      <button class="italic" aria-label="Italic" title="Italic" onmousedown={keepEditorFocus} onclick={() => run(toggleItalic)}>I</button>
      <button class="heading" aria-label="Heading" title="Heading" onmousedown={keepEditorFocus} onclick={() => run(cycleHeading)}>H</button>
      <span class="divider" aria-hidden="true"></span>
      <button aria-label="Link" title="Link" onmousedown={keepEditorFocus} onclick={() => run(insertLink)}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"></path><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"></path></svg>
      </button>
      <button aria-label="Bulleted list" title="Bulleted list" onmousedown={keepEditorFocus} onclick={() => run(toggleBulletList)}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"></path><circle cx="4.5" cy="6" r="1"></circle><circle cx="4.5" cy="12" r="1"></circle><circle cx="4.5" cy="18" r="1"></circle></svg>
      </button>
      <button aria-label="Task list" title="Task list" onmousedown={keepEditorFocus} onclick={() => run(toggleTaskList)}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="6" height="6" rx="1"></rect><path d="M4.5 7l1.2 1.2L8 5.8"></path><rect x="3" y="14" width="6" height="6" rx="1"></rect><path d="M12 7h9M12 17h9"></path></svg>
      </button>
      <button aria-label="Insert table" title="Insert table" onmousedown={keepEditorFocus} onclick={() => run(insertTable)}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1.5"></rect><path d="M3 10h18M3 15h18M10 4v16"></path></svg>
      </button>
      <button aria-label="Code block" title="Code block" onmousedown={keepEditorFocus} onclick={() => run(insertCodeBlock)}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"></path></svg>
      </button>
    </div>
  {/if}
  <ModeSwitch {mode} onChange={onModeChange} />
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 6px 12px;
    background: var(--chrome);
    border-bottom: 1px solid var(--toolbar-border);
  }

  .toolbar.reading {
    justify-content: flex-end;
  }

  .formatting {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-wrap: wrap;
  }

  .formatting button {
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

  .formatting button:hover {
    background: var(--toolbar-hover);
  }

  .formatting button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .bold {
    font-weight: 700;
  }

  .italic {
    font-family: Georgia, serif;
    font-size: 14px;
    font-style: italic;
  }

  .heading {
    font-weight: 600;
  }

  .divider {
    width: 1px;
    height: 18px;
    margin: 0 6px;
    background: var(--toolbar-divider);
  }
</style>
