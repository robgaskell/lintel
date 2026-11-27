import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { message, save } from '@tauri-apps/plugin-dialog';
import { createDoc, docs, opening, type DocState } from '../docs/store.svelte';
import { claimPath, fetchRemoteImage, readImageAsDataUri, releasePath, writeBinaryFile } from '../ipc';
import { renderMermaidToSvg } from '../render/mermaid';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildDocx, exportDocx } from './docx';
import { gateDocx, OUTSIDE_CONTENT } from './docxGate';
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
// The real gate, spied on so input-layer tests can turn it off (Ruling 335).
vi.mock('./docxGate', async (importOriginal) => {
  const real = await importOriginal<typeof import('./docxGate')>();
  return { ...real, gateDocx: vi.fn(real.gateDocx) };
});
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


// The verifier's round-2 vectors (Ruling 335): each hides a link from a node read alone.
const JOINED_VECTORS: [string, string][] = [
  ['xmp comment', 'x <xmp><!-- </xmp><a href=//evil-xmpc/x>t</a> --></xmp> y'],
  ['noscript comment', 'x <noscript><!-- </noscript><a href=//evil-nsc/x>t</a> --></noscript> y'],
  ['iframe comment', 'x <iframe><!-- </iframe><a href=//evil-ifc/x>t</a> --></iframe> y'],
  ['noembed comment', 'x <noembed><!-- </noembed><a href=//evil-nec/x>t</a> --></noembed> y'],
  ['noframes comment', 'x <noframes><!-- </noframes><a href=//evil-nfc/x>t</a> --></noframes> y'],
  ['textarea comment', 'x <textarea><!-- </textarea><a href=//evil-tac/x>t</a> --></textarea> y'],
  ['title comment', 'x <title><!-- </title><a href=//evil-tic/x>t</a> --></title> y'],
  ['style comment', 'x <style><!-- </style><a href=//evil-stc/x>t</a> --></style> y'],
  ['xmp attribute', 'x <xmp><i title="</xmp><a href=//evil-xmpa/x>t</a>">u</i></xmp> y'],
  ['noscript attribute', 'x <noscript><i title="</noscript><a href=//evil-nsa/x>t</a>">u</i></noscript> y'],
  ['xmp UNC image', 'x <xmp><!-- </xmp><img src="\\\\evil-xmpimg\\x.png" alt=I> --></xmp> y'],
  ['xmp remote image', 'x <xmp><!-- </xmp><img src="https://evil-xmpimgr/x.png" alt=I> --></xmp> y'],
  ['noscript block', '<div><noscript><p title="</noscript><a href=//evil-nsb/x>t</a>"></p></noscript></div>'],
  ['math style', '<div><math><style><a title="</style><a href=//evil-mathsa/x>t</a>">u</a></style></math></div>'],
  ['mglyph', '<div><form><math><mtext></form><form><mglyph><style></math><a href=//evil-mglyph/x>t</a></style></mglyph></form></mtext></math></form></div>'],
  ['math CDATA', '<p><math><![CDATA[</math><a href=//evil-cdm/x>t</a>]]></math></p>'],
  ['a NUL in the scheme', '<p><a href="fi\u0000le://evil-nul/x">t</a></p>'],
];

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
    expect(zip.get('word/numbering.xml')).toContain('\u2610');
    expect(zip.get('word/numbering.xml')).toContain('\u2611');
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
          '<img src="https://y.example/h.png" alt="RawAltBlock">',
          '',
          '<p>Inline <img src="http://w.example/i.png" alt="RawAltInline"> here</p>',
          '',
          'Para with <img src="https://z.example/q.png" alt="RawAltInPara"> mixed.',
          '',
          "<img alt='Tom &amp; Jerry' SRC=//v.example/t.png>",
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
    // Raw HTML images too (Ruling 325).
    for (const alt of ['RawAltBlock', 'RawAltInline', 'RawAltInPara', 'Tom &amp; Jerry']) expect(xml, alt).toContain(alt);
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

  it('turns a raw HTML local SVG into a PNG only too (Ruling 327)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><image href="https://t.example/x.png"/></svg>';
    vi.mocked(readImageAsDataUri).mockResolvedValueOnce(`data:image/svg+xml;base64,${btoa(svg)}`);

    const zip = await parts('<p>Logo <img src="logo.svg" alt="L"></p>\n');

    expect(count(zip.get('word/document.xml')!, /<w:drawing>/g)).toBe(1);
    expect([...zip.keys()].some((name) => name.endsWith('.svg'))).toBe(false);
    expect([...zip.values()].join('\n')).not.toContain('t.example');
  });

  it('shows a diagram at its own width and height when it states them, not its viewBox (Ruling 326)', async () => {
    vi.mocked(renderMermaidToSvg).mockResolvedValueOnce('<svg width="512" height="256" viewBox="0 0 24 24"></svg>');
    const xml = (await parts('```mermaid\ngraph TD; A\n```\n')).get('word/document.xml')!;
    expect(xml).toContain('<wp:extent cx="4876800" cy="2438400"/>');
  });

  it('breaks code block lines inside one paragraph (Ruling 327)', async () => {
    const xml = (await parts('```\nline one\nline two\n```\n')).get('word/document.xml')!;
    const paragraph = [...xml.matchAll(/<w:p>(?:(?!<\/w:p>).)*<\/w:p>/gs)].map(([p]) => p).find((p) => p.includes('line one'))!;
    expect(paragraph).toMatch(/line one<\/w:t>.*<w:br\/><w:t[^>]*>line two</s);
  });

  it.each([
    ['a list item', '- item\n\n  ```\n  CODE\n  ```\n', 'w:left="400" w:right="0"'],
    ['a nested list item', '- a\n  - b\n\n    ```\n    CODE\n    ```\n', 'w:left="800" w:right="0"'],
    ['a quote', '> ```\n> CODE\n> ```\n', 'w:left="720" w:right="720"'],
  ])('indents a code block in %s as its text (Ruling 327)', async (_name, text, indent) => {
    const xml = (await parts(text)).get('word/document.xml')!;
    const paragraph = [...xml.matchAll(/<w:p>(?:(?!<\/w:p>).)*<\/w:p>/gs)].map(([p]) => p).find((p) => p.includes('CODE'))!;
    expect(paragraph).toContain(`<w:ind ${indent}/>`);
  });

  it('keeps bold, italic, strike and link styles on inline code (Ruling 327)', async () => {
    const xml = (await parts('**`b1`** *`i1`* ~~`s1`~~ [`l1`](https://x.example/)\n')).get('word/document.xml')!;
    const run = (text: string) => [...xml.matchAll(/<w:r>(?:(?!<\/w:r>).)*<\/w:r>/gs)].map(([r]) => r).find((r) => r.includes(`>${text}<`))!;
    expect(run('b1')).toContain('<w:b/>');
    expect(run('i1')).toContain('<w:i/>');
    expect(run('s1')).toContain('<w:strike/>');
    expect(run('l1')).toContain('<w:rStyle w:val="Hyperlink"/>');
    expect(run('l1')).toContain('Consolas');
  });

  it('leaves no local path in the file (Ruling 327, as 319)', async () => {
    vi.mocked(readImageAsDataUri).mockImplementation(async (path) => {
      throw `Could not read ${path}: No such file or directory`;
    });
    const text = '![Chart](img/a.png) ![](/Users/alice/private/b.png) <img src="c.png" alt="C">\n';
    const zip = await parts(text, doc(text, '/Users/alice/notes/doc.md'));

    const all = [...zip.values()].join('\n');
    expect(all).not.toContain('/Users/alice');
    expect(all).not.toContain('Could not read');
    expect(zip.get('word/document.xml')).toContain('Chart');
  });
});

describe('buildDocx links (Ruling 324)', () => {
  it('keeps web, mail, relative and in-document links, and leaves network paths, file: and other schemes as text', async () => {
    const text = [
      String.raw`[unc](\\\\evil-md\\share)`,
      String.raw`[mixed](/\\evil-mix/x)`,
      '[nw](//evil-nw/x)',
      '[fs](file://evil-file/share/x)',
      '[fsl](file:///Users/rob/secret.txt)',
      '[js](javascript:alert(1))',
      '[smb](smb://evil-smb/x)',
      '[pct](%5C%5Cevil-pct%5Cx)',
      '[ref][r]',
      '<file://evil-auto/x>',
      '[web](https://example.com/) [mail](mailto:a@example.com) [rel](other%20file.md) [top](#intro)',
      'Inline <a href="file://evil-inline/x">h0</a> raw.',
      '',
      '<p><a href="\\\\evil-html\\share">h1</a> <a href="file://evil-html2/s">h2</a>',
      "<a HREF='&#102;ile://evil-ent/x'>h3</a> <a href=//evil-unq/x>h4</a>",
      '<a title=">" href="file://evil-title/x">h5</a> <a href=" file://evil-space/x">h6</a>',
      '<a title="href=file://evil-copy/x" href=file://evil-copy/x>h7</a>',
      '</p>',
      '',
      '<p><a href="https://raw.example/">rawweb</a></p>',
      '',
      '# Intro',
      '',
      '[r]: file://evil-ref/x',
      '',
    ].join('\n');
    const zip = await parts(text);
    const rels = zip.get('word/_rels/document.xml.rels')!;
    const xml = zip.get('word/document.xml')!;

    expect(rels).not.toMatch(/evil|secret|javascript|smb:/i);
    for (const target of ['https://example.com/', 'mailto:a@example.com', 'other%20file.md', 'https://raw.example/']) {
      expect(rels, target).toContain(`Target="${target}"`);
    }
    const shown = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(([, t]) => t).join('');
    for (const label of ['unc', 'mixed', 'nw', 'fs', 'fsl', 'js', 'smb', 'pct', 'ref', 'h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']) {
      expect(shown, label).toMatch(new RegExp(`\\b${label}\\b`));
    }
    expect(xml).toMatch(/<w:hyperlink [^>]*w:anchor="/);
  });
});

describe('buildDocx links fail closed (Ruling 330)', () => {
  async function rels(text: string) {
    return (await parts(text)).get('word/_rels/document.xml.rels')!;
  }

  it.each([
    ['an unbalanced quote in a value', "<p><a href=//evil-unbal'x>t</a></p>"],
    ['an unbalanced quote inline', "Para <a href=//evil-unbali'x>t</a> end"],
    ['a quote in an attribute name', '<p><a x" href=//evil-qname/x>t</a></p>'],
    ['a single quote in an attribute name', "<p><a x' href=//evil-qname2/x>t</a></p>"],
    ['a safe href before an unsafe one', '<p><a href="https://ok.example/" href="//evil-dup/x">t</a></p>'],
    ['a no-break space', '<p><a href="\u00a0//evil-nbsp/x">t</a></p>'],
    ['a malformed escape in raw HTML', '<p><a href="%5C%5Cevil-hpct%5Cx%ZZ">t</a></p>'],
    ['a malformed escape', '[t](%5C%5Cevil-pct%5Cx%ZZ)'],
    ['a malformed UTF-8 escape', '[t](%5C%5Cevil-utf%5Cx%E0)'],
    ['a twice-encoded path', '[t](%255C%255Cevil-dpct/x)'],
    ['fullwidth backslashes', '[t](\uff3c\uff3cevil-fw\\x)'],
    ['fullwidth slashes', '[t](\uff0f\uff0fevil-fws/x)'],
    ['an ideographic space', '<p><a href="\u3000//evil-ideo/x">t</a></p>'],
    ['the first of two definitions', '[t][rd]\n\n[rd]: //evil-refdup/x\n[rd]: https://ok.example/'],
  ])('leaves no link for %s', async (_name, text) => {
    expect(await rels(text)).not.toMatch(/evil/);
  });

  it('uses the first of two definitions, as remark-docx does', async () => {
    expect(await rels('[t][rd]\n\n[rd]: https://ok.example/\n[rd]: //evil-second/x\n')).toContain('Target="https://ok.example/"');
  });

  it('keeps a safe raw HTML link inside a paragraph', async () => {
    expect(await rels('Para <a href="https://ok.example/">t</a> end\n')).toContain('Target="https://ok.example/"');
  });

  it('drops javascript: in a plain paragraph, away from any raw HTML (E6)', async () => {
    const zip = await parts('[js](javascript:alert(1))\n');
    expect(zip.get('word/_rels/document.xml.rels')).not.toContain('javascript');
    expect(zip.get('word/document.xml')).toContain('>js<');
  });

  it('shows a remote raw image\'s alt as text, never as markup (M2d)', async () => {
    const zip = await parts('<p><img src="https://x.example/y.png" alt="<a href=//evil-alt/x>A</a>"></p>\n');
    expect(zip.get('word/_rels/document.xml.rels')).not.toMatch(/evil/);
    expect(zip.get('word/document.xml')).toContain('&lt;a href=//evil-alt/x&gt;A&lt;/a&gt;');
  });

  it('shows a raw image on a network path or file: URL as its alt text, and never reads it', async () => {
    const xml = (await parts('<p><img src="\\\\evil-unc\\x.png" alt="UNCALT"> <img src="file://evil-f/x.png" alt="FILEALT"></p>\n')).get(
      'word/document.xml',
    )!;
    expect(readImageAsDataUri).not.toHaveBeenCalled();
    expect(xml).toContain('UNCALT');
    expect(xml).toContain('FILEALT');
    expect(xml).not.toMatch(/evil/);
  });
});

describe('buildDocx inline SVG (Ruling 330)', () => {
  it('draws an inline raw <svg> as a PNG only', async () => {
    const zip = await parts(
      '<p>Logo <svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><image href="https://t.example/x.png"/></svg></p>\n',
    );

    expect(vi.mocked(svgToPng).mock.calls[0]?.[0]).toMatch(/^<svg[^>]*width="40"/);
    expect(count(zip.get('word/document.xml')!, /<w:drawing>/g)).toBe(1);
    expect([...zip.keys()].some((name) => name.endsWith('.svg'))).toBe(false);
    expect([...zip.values()].join('\n')).not.toContain('t.example');
  });

  it('draws a raw <img> with an SVG data: URI as a PNG only', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><use href="https://u.example/x.svg#a"/></svg>';
    const zip = await parts(`<p><img src="data:image/svg+xml;base64,${btoa(svg)}" alt="D"></p>\n`);

    expect(count(zip.get('word/document.xml')!, /<w:drawing>/g)).toBe(1);
    expect([...zip.keys()].some((name) => name.endsWith('.svg'))).toBe(false);
    expect([...zip.values()].join('\n')).not.toContain('u.example');
  });
});

describe('Word links and images through both layers (Ruling 335)', () => {
  const external = (rels: string) => [...rels.matchAll(/<Relationship [^>]*TargetMode="External"[^>]*>/g)].map(([r]) => r);

  it.each(JOINED_VECTORS)('ends with no outside link or read for %s', async (_name, text) => {
    const rels = (await parts(`${text}\n`)).get('word/_rels/document.xml.rels')!;
    expect(external(rels).join('\n')).not.toMatch(/evil/);
    expect(readImageAsDataUri).not.toHaveBeenCalled();
  });

  it.each(JOINED_VECTORS)('needs no output gate for %s: the input layer alone stops it', async (_name, text) => {
    vi.mocked(gateDocx).mockImplementationOnce(async (bytes) => bytes);
    const rels = (await parts(`${text}\n`)).get('word/_rels/document.xml.rels')!;
    expect(external(rels).join('\n')).not.toMatch(/evil/);
  });

  it('turns raw HTML the parser reads differently from its text into that text (count mismatch)', async () => {
    vi.mocked(gateDocx).mockImplementationOnce(async (bytes) => bytes);
    const text = [
      'x <noscript><!-- </noscript><a href=//evil-cm1/x>shown</a> --></noscript> y',
      '',
      '<div><form><math><mtext></form><form><mglyph><style></math><a href=//evil-cm2/x>t</a></style></mglyph></form></mtext></math></form></div>',
      '',
    ].join('\n');
    const zip = await parts(text);
    expect(zip.get('word/_rels/document.xml.rels')).not.toMatch(/evil/);
    expect(zip.get('word/document.xml')).not.toMatch(/<w:hyperlink /);

    // Fail closed: text that spells more hrefs than the parser finds is read as plain text.
    const bold = (await parts('<p><b title="see href=x">bold</b></p>\n')).get('word/document.xml')!;
    const run = [...bold.matchAll(/<w:r>(?:(?!<\/w:r>).)*<\/w:r>/gs)].map(([r]) => r).find((r) => r.includes('>bold<'))!;
    expect(run).not.toContain('<w:b/>');
  });

  it('draws an inline <svg> split over a paragraph\'s nodes whole', async () => {
    const zip = await parts('Logo <svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg> end\n');
    expect(vi.mocked(svgToPng).mock.calls[0]?.[0]).toContain('<rect');
    expect(count(zip.get('word/document.xml')!, /<w:drawing>/g)).toBe(1);
  });

  it('shows an inline <svg> with text inside as that text, never a blank picture', async () => {
    const xml = (await parts('Logo <svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text>Hi</text></svg> end\n')).get(
      'word/document.xml',
    )!;
    expect(svgToPng).not.toHaveBeenCalled();
    expect(count(xml, /<w:drawing>/g)).toBe(0);
    expect(xml).toContain('Hi');
  });
});

describe('the output gate (Ruling 335)', () => {
  const realGate = async (bytes: Uint8Array) => (await vi.importActual<typeof import('./docxGate')>('./docxGate')).gateDocx(bytes);

  async function built(text: string) {
    vi.mocked(gateDocx).mockImplementationOnce(async (bytes) => bytes);
    return unzipSync(await buildDocx(doc(text)));
  }

  function edit(files: Record<string, Uint8Array>, name: string, change: (xml: string) => string) {
    files[name] = strToU8(change(strFromU8(files[name]!)));
  }

  it('removes an unsafe hyperlink put straight into a built file, and keeps its text', async () => {
    const files = await built('[safe](https://ok.example/) and [web](https://web.example/)\n');
    edit(files, 'word/_rels/document.xml.rels', (xml) => xml.replace('https://ok.example/', '\\\\evil-inj\\share'));

    const out = unzip(await realGate(zipSync(files)));

    expect(out.get('word/_rels/document.xml.rels')).not.toMatch(/evil/);
    expect(out.get('word/_rels/document.xml.rels')).toContain('Target="https://web.example/"');
    const xml = out.get('word/document.xml')!;
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(count(xml, /<w:hyperlink /g)).toBe(1);
    expect(xml).toContain('>safe<');
  });

  it('removes an unsafe hyperlink from footnotes too', async () => {
    const files = await built('Note[^1].\n\n[^1]: See [it](https://ok.example/).\n');
    edit(files, 'word/_rels/footnotes.xml.rels', (xml) => xml.replace('https://ok.example/', '//evil-fn/x'));
    const out = unzip(await realGate(zipSync(files)));
    expect(out.get('word/_rels/footnotes.xml.rels')).not.toMatch(/evil/);
    expect(out.get('word/footnotes.xml')).not.toMatch(/<w:hyperlink /);
  });

  it('returns the same bytes when there is nothing to remove', async () => {
    const bytes = zipSync(await built('[web](https://web.example/)\n'));
    expect(await realGate(bytes)).toBe(bytes);
  });

  it.each([
    ['an outside image', 'word/_rels/document.xml.rels', 'image'],
    ['an outside template', 'word/_rels/settings.xml.rels', 'attachedTemplate'],
    ['an outside frame', 'word/_rels/document.xml.rels', 'frame'],
  ])('stops the export for %s', async (_name, rels, type) => {
    const files = await built('Text.\n');
    const entry = `<Relationship Id="rId999" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="https://evil.example/x" TargetMode="External"/>`;
    files[rels] ??= strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    edit(files, rels, (xml) => xml.replace('</Relationships>', `${entry}</Relationships>`));
    await expect(realGate(zipSync(files))).rejects.toThrow(OUTSIDE_CONTENT);
  });

  it.each([
    ['INCLUDEPICTURE', ' INCLUDEPICTURE "https://evil.example/x.png" '],
    ['an unsafe HYPERLINK', ' HYPERLINK "\\\\evil-field\\x" '],
  ])('stops the export for a field: %s', async (_name, instruction) => {
    const files = await built('Text.\n');
    edit(files, 'word/document.xml', (xml) =>
      xml.replace('<w:body>', `<w:body><w:p><w:r><w:instrText>${instruction}</w:instrText></w:r></w:p>`),
    );
    await expect(realGate(zipSync(files))).rejects.toThrow(OUTSIDE_CONTENT);
  });

  it('runs on every build, and its result is the file', async () => {
    const marker = new Uint8Array([1, 2, 3]);
    vi.mocked(gateDocx).mockResolvedValueOnce(marker);
    expect(await buildDocx(doc('Text.\n'))).toBe(marker);
  });

  it('stops exportDocx before anything is written', async () => {
    vi.mocked(save).mockResolvedValue('/out/doc.docx');
    vi.mocked(gateDocx).mockRejectedValueOnce(new Error(OUTSIDE_CONTENT));
    await expect(exportDocx(doc('Text.\n'))).rejects.toThrow(OUTSIDE_CONTENT);
    expect(writeBinaryFile).not.toHaveBeenCalled();
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

    expect(claimPath).toHaveBeenCalledWith('/out/doc.docx', { reveal: false });
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
