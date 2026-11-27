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
import { keepsLink } from './exportLinks';
import { renderFrozen } from './print';
import { exportName, withoutMarkdownExtension, writeUnlessOpen } from './target';

// The file loads nothing. stripRemote is the first guard and this CSP the second (Ruling 320).
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
// Attributes that load something whatever their value looks like.
const REMOTE_ATTRS = ['srcset', 'poster', 'background', 'ping'];
// The alt box's own reason can name a local path, and the file is shared (Ruling 319).
const ALT_BOX_TITLE = 'Image not available';

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
  dropCopiedHeadingIds(template.content, result.headings);
  pointAnchorsAtHeadings(template.content, result.headings);
  unlinkNetworkPaths(template.content);
  // Before the page sees it, so nothing even tries to load.
  stripRemote(template.content);
  // Mermaid draws only in the page.
  const host = document.createElement('div');
  host.hidden = true;
  document.body.append(host);
  try {
    await renderFrozen(doc, host, { result: { ...result, html: template.innerHTML }, theme });
    for (const box of host.querySelectorAll('.image-alt')) box.setAttribute('title', ALT_BOX_TITLE);
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

// Raw HTML may copy a heading's id; only the heading keeps it, so links land there (Ruling 322).
function dropCopiedHeadingIds(root: DocumentFragment, headings: Heading[]) {
  const owners = new Map<string, Element[]>();
  for (const el of root.querySelectorAll('[id]')) owners.set(el.id, [...(owners.get(el.id) ?? []), el]);
  for (const heading of headings) {
    const candidates = owners.get(heading.id) ?? [];
    const tagged = candidates.filter((el) => el.localName === `h${heading.level}`);
    // A nested heading has no line; then its text decides.
    const real =
      tagged.find((el) => el.getAttribute('data-source-line') === String(heading.line)) ??
      tagged.find((el) => el.textContent?.trim() === heading.text);
    for (const el of candidates) if (el !== real) el.removeAttribute('id');
  }
}

function unlinkNetworkPaths(root: DocumentFragment) {
  for (const link of root.querySelectorAll('a')) {
    for (const attr of [...link.attributes]) {
      if (attr.localName === 'href' && !keepsLink(attr.value)) link.removeAttributeNode(attr);
    }
  }
}

// Drops raw styles and every attribute that could load something (Rulings 320, 329, 331).
// With tab, LF and CR removed first, as URL parsers do, a value goes if it starts with a
// scheme other than data:, `//` or `\\`; or if it has a parenthesis and holds such a scheme,
// a backslash or `//` anywhere, or a url() not within the page. Other hrefs keep only a
// #fragment. alt, title and aria-* never load, so they stay. Links are unlinkNetworkPaths'
// job, and an image's src is the preview's, which keeps only data URIs.
function stripRemote(root: DocumentFragment) {
  for (const style of root.querySelectorAll('style')) style.remove();
  for (const el of root.querySelectorAll('*')) {
    el.removeAttribute('style');
    for (const name of REMOTE_ATTRS) el.removeAttribute(name);
    if (el.localName !== 'img') el.removeAttribute('src');
    for (const attr of [...el.attributes]) {
      if (el.localName === 'a' && attr.localName === 'href') continue;
      if (el.localName === 'img' && attr.name === 'src') continue;
      if (attr.name === 'alt' || attr.name === 'title' || attr.name.startsWith('aria-')) continue;
      // Only an in-page target may stay in an href, as in svg <use>.
      const off = attr.localName === 'href' ? !attr.value.startsWith('#') : pointsOffPage(attr.value);
      if (off) el.removeAttributeNode(attr);
    }
  }
}

function pointsOffPage(value: string): boolean {
  const target = value.replace(/[\t\n\r]/g, '').trim();
  if (!target.includes('(')) return /^([a-z][a-z0-9+.-]*:\S|[\\/]{2})/i.test(target) && !isInPage(target);
  // Any letter case, and even inside a data: URI.
  const schemes = target.match(/[a-z][a-z0-9+.-]*:/gi) ?? [];
  if (schemes.some((scheme) => scheme.toLowerCase() !== 'data:') || /\\|\/\//.test(target)) return true;
  return /url\(/i.test(target.replace(/url\(\s*(['"]?)\s*(#|data:)[^'")]*\1\s*\)/gi, ''));
}

function isInPage(target: string): boolean {
  return target.startsWith('#') || /^data:/i.test(target);
}

// Resolvable once the doc has a folder, which an untitled doc does not.
function isRelativeImage(img: HTMLImageElement): boolean {
  const src = img.getAttribute('src') ?? '';
  return classifyImageSrc(src) === 'local' && resolveTarget(null, src) === null && resolveTarget('/doc.md', src) !== null;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
