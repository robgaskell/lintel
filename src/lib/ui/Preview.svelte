<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { message } from '@tauri-apps/plugin-dialog';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { readImageAsDataUri } from '../ipc';
  import { ImageLoader } from '../render/imageLoader';
  import { renderMermaidIn, type DiagramTheme } from '../render/mermaid';
  import FrontMatterCard from './FrontMatterCard.svelte';
  import { openPaths } from '../os/open';
  import {
    classifyHref,
    classifyImageSrc,
    headingIdFor,
    isMarkdownPath,
    resolveTarget,
  } from '../render/links';
  import type { RenderResult } from '../render/markdown';
  import { cleanAnchors, lineToOffset, offsetToLine, type Anchor } from '../render/scrollSync';

  let {
    result,
    onLineVisible,
    docPath = null,
    reading = false,
    lineCount,
  }: {
    result: RenderResult;
    onLineVisible?: (line: number) => void;
    docPath?: string | null; // relative images and links resolve against its folder
    reading?: boolean; // Read mode: 720 px column, larger text
    lineCount?: number; // source lines; lets the last block sync to the end
  } = $props();

  let scroller: HTMLDivElement;
  let page: HTMLDivElement;
  let content: HTMLDivElement;

  // Follows the OS until M3.1's theme setting replaces it (Ruling 101).
  const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
  let theme: DiagramTheme = darkQuery?.matches ? 'dark' : 'light';

  // The line this preview means to show at its top; kept across re-renders (Ruling 83).
  let topLine = 1;
  // scrollTop after the last programmatic scroll; a scroll event elsewhere is the user's.
  let ownTop: number | null = null;
  let anchors: Anchor[] = [];
  let anchorsStale = true;

  // One per doc, so closing the tab drops its images (Ruling 97).
  const images = new ImageLoader((path) => readImageAsDataUri(path));
  onDestroy(() => images.clear());

  /** Scrolls so `line` (maybe fractional) is at the top. Not reported through onLineVisible. */
  export function scrollToLine(line: number): void {
    topLine = line;
    if (!scroller || scroller.clientHeight === 0) return;
    scroller.scrollTop = lineToOffset(measureAnchors(), line);
    ownTop = scroller.scrollTop;
  }

  export function focus(): void {
    scroller?.focus({ preventScroll: true });
  }

  $effect(() => {
    const [next, path] = [result, docPath];
    untrack(() => patch(next, path));
  });

  onMount(() => {
    // Images, diagrams, the front matter card, a resize or the reading width move blocks.
    const observer = new ResizeObserver(() => {
      anchorsStale = true;
      scrollToLine(topLine);
    });
    observer.observe(page);
    const onTheme = (event: MediaQueryListEvent) => {
      theme = event.matches ? 'dark' : 'light';
      void renderMermaidIn(content, theme);
    };
    darkQuery?.addEventListener('change', onTheme);
    return () => {
      observer.disconnect();
      darkQuery?.removeEventListener('change', onTheme);
    };
  });

  // Parsed into an inert template first, so no relative src ever requests the app origin.
  function patch(next: RenderResult, path: string | null) {
    const started = performance.now();
    const template = document.createElement('template');
    template.innerHTML = next.html;
    prepareImages(template.content, path);
    content.replaceChildren(template.content);
    // Known diagrams go in now; new ones arrive later and the ResizeObserver re-syncs.
    void renderMermaidIn(content, theme);
    anchorsStale = true;
    scrollToLine(topLine);
    timing('lintel:patch', started);
  }

  function measureAnchors(): Anchor[] {
    if (!anchorsStale) return anchors;
    const raw: Anchor[] = [{ line: 1, top: 0 }];
    for (const el of content.querySelectorAll<HTMLElement>(':scope > [data-source-line]')) {
      raw.push({ line: Number(el.dataset.sourceLine), top: el.offsetTop });
    }
    if (lineCount) raw.push({ line: lineCount + 1, top: content.offsetTop + content.offsetHeight });
    anchors = cleanAnchors(raw);
    // A hidden preview measures every top as 0; measure again once it shows.
    anchorsStale = scroller.clientHeight === 0;
    return anchors;
  }

  function onScroll() {
    // Our own scroll, unless the user has moved it since.
    if (ownTop !== null && Math.abs(scroller.scrollTop - ownTop) < 1) return;
    ownTop = null;
    topLine = offsetToLine(measureAnchors(), scroller.scrollTop);
    onLineVisible?.(topLine);
  }

  function prepareImages(root: DocumentFragment, path: string | null) {
    for (const img of root.querySelectorAll('img')) {
      img.removeAttribute('srcset');
      const src = img.getAttribute('src') ?? '';
      const kind = classifyImageSrc(src);
      if (kind === 'data') continue;
      if (kind === 'remote') {
        // No network calls from documents (Ruling 68).
        img.replaceWith(altBox(img, 'Remote images are not loaded.'));
        continue;
      }
      const file = resolveTarget(path, src);
      if (file === null) {
        const why = path === null ? 'Save the document to show relative images.' : 'This image path is not supported.';
        img.replaceWith(altBox(img, why));
        continue;
      }
      // A known image is set in this pass, so a re-render never blinks it out.
      const known = images.cached(file);
      if (known) {
        img.src = known;
        continue;
      }
      img.removeAttribute('src');
      images.load(file).then(
        (uri) => (img.src = uri),
        (err) => img.isConnected && img.replaceWith(altBox(img, String(err))),
      );
    }
  }

  function altBox(img: HTMLImageElement, why: string): HTMLElement {
    const box = document.createElement('span');
    box.className = 'image-alt';
    box.setAttribute('role', 'img');
    box.textContent = img.alt || 'Image';
    box.title = why;
    return box;
  }

  // Ruling 84 refuses every navigation after the first load, so links never navigate.
  function onClick(event: MouseEvent) {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!link || !content.contains(link)) return;
    event.preventDefault();
    follow(link.getAttribute('href') ?? '');
  }

  function onAuxClick(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
  }

  function follow(href: string) {
    const action = classifyHref(href);
    if (action.kind === 'external') {
      openUrl(action.url).catch(showError);
    } else if (action.kind === 'anchor') {
      // By line, not by DOM id: raw HTML in the document can forge h- ids (Ruling 85).
      const id = headingIdFor(action.fragment, new Set(result.headings.map((h) => h.id)));
      const heading = result.headings.find((h) => h.id === id);
      if (!heading) return;
      scrollToLine(heading.line);
      onLineVisible?.(heading.line);
    } else if (action.kind === 'file') {
      const file = resolveTarget(docPath, action.target);
      if (file && isMarkdownPath(file)) void openPaths([file]);
    }
  }

  function showError(err: unknown) {
    void message(String(err), { title: 'Lintel', kind: 'error' });
  }

  // Read in Web Inspector: performance.getEntriesByName('lintel:patch') (Ruling 66).
  function timing(name: string, start: number) {
    performance.clearMeasures?.(name);
    performance.measure?.(name, { start, end: performance.now() });
  }
</script>

<!-- Links inside handle the keyboard: Enter on a focused link fires click. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div
  class="preview"
  class:reading
  bind:this={scroller}
  tabindex="0"
  role="region"
  aria-label="Preview"
  onscroll={onScroll}
  onclick={onClick}
  onauxclick={onAuxClick}
>
  <!-- The card sits outside .content, which every patch replaces (Ruling 102). -->
  <div class="page" bind:this={page}>
    <FrontMatterCard data={result.frontMatter} error={result.frontMatterError} />
    <div class="content" bind:this={content}></div>
  </div>
</div>

<style>
  .preview {
    /* contain: paint keeps document SVG from drawing over the app (Ruling 88). */
    position: relative;
    height: 100%;
    overflow: auto;
    contain: paint;
    overflow-anchor: none;
    box-sizing: border-box;
    background: var(--editor-bg);
    color: var(--preview-text);
    font-size: 15px;
    line-height: 1.6;
    outline: none;
  }

  .page {
    padding: 22px 32px 48px;
  }

  .reading .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 32px 24px 48px;
    font-size: 16px;
    line-height: 1.65;
  }

  .content {
    overflow-wrap: break-word;
  }

  .content > :global(:first-child) {
    margin-top: 0;
  }

  .content :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin: 24px 0 8px;
    line-height: 1.25;
    font-weight: 700;
  }

  .content :global(h1) {
    font-size: 26px;
  }

  .reading .content :global(h1) {
    font-size: 30px;
  }

  .content :global(h2) {
    font-size: 19px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--preview-rule);
  }

  .reading .content :global(h2) {
    font-size: 21px;
    padding-bottom: 6px;
  }

  .content :global(h3) {
    font-size: 16px;
  }

  .content :global(:is(p, ul, ol, pre, table, blockquote, details, figure)) {
    margin: 0 0 16px;
  }

  .content :global(:is(ul, ol)) {
    padding-left: 22px;
  }

  .content :global(.contains-task-list) {
    padding-left: 0;
    list-style: none;
  }

  .content :global(.task-list-item-checkbox) {
    margin: 0 8px 0 0;
    accent-color: var(--accent);
  }

  .content :global(a) {
    color: var(--preview-link);
    text-decoration: none;
    cursor: pointer;
  }

  .content :global(a:hover) {
    text-decoration: underline;
  }

  .content :global(code) {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.87em;
    background: var(--preview-code-bg);
    padding: 1px 5px;
    border-radius: 4px;
  }

  .content :global(pre) {
    padding: 12px 14px;
    background: var(--preview-code-bg);
    border: 1px solid var(--preview-code-border);
    border-radius: 6px;
    overflow-x: auto;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.5;
  }

  .content :global(pre code) {
    padding: 0;
    background: none;
    font-size: inherit;
  }

  .content :global(blockquote) {
    padding: 4px 16px;
    border-left: 3px solid var(--preview-quote-border);
    color: var(--preview-quote-text);
  }

  .content :global(table) {
    border-collapse: collapse;
    font-size: 14px;
    display: block;
    overflow-x: auto;
  }

  .content :global(:is(th, td)) {
    padding: 6px 12px;
    border: 1px solid var(--preview-table-border);
    text-align: left;
  }

  .content :global(th) {
    background: var(--preview-table-head);
  }

  .content :global(hr) {
    border: 0;
    border-top: 1px solid var(--preview-rule);
    margin: 24px 0;
  }

  .content :global(img) {
    max-width: 100%;
  }

  .content :global(.image-alt) {
    display: inline-block;
    padding: 2px 8px;
    border: 1px dashed var(--border);
    border-radius: 4px;
    color: var(--muted-strong);
    font-size: 13px;
  }

  .content :global(:is(.mermaid-diagram, .mermaid-error)) {
    margin: 0 0 24px;
    padding: 20px;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 8px;
  }

  .content :global(.mermaid-diagram) {
    display: flex;
    justify-content: center;
    overflow-x: auto;
  }

  .content :global(.mermaid-diagram svg) {
    height: auto;
  }

  .content :global(.mermaid-error) {
    padding: 12px 16px;
    font-size: 13px;
  }

  .content :global(.mermaid-error pre) {
    margin: 8px 0 0;
    max-height: 200px;
    overflow: auto;
    background: none;
    border: 0;
    padding: 0;
  }

  .content :global(.hljs-keyword),
  .content :global(.hljs-built_in),
  .content :global(.hljs-literal) {
    color: var(--preview-code-keyword);
  }

  .content :global(.hljs-string) {
    color: var(--preview-code-string);
  }

  .content :global(.hljs-comment) {
    color: var(--preview-code-comment);
  }

  .content :global(.hljs-number),
  .content :global(.hljs-title) {
    color: var(--preview-code-title);
  }
</style>
