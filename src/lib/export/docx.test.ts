import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { message, save } from '@tauri-apps/plugin-dialog';
import { createDoc, docs, opening, type DocState } from '../docs/store.svelte';
import { claimPath, fetchRemoteImage, readImageAsDataUri, releasePath, writeBinaryFile } from '../ipc';
import { renderMermaidToSvg } from '../render/mermaid';
import { buildDocx, exportDocx } from './docx';
import { imageToPng, svgToPng } from './svgToPng';

// A real 1x1 PNG, so the image size reader accepts it.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
const DIAGRAM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 300px;" viewBox="0 0 300 150"><text>A</text></svg>';
// A 4x3 lossless webp header, enough for its size to be read.
const WEBP = new Uint8Array([
  ...[0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  ...[0x56, 0x50, 0x38, 0x4c, 0x0d, 0, 0, 0, 0x2f, 0x03, 0x80, 0x00, 0x00],
  ...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
]);

vi.mock('../ipc', () => ({
  readImageAsDataUri: vi.fn(async () => `data:image/png;base64,${PNG_BASE64}`),
  fetchRemoteImage: vi.fn(),
  writeBinaryFile: vi.fn(async () => {}),
  normalizePath: vi.fn(async (path: string) => path),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
}));
vi.mock('../render/mermaid', () => ({ renderMermaidToSvg: vi.fn(async () => DIAGRAM_SVG) }));
vi.mock('./svgToPng', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./svgToPng')>()),
  svgToPng: vi.fn(async () => PNG),
  imageToPng: vi.fn(async () => PNG),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(async () => {}), save: vi.fn() }));

const fetchSpy = vi.fn(async () => new Response(PNG));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
  docs.clear();
  opening.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

function doc(text: string, path: string | null = '/notes/doc.md', title = 'doc.md'): DocState {
  return { id: `doc-${Math.random()}`, path, title, text } as DocState;
}

/** Each entry of a zip, read from its local headers with node:zlib (Ruling 318). */
function unzip(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = new Map<string, string>();
  let at = 0;
  while (at + 30 <= zip.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extraLength;
    const data = zip.subarray(start, start + size);
    const bytes = method === 8 ? inflateRawSync(data) : data;
    entries.set(name, new TextDecoder().decode(bytes));
    at = start + size;
  }
  return entries;
}

async function parts(text: string, d = doc(text)): Promise<Map<string, string>> {
  return unzip(await buildDocx(d));
}

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

const SAMPLE = [
  '---',
  'secretKey: hidden-value',
  '---',
  '# Intro',
  '',
  'See [the site](https://example.com/page) and [back up](#Intro).',
  '',
  '```js',
  'const codeText = 42;',
  '```',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '- [ ] open',
  '- [x] done',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '```mermaid',
  'graph TD; C-->D',
  '```',
  '',
].join('\n');

describe('buildDocx', () => {
  it('is a zip with the heading, table, code, links and one drawing per diagram; no front matter', async () => {
    const zip = await parts(SAMPLE);
    const xml = zip.get('word/document.xml')!;

    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('Intro');
    expect(count(xml, /<w:tbl>/g)).toBe(1);
    expect(xml).toContain('const codeText = 42;');
    // Word keeps link targets in the relationships part (Ruling 318).
    expect(zip.get('word/_rels/document.xml.rels')).toContain('Target="https://example.com/page"');
    expect(count(xml, /<w:drawing>/g)).toBe(2);
    expect(xml).not.toMatch(/secretKey|hidden-value/);
  });

  it('shows task lists with ballot boxes', async () => {
    const zip = await parts(SAMPLE);
    expect(zip.get('word/numbering.xml')).toContain('☐');
    expect(zip.get('word/numbering.xml')).toContain('☑');
  });

  it('points a #fragment link at its heading\'s bookmark, as the preview finds it (Ruling 318)', async () => {
    const xml = (await parts(SAMPLE)).get('word/document.xml')!;

    const anchor = /<w:hyperlink [^>]*w:anchor="([^"]+)"/.exec(xml)?.[1];
    expect(anchor).toBeTruthy();
    expect(xml).toContain(`<w:bookmarkStart w:name="${anchor}"`);
  });

  it('sets code blocks and inline code in Consolas on the preview\'s shading (Ruling 317)', async () => {
    const xml = (await parts('Run `npm test` now.\n\n```\nline one\nline two\n```\n')).get('word/document.xml')!;

    const runs = [...xml.matchAll(/<w:r>(?:(?!<\/w:r>).)*<\/w:r>/gs)].map(([run]) => run);
    for (const text of ['npm test', 'line one', 'line two']) {
      const run = runs.find((r) => r.includes(`>${text}<`));
      expect(run, text).toMatch(/<w:rFonts w:ascii="Consolas"/);
    }
    expect(xml).toMatch(/<w:shd [^>]*w:fill="F4F4F3"/);
    expect(runs.find((r) => r.includes('> now.<'))).not.toContain('Consolas');
  });

  it('renders diagrams light, with SVG labels, at 2x pixels, shown at the preview size (Ruling 316)', async () => {
    const xml = (await parts('```mermaid\ngraph TD; A-->B\n```\n')).get('word/document.xml')!;

    expect(renderMermaidToSvg).toHaveBeenCalledWith('graph TD; A-->B', 'light', { htmlLabels: false });
    expect(svgToPng).toHaveBeenCalledWith(DIAGRAM_SVG, 2);
    // 300 x 150 px at 9525 EMU per px.
    expect(xml).toContain('<wp:extent cx="2857500" cy="1428750"/>');
  });

  it('fits a wide diagram to the text width', async () => {
    vi.mocked(renderMermaidToSvg).mockResolvedValueOnce('<svg viewBox="0 0 2000 500"></svg>');
    const xml = (await parts('```mermaid\ngraph LR; A-->B\n```\n')).get('word/document.xml')!;
    // A4 less 1 in margins: 6.27 in.
    expect(xml).toMatch(/<wp:extent cx="5731510" cy="\d+"\/>/);
  });

  it('keeps a diagram that fails as its code', async () => {
    vi.mocked(renderMermaidToSvg).mockRejectedValueOnce(new Error('Parse error on line 1'));
    const xml = (await parts('```mermaid\nnot a diagram\n```\n')).get('word/document.xml')!;

    expect(count(xml, /<w:drawing>/g)).toBe(0);
    expect(xml).toContain('not a diagram');
  });

  it('embeds a local image read from the doc folder', async () => {
    const zip = await parts('![Chart](img/a%20b.png)\n');

    expect(readImageAsDataUri).toHaveBeenCalledWith('/notes/img/a b.png');
    expect(count(zip.get('word/document.xml')!, /<w:drawing>/g)).toBe(1);
    expect([...zip.keys()].some((name) => /^word\/media\/.+\.png$/.test(name))).toBe(true);
  });

  it('embeds a data: image without reading or fetching anything', async () => {
    const xml = (await parts(`![Dot](data:image/png;base64,${PNG_BASE64})\n`)).get('word/document.xml')!;

    expect(count(xml, /<w:drawing>/g)).toBe(1);
    expect(readImageAsDataUri).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never loads a remote image, from markdown or raw HTML, and shows its alt text (Ruling 315)', async () => {
    const xml = (
      await parts(
        [
          '![Remote chart](https://x.example/r.png)',
          '',
          '![Scheme-less](//z.example/p.png)',
          '',
          '<img src="https://y.example/h.png" alt="Raw">',
          '',
          '<p>Inline <img src="http://w.example/i.png" alt="In"> here</p>',
          '',
        ].join('\n'),
      )
    ).get('word/document.xml')!;

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchRemoteImage).not.toHaveBeenCalled();
    expect(readImageAsDataUri).not.toHaveBeenCalled();
    expect(count(xml, /<w:drawing>/g)).toBe(0);
    expect(xml).toContain('Remote chart');
    expect(xml).toContain('Scheme-less');
  });

  it('turns a local SVG into a PNG only, at the SVG\'s own size (Ruling 315)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"></svg>';
    vi.mocked(readImageAsDataUri).mockResolvedValueOnce(`data:image/svg+xml;base64,${btoa(svg)}`);

    const zip = await parts('![Logo](logo.svg)\n');
    const xml = zip.get('word/document.xml')!;

    expect(svgToPng).toHaveBeenCalledWith(svg, 2);
    expect(xml).toContain('<wp:extent cx="381000" cy="190500"/>');
    expect([...zip.keys()].some((name) => name.endsWith('.svg'))).toBe(false);
    expect(xml).not.toContain('svgBlip');
  });

  it('turns a local webp into a PNG through a data: URI (Ruling 315)', async () => {
    const uri = `data:image/webp;base64,${btoa(String.fromCharCode(...WEBP))}`;
    vi.mocked(readImageAsDataUri).mockResolvedValueOnce(uri);

    const xml = (await parts('![Photo](photo.webp)\n')).get('word/document.xml')!;

    expect(imageToPng).toHaveBeenCalledWith(uri, 4, 3);
    expect(count(xml, /<w:drawing>/g)).toBe(1);
  });

  it('leaves an untitled doc\'s relative images out, but embeds absolute ones', async () => {
    const xml = (await parts('', doc('![Rel](img/a.png) ![Abs](/abs/d.png)\n', null, 'Untitled-1'))).get('word/document.xml')!;

    expect(readImageAsDataUri).toHaveBeenCalledTimes(1);
    expect(readImageAsDataUri).toHaveBeenCalledWith('/abs/d.png');
    expect(count(xml, /<w:drawing>/g)).toBe(1);
    expect(xml).toContain('Rel');
  });
});

describe('exportDocx', () => {
  beforeEach(() => {
    vi.mocked(save).mockResolvedValue('/out/doc.docx');
  });

  function written(): Map<string, string> {
    const [, base64] = vi.mocked(writeBinaryFile).mock.calls[0]!;
    return unzip(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  }

  it('offers <name>.docx next to the doc and writes the file there, atomically through Rust (Ruling 314)', async () => {
    await exportDocx(doc('# Title\n'));

    expect(save).toHaveBeenCalledWith({
      defaultPath: '/notes/doc.docx',
      filters: [{ name: 'Word document', extensions: ['docx'] }],
    });
    expect(writeBinaryFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeBinaryFile).mock.calls[0]![0]).toBe('/out/doc.docx');
    expect(written().get('word/document.xml')).toContain('Title');
    expect(message).not.toHaveBeenCalled();
  });

  it('strips the Markdown extension for an untitled doc too', async () => {
    vi.mocked(save).mockResolvedValue(null);
    await exportDocx(doc('x', null, 'Untitled-3'));
    expect(vi.mocked(save).mock.calls[0]![0]!.defaultPath).toBe('Untitled-3.docx');
  });

  it('writes nothing when the dialog is cancelled', async () => {
    vi.mocked(save).mockResolvedValue(null);
    await exportDocx(doc('x'));
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(claimPath).not.toHaveBeenCalled();
  });

  it.each([
    ['open in this window', () => void createDoc({ path: '/out/doc.docx', raw: 'open', hash: 'h', mode: 'edit' })],
    ['being opened here', () => void opening.add('/out/doc.docx')],
    ['open in another window', () => void vi.mocked(claimPath).mockResolvedValueOnce('w-2')],
  ])('refuses a file %s (Ruling 314)', async (_name, arrange) => {
    arrange();
    await exportDocx(doc('# Title\n'));

    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith('That file is open in Lintel. Choose another name.', { title: 'Lintel', kind: 'error' });
  });

  it('holds the claim while it writes, then releases it, even when the write fails', async () => {
    vi.mocked(writeBinaryFile).mockImplementationOnce(async (path) => {
      expect(opening.has(path)).toBe(true);
      throw new Error('This file is read-only.');
    });
    await expect(exportDocx(doc('# Title\n'))).rejects.toThrow('This file is read-only.');

    expect(claimPath).toHaveBeenCalledWith('/out/doc.docx');
    expect(releasePath).toHaveBeenCalledWith('/out/doc.docx');
    expect(opening.size).toBe(0);
  });

  it('says after writing when an untitled doc\'s relative images were left out', async () => {
    await exportDocx(doc('![Rel](img/a.png)\n', null, 'Untitled-1'));

    expect(writeBinaryFile).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenCalledWith('Save the document first to embed its local images.', {
      title: 'Export as Word',
      kind: 'info',
    });
    expect(vi.mocked(writeBinaryFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(message).mock.invocationCallOrder[0]!);
  });
});
