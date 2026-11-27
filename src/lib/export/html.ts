import { message, save } from '@tauri-apps/plugin-dialog';
import type { DocState } from '../docs/store.svelte';
import { writeTextFile } from '../ipc';
import articleCss from '../render/article.css?inline';
import { classifyHref, classifyImageSrc, headingIdFor, resolveTarget, webImageUrl } from '../render/links';
import { renderMarkdown, type Heading } from '../render/markdown';
import type { DiagramTheme } from '../render/mermaid';
import { settings } from '../settings/settings.svelte';
import hljsCss from '../theme/hljs.css?inline';
import { cssVariables } from '../theme/theme';
import tokensCss from '../theme/tokens.css?inline';
import pageCss from './html.css?inline';
import { renderFrozen } from './print';
import { exportName, withoutMarkdownExtension, writeUnlessOpen } from './target';

// The file loads nothing from anywhere; its images are data URIs (Ruling 307).
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
// Attributes the sanitiser keeps that would load from the network.
const REMOTE_ATTRS = ['srcset', 'poster', 'background', 'ping'];

type ExportDoc = Pick<DocState, 'id' | 'path' | 'title' | 'text'>;

/** The doc as one self-contained HTML file that looks like Read mode (Ruling 306). */
export async function buildStandaloneHtml(doc: ExportDoc, opts: { theme: 'light' | 'dark' }): Promise<string> {
  return (await build(doc, opts.theme)).html;
}

/** Asks where to save, then writes the doc as HTML in the light palette. */
export async function exportHtml(doc: DocState): Promise<void> {
  const path = await save({
    defaultPath: exportName(doc, 'html'),
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  if (path === null) return;
  const built = await writeUnlessOpen(path, async () => {
    const result = await build(doc, 'light');
    await writeTextFile(path, result.html);
    return result;
  });
  if (built?.unembedded) {
    await message('Save the document first to embed its local images.', { title: 'Export as HTML', kind: 'info' });
  }
}

/** `unembedded`: an untitled doc has relative images, which stay as alt boxes. */
async function build(doc: ExportDoc, theme: DiagramTheme): Promise<{ html: string; unembedded: boolean }> {
  const result = renderMarkdown(doc.text);
  const template = document.createElement('template');
  template.innerHTML = result.html;
  const unembedded = doc.path === null && [...template.content.querySelectorAll('img')].some(isRelativeImage);
  linkRemoteImages(template.content);
  pointAnchorsAtHeadings(template.content, result.headings);
  // Before the page sees it, so nothing even tries to load.
  stripRemote(template.content);
  // Mermaid draws only in the page.
  const host = document.createElement('div');
  host.hidden = true;
  document.body.append(host);
  try {
    await renderFrozen(doc, host, { result: { ...result, html: template.innerHTML }, theme });
    return { html: page(withoutMarkdownExtension(doc.title), theme, host.innerHTML), unembedded };
  } finally {
    host.remove();
  }
}

function page(title: string, theme: DiagramTheme, body: string): string {
  const variables = Object.entries(cssVariables(settings, theme))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  // The light token block, or the dark one through data-theme, as in the app.
  const css = [`:root {\n${variables}\n}`, tokensCss, hljsCss, articleCss, pageCss].join('\n');
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// Never fetched: the link shows the alt text, or the address. Inside a link, the text alone.
function linkRemoteImages(root: DocumentFragment) {
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    const url = classifyImageSrc(src) === 'remote' ? webImageUrl(src) : null;
    if (url === null) continue;
    const text = img.alt || url;
    if (img.closest('a')) {
      img.replaceWith(text);
      continue;
    }
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.textContent = text;
    img.replaceWith(link);
  }
}

// The preview finds headings at click time; the file needs their ids (Ruling 308).
function pointAnchorsAtHeadings(root: DocumentFragment, headings: Heading[]) {
  const ids = new Set(headings.map((h) => h.id));
  for (const link of root.querySelectorAll('a[href^="#"]')) {
    const action = classifyHref(link.getAttribute('href') ?? '');
    const id = action.kind === 'anchor' ? headingIdFor(action.fragment, ids) : null;
    if (id) link.setAttribute('href', `#${id}`);
  }
}

// An image's src is left to the preview, which keeps only data URIs. Links keep their
// href; any other element only one that points within the page.
function stripRemote(root: ParentNode) {
  for (const el of root.querySelectorAll('*')) {
    for (const name of REMOTE_ATTRS) el.removeAttribute(name);
    if (el.localName !== 'img') el.removeAttribute('src');
    if (el.localName === 'a') continue;
    for (const name of ['href', 'xlink:href']) {
      if (!el.getAttribute(name)?.startsWith('#')) el.removeAttribute(name);
    }
  }
}

// Resolvable once the doc has a folder, which an untitled doc does not.
function isRelativeImage(img: HTMLImageElement): boolean {
  const src = img.getAttribute('src') ?? '';
  return classifyImageSrc(src) === 'local' && resolveTarget(null, src) === null && resolveTarget('/doc.md', src) !== null;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
