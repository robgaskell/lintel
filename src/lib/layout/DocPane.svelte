<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import Editor from '../editor/Editor.svelte';
  import Preview from '../ui/Preview.svelte';
  import Toolbar from '../ui/Toolbar.svelte';
  import { attachEditorContextMenu } from '../editor/contextMenu';
  import { registerView } from '../editor/views';
  import { largeFileNotices } from '../os/open';
  import { renderMarkdown, type RenderResult } from '../render/markdown';
  import { createScrollLock, renderDelayMs } from '../render/scrollSync';
  import type { DocState, ViewMode } from '../docs/store.svelte';

  let { doc }: { doc: DocState } = $props();

  let pane: HTMLDivElement;
  let view: EditorView | null = null;
  let preview = $state<ReturnType<typeof Preview>>();
  let result = $state.raw<RenderResult | null>(null);
  let renderedLines = $state(1);
  let renderError = $state<string | null>(null);

  // First visible source line, from whichever side the user scrolled last.
  let topLine = 1;
  // Set while the editor follows the preview, so its scroll events are not sent back.
  const editorLock = createScrollLock(150);
  let paneHidden = false;
  const cleanups: (() => void)[] = [];

  function onReady(editor: EditorView) {
    view = editor;
    editor.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true });
    cleanups.push(
      registerView(doc.id, editor),
      attachEditorContextMenu(editor),
      () => editor.scrollDOM.removeEventListener('scroll', onEditorScroll),
    );
  }

  function onEditorScroll() {
    if (!view || paneHidden || editorLock.held()) return;
    topLine = editorTopLine(view);
    if (doc.mode === 'split') preview?.scrollToLine(topLine);
  }

  function onPreviewLine(line: number) {
    if (paneHidden) return;
    topLine = line;
    if (doc.mode === 'split') scrollEditorTo(line);
  }

  // Fractional, so the preview moves smoothly through a long wrapped line.
  function editorTopLine(editor: EditorView): number {
    const height = Math.max(0, editor.scrollDOM.scrollTop - editor.documentPadding.top);
    const block = editor.lineBlockAtHeight(height);
    const line = editor.state.doc.lineAt(block.from).number;
    if (block.height <= 0) return line;
    return line + Math.min(1, Math.max(0, (height - block.top) / block.height));
  }

  function scrollEditorTo(line: number) {
    if (!view) return;
    const n = Math.min(Math.max(1, Math.floor(line)), view.state.doc.lines);
    editorLock.hold();
    // yMargin 0: the default 5 px would leave the line short of the top (Ruling 83).
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'start', yMargin: 0 }),
    });
  }

  // Debounced render. Showing the preview renders at once; edits wait (spec: Large files).
  let previewShown = false;
  let renderedText: string | null = null;
  $effect(() => {
    const text = doc.text;
    const shown = doc.mode !== 'edit';
    const justShown = shown && !previewShown;
    previewShown = shown;
    if (!shown || text === renderedText) return;
    if (justShown || renderedText === null) {
      renderNow(text);
      return;
    }
    const timer = setTimeout(() => renderNow(text), renderDelayMs(new TextEncoder().encode(text).length));
    return () => clearTimeout(timer);
  });

  function renderNow(text: string) {
    const started = performance.now();
    try {
      result = renderMarkdown(text);
      renderedLines = text.split('\n').length;
      renderError = null;
    } catch (err) {
      renderError = String(err);
    }
    renderedText = text;
    // Read in Web Inspector: performance.getEntriesByName('lintel:render') (Ruling 66).
    performance.clearMeasures?.('lintel:render');
    performance.measure?.('lintel:render', { start: started, end: performance.now() });
  }

  let shownMode: ViewMode | null = null;
  $effect(() => {
    const mode = doc.mode;
    untrack(() => modeChanged(mode));
  });

  function modeChanged(mode: ViewMode) {
    const previous = shownMode;
    shownMode = mode;
    // The notice goes once the user asks for a preview (Ruling 79).
    if (mode !== 'edit') largeFileNotices.delete(doc.id);
    if (previous === null || previous === mode) return;
    if (previous === 'read' && view) {
      // The editor stays mounted while hidden (Ruling 77), but its layout is stale.
      view.requestMeasure();
      scrollEditorTo(topLine);
    }
    void tick().then(() => {
      if (mode !== 'edit') preview?.scrollToLine(topLine);
      if (mode === 'read') preview?.focus();
      else view?.focus();
    });
  }

  onMount(() => {
    // Dockview takes a hidden tab's pane out of the page, which resets its scroll (Ruling 83).
    const observer = new ResizeObserver(([entry]) => {
      const hidden = !entry || entry.contentRect.height === 0;
      if (paneHidden && !hidden && view && doc.mode !== 'read') {
        view.requestMeasure();
        scrollEditorTo(topLine);
      }
      paneHidden = hidden;
    });
    observer.observe(pane);
    return () => observer.disconnect();
  });

  onDestroy(() => {
    for (const cleanup of cleanups) cleanup();
  });
</script>

<div class="doc-pane" data-doc-pane={doc.id} bind:this={pane}>
  <Toolbar docId={doc.id} mode={doc.mode} onModeChange={(m) => (doc.mode = m)} />
  {#if largeFileNotices.has(doc.id)}
    <div class="notice" role="status">Large file: preview is off. Switch to Split or Read to render it.</div>
  {/if}
  <div class="panes mode-{doc.mode}">
    <!-- Inert in Read, so keys never edit a hidden document. -->
    <div class="editor-host" inert={doc.mode === 'read'}>
      <Editor {doc} onChange={(text) => (doc.text = text)} {onReady} />
    </div>
    <div class="preview-host">
      {#if renderError}
        <p class="render-error" role="alert">{renderError}</p>
      {:else if result}
        <Preview
          bind:this={preview}
          {result}
          docPath={doc.path}
          reading={doc.mode === 'read'}
          lineCount={renderedLines}
          onLineVisible={onPreviewLine}
        />
      {/if}
    </div>
  </div>
</div>

<style>
  .doc-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--editor-bg);
  }

  .notice {
    padding: 6px 12px;
    background: var(--chrome);
    border-bottom: 1px solid var(--toolbar-border);
    color: var(--muted-strong);
    font-size: 12px;
  }

  .panes {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .editor-host,
  .preview-host {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
  }

  .mode-split .editor-host {
    border-right: 1px solid var(--toolbar-border);
  }

  .mode-edit .preview-host,
  .mode-read .editor-host {
    display: none;
  }

  .render-error {
    margin: 22px 32px;
    color: var(--muted-strong);
  }
</style>
