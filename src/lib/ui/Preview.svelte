<script module lang="ts">
  import { SvelteMap } from 'svelte/reactivity';

  // Keyed by doc id, so the choice outlives a rebuilt preview but not the doc (Ruling 93).
  const remoteChoices = new SvelteMap<string, 'load' | 'keep-blocked'>();
</script>

<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { message } from '@tauri-apps/plugin-dialog';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { fetchRemoteImage, readImageAsDataUri } from '../ipc';
  import { ImageLoader } from '../render/imageLoader';
  import { renderMermaidIn, type DiagramTheme } from '../render/mermaid';
  import { settings, updateSettings } from '../settings/settings.svelte';
  import { resolvedTheme } from '../theme/theme';
  import '../theme/hljs.css';
  import FrontMatterCard from './FrontMatterCard.svelte';
  import RemoteImagesBanner from './RemoteImagesBanner.svelte';
  import { openPaths } from '../os/open';
  import {
    classifyHref,
    classifyImageSrc,
    headingIdFor,
    isMarkdownPath,
    resolveTarget,
    webImageUrl,
  } from '../render/links';
  import type { RenderResult } from '../render/markdown';
  import { cleanAnchors, lineToOffset, offsetToLine, type Anchor } from '../render/scrollSync';

  let {
    result,
    onLineVisible,
    docId,
    docPath = null,
    reading = false,
    lineCount,
    print = false,
  }: {
    result: RenderResult;
    onLineVisible?: (line: number) => void;
    docId: string;
    docPath?: string | null; // relative images and links resolve against its folder
    reading?: boolean; // Read mode: 720 px column, larger text
    lineCount?: number; // source lines; lets the last block sync to the end
    print?: boolean; // the print root: light diagrams, no banner or scroll sync (Ruling 293)
  } = $props();

  let scroller: HTMLDivElement;
  let page: HTMLDivElement;
  let content: HTMLDivElement;

  // The theme diagrams are drawn in; follows the theme engine (Ruling 128).
  let theme: DiagramTheme = untrack(() => (print ? 'light' : $resolvedTheme));
  // A hidden tab draws its diagrams when it is shown, not while out of sight (Ruling 115).
  let diagramsWaiting = false;
  // What drawn() waits for; images only in print mode.
  let diagramsDrawn: Promise<void> = Promise.resolve();
  let imagesLoading: Promise<unknown>[] = [];

  // The line this preview means to show at its top; kept across re-renders (Ruling 83).
  let topLine = 1;
  // scrollTop after the last programmatic scroll; a scroll event elsewhere is the user's.
  let ownTop: number | null = null;
  let anchors: Anchor[] = [];
  let anchorsStale = true;

  // One per doc, so closing the tab drops its images (Ruling 97). Remote images have their
  // own loader with the same limits, and each URL is fetched once per doc (Ruling 137).
  const images = new ImageLoader((path) => readImageAsDataUri(path));
  const remoteImages = new ImageLoader((url) => fetchRemoteImage(url), 50_000_000, 4, { readOnce: true });
  onDestroy(() => {
    images.clear();
    remoteImages.clear();
  });
  let remoteWasAllowed = false;

  let remoteHeldBack = $state(0);
  const remoteChoice = $derived(remoteChoices.get(docId));
  const remoteAllowed = $derived(
    settings.remoteImages === 'load' || (settings.remoteImages === 'ask' && remoteChoice === 'load'),
  );
  const showRemoteBanner = $derived(
    settings.remoteImages === 'ask' && remoteChoice === undefined && remoteHeldBack > 0,
  );

  // Load images asks again for anything that failed or was dropped before.
  function loadRemoteImages() {
    remoteImages.clear();
    remoteChoices.set(docId, 'load');
  }

  function alwaysLoadRemoteImages() {
    loadRemoteImages();
    updateSettings({ remoteImages: 'load' }).catch(showError);
  }

  function keepRemoteImagesBlocked() {
    remoteChoices.set(docId, 'keep-blocked');
  }

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

  /** Settles once the latest render's diagrams are drawn and, in print mode, its images loaded or failed. */
  export async function drawn(): Promise<void> {
    await Promise.allSettled([diagramsDrawn, ...imagesLoading]);
  }

  // Allowing remote images patches again; loaded local images come from the cache.
  $effect(() => {
    const [next, path, remote] = [result, docPath, remoteAllowed];
    untrack(() => patch(next, path, remote));
  });

  $effect(() => {
    const next = $resolvedTheme;
    if (print || next === theme) return;
    theme = next;
    untrack(drawDiagrams);
  });

  onMount(() => {
    if (print) return;
    // Images, diagrams, the front matter card, a resize or the reading width move blocks.
    const observer = new ResizeObserver(() => {
      if (diagramsWaiting) drawDiagrams();
      anchorsStale = true;
      scrollToLine(topLine);
    });
    observer.observe(page);
    return () => observer.disconnect();
  });

  // Parsed into an inert template first, so no relative src ever requests the app origin.
  function patch(next: RenderResult, path: string | null, remote: boolean) {
    const started = performance.now();
    const template = document.createElement('template');
    template.innerHTML = next.html;
    // Blocked again: fetches still queued must not go out.
    if (remoteWasAllowed && !remote) remoteImages.clear();
    remoteWasAllowed = remote;
    imagesLoading = [];
    remoteHeldBack = prepareImages(template.content, path, remote);
    content.replaceChildren(template.content);
    // Known diagrams go in now; new ones arrive later and the ResizeObserver re-syncs.
    drawDiagrams();
    anchorsStale = true;
    scrollToLine(topLine);
    timing('lintel:patch', started);
  }

  // The print root is hidden on screen, but its diagrams are drawn at once.
  function drawDiagrams() {
    diagramsWaiting = !print && scroller.clientHeight === 0;
    if (!diagramsWaiting) diagramsDrawn = renderMermaidIn(content, theme);
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

  /** Returns how many http(s) images it held back. */
  function prepareImages(root: DocumentFragment, path: string | null, remote: boolean): number {
    let heldBack = 0;
    for (const img of root.querySelectorAll('img')) {
      img.removeAttribute('srcset');
      const src = img.getAttribute('src') ?? '';
      const kind = classifyImageSrc(src);
      if (kind === 'data') continue;
      if (kind === 'remote') {
        const url = webImageUrl(src);
        if (url === null) {
          img.replaceWith(altBox(img, 'Lintel loads images from http and https addresses only.'));
        } else if (remote) {
          fill(img, url, remoteImages);
        } else {
          heldBack += 1;
          img.replaceWith(altBox(img, 'Remote images are blocked to protect your privacy.'));
        }
        continue;
      }
      const file = resolveTarget(path, src);
      if (file === null) {
        const why = path === null ? 'Save the document to show relative images.' : 'This image path is not supported.';
        img.replaceWith(altBox(img, why));
        continue;
      }
      fill(img, file, images);
    }
    return heldBack;
  }

  // The image never gets the document's src, only a data URI from Rust.
  function fill(img: HTMLImageElement, key: string, loader: ImageLoader) {
    // A known image is set in this pass, so a re-render never blinks it out.
    const known = loader.cached(key);
    if (known) {
      img.src = known;
      return;
    }
    img.removeAttribute('src');
    const loading = loader.load(key).then(
      (uri) => (img.src = uri),
      (err) => img.isConnected && img.replaceWith(altBox(img, String(err))),
    );
    if (print) imagesLoading.push(loading);
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

<div class="preview-frame" class:print>
  {#if showRemoteBanner && !print}
    <RemoteImagesBanner
      onLoad={loadRemoteImages}
      onAlwaysLoad={alwaysLoadRemoteImages}
      onDismiss={keepRemoteImagesBlocked}
    />
  {/if}
  <!-- Links inside handle the keyboard: Enter on a focused link fires click. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div
    class="preview"
    class:reading
    class:print
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
</div>

<style>
  .preview-frame {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .preview {
    /* contain: paint keeps document SVG from drawing over the app (Ruling 88). */
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    color-scheme: var(--scheme);
    contain: paint;
    overflow-anchor: none;
    box-sizing: border-box;
    background: var(--editor-bg);
    color: var(--preview-text);
    font-family: var(--font-read);
    font-size: var(--size-read);
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
    line-height: 1.65;
  }

  .content {
    overflow-wrap: break-word;
  }

  /* The print root grows to its content, and the page margins replace the padding. */
  .preview-frame.print {
    display: block;
    height: auto;
  }

  .preview.print {
    overflow: visible;
    contain: none;
  }

  .print .page {
    max-width: none;
    padding: 0;
  }

  .print .content :global(:is(pre, table, .mermaid-diagram)) {
    overflow: visible;
  }

  .print .content :global(pre) {
    white-space: pre-wrap;
  }

  .print .content :global(table) {
    display: table;
  }

  .content > :global(:first-child) {
    margin-top: 0;
  }

  .content :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin: 24px 0 8px;
    line-height: 1.25;
    font-weight: 700;
  }

  /* Split and Read keep the artboards' ratios: 26/19/16 px on 15 px, 30/21 px on 16 px. */
  .content :global(h1) {
    font-size: 1.73em;
  }

  .reading .content :global(h1) {
    font-size: 1.875em;
  }

  .content :global(h2) {
    font-size: 1.27em;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--preview-rule);
  }

  .reading .content :global(h2) {
    font-size: 1.3125em;
    padding-bottom: 6px;
  }

  .content :global(h3) {
    font-size: 1.07em;
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
    font-family: var(--font-edit);
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
    font-family: var(--font-edit);
    font-size: 0.87em;
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
    font-size: 0.93em;
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
</style>
