import { message, save } from '@tauri-apps/plugin-dialog';
import type { ParagraphChild } from 'docx';
import type { Code, Image, Nodes, Root } from 'mdast';
import type { RemarkDocxPlugin } from 'remark-docx';
import type { DocState } from '../docs/store.svelte';
import { readImageAsDataUri, writeBinaryFile } from '../ipc';
import { splitFrontMatter } from '../render/frontMatter';
import { classifyHref, classifyImageSrc, headingIdFor, resolveTarget } from '../render/links';
import { slugify } from '../render/markdown';
import { renderMermaidToSvg } from '../render/mermaid';
import { settings } from '../settings/settings.svelte';
import { bytesToBase64, dataUriToBytes } from './bytes';
import { imageToPng, svgSize, svgToPng } from './svgToPng';
import { exportName, withoutMarkdownExtension, writeUnlessOpen } from './target';

type ExportDoc = Pick<DocState, 'path' | 'title' | 'text'>;
type Docx = typeof import('docx');
type Builders = Awaited<ReturnType<RemarkDocxPlugin>>;
type DocxImage = NonNullable<Parameters<RemarkDocxPlugin>[0]['images'] extends Map<string, infer T> ? T : never>;

const CODE_FONT = 'Consolas';
const DIAGRAM_SCALE = 2;

/** The doc as a .docx file. unified, remark and docx load on first use, as they are large. */
export async function buildDocx(doc: ExportDoc): Promise<Uint8Array> {
  return (await build(doc)).bytes;
}

/** Asks where to save, then writes the doc as a Word file. */
export async function exportDocx(doc: DocState): Promise<void> {
  const path = await save({
    defaultPath: exportName(doc, 'docx'),
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  });
  if (path === null) return;
  const built = await writeUnlessOpen(path, async () => {
    const result = await build(doc);
    await writeBinaryFile(path, bytesToBase64(result.bytes));
    return result;
  });
  if (built?.unembedded) {
    await message('Save the document first to embed its local images.', { title: 'Export as Word', kind: 'info' });
  }
}

/** `unembedded`: an untitled doc has relative images, which are left out. */
async function build(doc: ExportDoc): Promise<{ bytes: Uint8Array; unembedded: boolean }> {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { default: remarkDocx }, docx] =
    await Promise.all([import('unified'), import('remark-parse'), import('remark-gfm'), import('remark-docx'), import('docx')]);
  const images = imageLoader(doc.path);
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => pointAnchorsAtHeadings)
    .use(remarkDocx, {
      title: withoutMarkdownExtension(doc.title),
      image: { load: images.load, toPng },
      plugins: [diagrams(docx), pngOnlySvgs(), code(docx)],
    })
    // remark-docx prints front matter as text, so it goes first.
    .process(splitFrontMatter(doc.text).body);
  if (!(file.value instanceof Uint8Array)) throw new Error('The Word file could not be made.');
  return { bytes: file.value, unembedded: images.unembedded() };
}

// Never fetch: the CSP blocks it, and remote images stay remote (Ruling 315).
function imageLoader(docPath: string | null) {
  let unembedded = false;
  async function load(url: string): Promise<Uint8Array> {
    const kind = classifyImageSrc(url);
    if (kind === 'data') return dataUriToBytes(url);
    // remark-docx shows the alt text instead.
    if (kind === 'remote') throw new Error('Remote images are not embedded.');
    const path = resolveTarget(docPath, url);
    if (path === null) {
      if (docPath === null && resolveTarget('/doc.md', url) !== null) unembedded = true;
      throw new Error('The image path cannot be resolved.');
    }
    return dataUriToBytes(await readImageAsDataUri(path));
  }
  return { load, unembedded: () => unembedded };
}

// For webp and svg. A canvas reads them from a data: URI, never a blob: URL (Ruling 315).
async function toPng({ buffer, width, height }: { buffer: ArrayBuffer; width: number; height: number }) {
  const bytes = new Uint8Array(buffer);
  const webp = new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
  const text = webp ? '' : new TextDecoder().decode(bytes);
  if (/<svg\b/i.test(text)) return svgToPng(text, DIAGRAM_SCALE);
  return imageToPng(`data:image/webp;base64,${bytesToBase64(bytes)}`, width, height);
}

/**
 * Mermaid blocks as PNG pictures: drawn at 2x for sharpness, shown at the preview's size
 * (remark-docx sizes a picture from the width and height given, clamped to the text width).
 * A diagram that fails keeps its code (Ruling 316).
 */
function diagrams(docx: Docx): RemarkDocxPlugin {
  return async ({ root, images }) => {
    const keys = new Map<Code, string>();
    const renders: Promise<void>[] = [];
    walk(root, (node) => {
      if (node.type !== 'code' || node.lang?.toLowerCase() !== 'mermaid') return;
      const key = `\0lintel-diagram-${keys.size}`;
      keys.set(node, key);
      renders.push(
        diagramImage(node.value).then((image) => {
          if (image) images.set(key, image);
        }),
      );
    });
    await Promise.all(renders);
    return {
      code: (node, ctx) => {
        const key = keys.get(node);
        if (key === undefined || !ctx.images.get(key)) return null;
        // An image renders to one run.
        const runs = ctx.render([{ type: 'image', url: key, alt: 'Diagram' }]) as ParagraphChild[];
        return new docx.Paragraph({ children: runs });
      },
    };
  };
}

async function diagramImage(source: string): Promise<DocxImage | null> {
  try {
    const svg = await renderMermaidToSvg(source, 'light', { htmlLabels: false });
    const size = svgSize(svg);
    if (size === null) return null;
    const png = await svgToPng(svg, DIAGRAM_SCALE);
    return { type: 'png', data: arrayBuffer(png), width: size.width, height: size.height };
  } catch (err) {
    console.warn('A diagram could not be drawn for Word:', err);
    return null;
  }
}

/**
 * remark-docx embeds an SVG with its PNG as fallback; Lintel embeds the PNG only, so Word
 * never renders a document's own SVG (Ruling 315). Raw HTML images keep the default.
 */
function pngOnlySvgs(): RemarkDocxPlugin {
  return async ({ images }) => {
    function asPng(node: Pick<Image, 'url' | 'alt' | 'title'>, ctx: Parameters<NonNullable<Builders['image']>>[1]) {
      const image = ctx.images.get(node.url);
      if (image?.type !== 'svg') return null;
      const key = `\0lintel-png-${node.url}`;
      images.set(key, { type: 'png', data: image.fallback, width: image.width, height: image.height });
      return ctx.render([{ type: 'image', url: key, alt: node.alt, title: node.title }]);
    }
    return {
      image: (node, ctx) => asPng(node, ctx),
      imageReference: (node, ctx) => {
        const definition = ctx.definition(node.identifier);
        return definition ? asPng({ url: definition.url, alt: node.alt, title: definition.title }, ctx) : null;
      },
    };
  };
}

/** Code blocks and inline code in Consolas on the preview's code background (Ruling 317). */
function code(docx: Docx): RemarkDocxPlugin {
  const fill = /^#[0-9a-f]{6}$/i.test(settings.palettes.light.codeBackground)
    ? settings.palettes.light.codeBackground.slice(1).toUpperCase()
    : 'F4F4F3';
  const shading = { type: docx.ShadingType.CLEAR, color: 'auto', fill };
  return async () => ({
    code: ({ value }, ctx) => {
      // remark-docx 0.5.3's own indents: 720 twips per quote level, 400 per list level.
      const quote = ctx.quote === undefined ? 0 : 720 * (ctx.quote + 1);
      const list = ctx.list ? 400 * (ctx.list.level + 1) : 0;
      return new docx.Paragraph({
        shading,
        indent: { left: quote + list, right: ctx.quote === undefined ? 0 : 720 },
        children: value.split(/\r?\n/).map(
          (line, i) => new docx.TextRun({ text: line, font: CODE_FONT, break: i === 0 ? undefined : 1 }),
        ),
      });
    },
    inlineCode: ({ value }, ctx) =>
      new docx.TextRun({
        text: value,
        font: CODE_FONT,
        shading,
        bold: ctx.style.bold,
        italics: ctx.style.italic,
        strike: ctx.style.strike,
        style: ctx.style.link ? 'Hyperlink' : undefined,
      }),
  });
}

/**
 * remark-docx links `#fragment` to a heading only when it is the heading's exact slug; the
 * preview also takes the text as written or lower-cased (Ruling 64), so links are rewritten.
 */
function pointAnchorsAtHeadings(tree: Root) {
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  walk(tree, (node) => {
    if (node.type === 'heading') ids.add(`h-${slugify(plainText(node), seen)}`);
  });
  walk(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'definition') return;
    const action = classifyHref(node.url);
    const id = action.kind === 'anchor' ? headingIdFor(action.fragment, ids) : null;
    if (id) node.url = `#${id.slice(2)}`;
  });
}

// As remark-docx reads a heading: no raw HTML, no image alt text.
function plainText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return 'children' in node ? node.children.map(plainText).join('') : '';
}

function walk(node: Nodes, visit: (node: Nodes) => void) {
  visit(node);
  if ('children' in node) for (const child of node.children) walk(child, visit);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
