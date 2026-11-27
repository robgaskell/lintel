<script lang="ts" module>
  /** Sent to a pane's root after dockview moves its panel, within or between groups. */
  export const PANE_MOVED = 'lintel-pane-moved';
</script>

<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import Editor from '../editor/Editor.svelte';
  import Preview from '../ui/Preview.svelte';
  import Toolbar from '../ui/Toolbar.svelte';
  import { setTopLine, takeStartCursor, takeStartTopLine, trackCursor } from '../docs/cursor.svelte';
  import { attachEditorContextMenu } from '../editor/contextMenu';
  import { registerView } from '../editor/views';
  import { largeFileNotices } from '../os/open';
  import { extractHeadings } from '../render/headings';
  import { renderMarkdown, type Heading, type RenderResult } from '../render/markdown';
  import { createScrollLock, renderDelayMs } from '../render/scrollSync';
  import type { DocState, ViewMode } from '../docs/store.svelte';
  import { outline, outlinePlacement, outlineSources } from './outline.svelte';
  import WindowOutline from './WindowOutline.svelte';

  let { doc }: { doc: DocState } = $props();

  let pane: HTMLDivElement;
  let view: EditorView | null = null;
  let preview = $state<ReturnType<typeof Preview>>();
  let result = $state.raw<RenderResult | null>(null);
  let renderedLines = $state(1);
  let renderError = $state<string | null>(null);

  // Restored from the session: scrolled to the top once the pane shows (Ruling 208).
  const startLine = untrack(() => takeStartTopLine(doc.id));
  let startPending = startLine !== undefined;
  // First visible source line, from whichever side the user scrolled last.
  let topLine = $state(startLine ?? 1);
  $effect(() => setTopLine(doc.id, topLine));
  // At the end, the last heading is on screen though it never reaches the top (Ruling 122).
  let scrolledToEnd = $state(false);
  // Marks the editor scroll that following the preview causes, so it is not sent back.
  const editorLock = createScrollLock(300);
  let paneHidden = $state(false);
  const cleanups: (() => void)[] = [];

  function onReady(editor: EditorView) {
    view = editor;
    const start = takeStartCursor(doc.id);
    if (start !== undefined) {
      const at = cursorAt(editor, start.line, start.col);
      editor.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
      });
    }
    editor.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true });
    if (startPending && pane?.clientHeight > 0) showStartLine();
    cleanups.push(
      registerView(doc.id, editor),
      trackCursor(doc.id, editor),
      attachEditorContextMenu(editor),
      () => editor.scrollDOM.removeEventListener('scroll', onEditorScroll),
    );
  }

  function showStartLine() {
    startPending = false;
    if (!view || doc.mode === 'read') return;
    view.requestMeasure();
    scrollEditorTo(topLine);
  }

  // A new preview starts at its own line 1; it shows the pane's line instead.
  $effect(() => {
    const shown = preview;
    if (shown) untrack(() => shown.scrollToLine(topLine));
  });

  function onEditorScroll() {
    if (!view || paneHidden || editorLock.skip()) return;
    topLine = editorTopLine(view);
    scrolledToEnd = atEnd(view.scrollDOM);
    if (doc.mode === 'split') preview?.scrollToLine(topLine);
  }

  function onPreviewLine(line: number) {
    if (paneHidden) return;
    topLine = line;
    scrolledToEnd = atEnd(pane.querySelector('.preview'));
    if (doc.mode === 'split') scrollEditorTo(line);
  }

  function atEnd(scroller: Element | null): boolean {
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
    return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
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
    editorLock.hold();
    // yMargin 0: the default 5 px would leave the line short of the top (Ruling 83).
    view.dispatch({
      effects: EditorView.scrollIntoView(lineStart(view, line), { y: 'start', yMargin: 0 }),
    });
  }

  function cursorAt(editor: EditorView, line: number, col: number): number {
    const from = lineStart(editor, line);
    const length = editor.state.doc.lineAt(from).length;
    return from + Math.min(Math.max(0, col - 1), length);
  }

  // Headings can lag the text by a debounce, so the line may no longer exist.
  function lineStart(editor: EditorView, line: number): number {
    const n = Math.min(Math.max(1, Math.floor(line)), editor.state.doc.lines);
    return editor.state.doc.line(n).from;
  }

  // Ruling 108: the hidden editor in Read is left alone.
  function pickHeading(heading: Heading) {
    topLine = heading.line;
    scrolledToEnd = false;
    if (doc.mode !== 'read' && view) {
      view.dispatch({ selection: { anchor: lineStart(view, heading.line) } });
      scrollEditorTo(heading.line);
      view.focus();
    }
    if (doc.mode !== 'edit') preview?.scrollToLine(heading.line);
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

  // The preview's render carries headings; Edit mode extracts its own (Ruling 107), always
  // debounced and never while the tab is hidden, so opening a tab does not wait on it (Ruling 119).
  let extracted = $state.raw<Heading[]>([]);
  let extractedText: string | null = null;
  $effect(() => {
    const text = doc.text;
    if (!outline.visible || doc.mode !== 'edit' || paneHidden || text === extractedText) return;
    if (result && renderedText === text) {
      extracted = result.headings;
      extractedText = text;
      return;
    }
    const timer = setTimeout(() => {
      extracted = extractHeadings(text);
      extractedText = text;
    }, renderDelayMs(new TextEncoder().encode(text).length));
    return () => clearTimeout(timer);
  });
  const headings = $derived(doc.mode !== 'edit' && result ? result.headings : extracted);

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

  // Moving the panel to another group takes the pane out of the page as well, but the
  // observer below sees no hidden spell then.
  function restoreScroll() {
    if (!pane.isConnected) return;
    if (view && doc.mode !== 'read') {
      view.requestMeasure();
      scrollEditorTo(topLine);
    }
    if (doc.mode !== 'edit') preview?.scrollToLine(topLine);
  }

  onMount(() => {
    // Dockview takes a hidden tab's pane out of the page, which resets its scroll (Ruling 83).
    const observer = new ResizeObserver(([entry]) => {
      const hidden = !entry || entry.contentRect.height === 0;
      if (startPending && !hidden && view) showStartLine();
      else if (paneHidden && !hidden && view && doc.mode !== 'read') {
        view.requestMeasure();
        scrollEditorTo(topLine);
      }
      paneHidden = hidden;
    });
    observer.observe(pane);
    pane.addEventListener(PANE_MOVED, restoreScroll);
    outlineSources.set(doc.id, {
      get headings() {
        return headings;
      },
      get activeLine() {
        return scrolledToEnd ? Number.POSITIVE_INFINITY : topLine;
      },
      pick: pickHeading,
    });
    return () => {
      observer.disconnect();
      pane.removeEventListener(PANE_MOVED, restoreScroll);
      outlineSources.delete(doc.id);
    };
  });

  onDestroy(() => {
    for (const cleanup of cleanups) cleanup();
  });
</script>

<div class="doc-pane" data-doc-pane={doc.id} bind:this={pane}>
  <Toolbar docId={doc.id} mode={doc.mode} onModeChange={(m) => (doc.mode = m)} />
  <div class="panes mode-{doc.mode}">
    {#if outlinePlacement.anchorId === doc.id}
      <WindowOutline docId={outlinePlacement.docId} />
    {/if}
    <div class="doc-column">
      {#if largeFileNotices.has(doc.id)}
        <div class="notice" role="status">Large file: preview is off. Switch to Split or Read to render it.</div>
      {/if}
      <div class="doc-row">
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
              docId={doc.id}
              docPath={doc.path}
              reading={doc.mode === 'read'}
              lineCount={renderedLines}
              onLineVisible={onPreviewLine}
            />
          {/if}
        </div>
      </div>
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

  .panes {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .doc-column {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .doc-row {
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
