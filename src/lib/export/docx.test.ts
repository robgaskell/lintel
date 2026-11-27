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

const realGate = async (bytes: Uint8Array) => (await vi.importActual<typeof import('./docxGate')>('./docxGate')).gateDocx(bytes);

/** A built file's parts, before the output gate. */
async function built(text: string) {
  vi.mocked(gateDocx).mockImplementationOnce(async (bytes) => bytes);
  return unzipSync(await buildDocx(doc(text)));
}

function edit(files: Record<string, Uint8Array>, name: string, change: (xml: string) => string) {
  files[name] = strToU8(change(strFromU8(files[name]!)));
}

describe('the output gate (Ruling 335)', () => {
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

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOCUMENT_RELS = 'word/_rels/document.xml.rels';

function wellFormed(xml: string): boolean {
  return new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror').length === 0;
}

/** Each relationship reference (r:id, r:embed and so on) in a part that names no relationship. */
function danglingRefs(files: Map<string, string>): string[] {
  const dangling: string[] = [];
  for (const [name, rels] of files) {
    const match = /^(.*)_rels\/(.+)\.rels$/i.exec(name);
    const part = match && files.get(`${match[1]}${match[2]}`);
    if (!part) continue;
    const ids = new Set([...rels.matchAll(/\sId="([^"]*)"/g)].map(([, id]) => id));
    for (const [ref, id] of part.matchAll(/\sr:\w+="([^"]*)"/g)) if (!ids.has(id!)) dangling.push(`${name}: ${ref.trim()}`);
  }
  return dangling;
}

describe('the output gate, round 4 (Ruling 339)', () => {
  it('writes each part it changes with one XML declaration, even where the browser adds its own', async () => {
    // WebKit and Chromium include the declaration; jsdom does not.
    const native = XMLSerializer.prototype.serializeToString;
    const spy = vi.spyOn(XMLSerializer.prototype, 'serializeToString').mockImplementation(function (this: XMLSerializer, node: Node) {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${native.call(this, node)}`;
    });
    try {
      const files = await built('[safe](https://ok.example/) and [web](https://web.example/)\n');
      edit(files, DOCUMENT_RELS, (xml) => xml.replace('https://ok.example/', '//evil-decl/x'));
      const out = unzipSync(await realGate(zipSync(files)));

      const rewritten = Object.keys(out).filter((name) => strFromU8(out[name]!) !== strFromU8(files[name]!));
      expect(rewritten.sort()).toEqual([DOCUMENT_RELS, 'word/document.xml']);
      for (const name of rewritten) {
        const xml = strFromU8(out[name]!);
        expect(wellFormed(xml), name).toBe(true);
        expect(count(xml, /<\?xml/g), name).toBe(1);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['a linked image', `[![i](data:image/png;base64,${PNG_BASE64})](https://img.example/)\n`],
    ['a raw linked image', `<p><a href="https://img.example/"><img src="data:image/png;base64,${PNG_BASE64}" alt="i"></a></p>\n`],
  ])('leaves nothing pointing at a hyperlink it removes, for %s', async (_name, text) => {
    const files = await built(text);
    expect(strFromU8(files['word/document.xml']!)).toMatch(/<a:hlinkClick /);
    edit(files, DOCUMENT_RELS, (xml) => xml.replace('https://img.example/', '//evil-img/x'));
    const out = unzip(await realGate(zipSync(files)));

    expect(out.get(DOCUMENT_RELS)).not.toMatch(/evil/);
    expect(danglingRefs(out)).toEqual([]);
    expect(out.get('word/document.xml')).not.toMatch(/<a:hlinkClick /);
    expect(count(out.get('word/document.xml')!, /<w:drawing>/g)).toBe(1);
  });

  // The verifier's hand-made packages (round 3), each made from a built file.
  type Files = Record<string, Uint8Array>;
  const get = (f: Files, n: string) => strFromU8(f[n]!);
  const set = (f: Files, n: string, s: string) => void (f[n] = strToU8(s));
  const addRel = (f: Files, n: string, entry: string) => {
    f[n] ??= strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_NS}"></Relationships>`);
    set(f, n, get(f, n).replace(/<Relationships([^>]*?)\/>/, '<Relationships$1></Relationships>').replace('</Relationships>', `${entry}</Relationships>`));
  };
  const rel = (id: string, type: string, target: string, mode = ' TargetMode="External"') =>
    `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"${mode}/>`;
  const body = (f: Files, xml: string, part = 'word/document.xml') => set(f, part, get(f, part).replace(/<w:body>/, `<w:body>${xml}`));
  const fieldRuns = (...pieces: string[]) =>
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>${pieces.map((p) => `<w:r><w:instrText xml:space="preserve">${p}</w:instrText></w:r>`).join('')}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>r</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const field = (instruction: string) => (f: Files) => body(f, fieldRuns(instruction));
  const retarget = (from: string, to: string, n = DOCUMENT_RELS) => (f: Files) => set(f, n, get(f, n).replace(from, to));
  const okTo = (target: string, mode: string) => (f: Files) =>
    set(f, DOCUMENT_RELS, get(f, DOCUMENT_RELS).replace(/Target="https:\/\/ok\.example\/" TargetMode="External"/, `Target="${target}"${mode}`));
  const minPart = (inner: string, root = 'w:document') =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${root} xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${inner}</w:body></${root}>`;
  const internalImage = (target: string) => (f: Files) => {
    set(f, 'word/document.xml', get(f, 'word/document.xml').replace(/r:embed="(rId[^"]*)"/, 'r:embed="rIdX"'));
    addRel(f, DOCUMENT_RELS, rel('rIdX', 'image', target, ''));
  };

  const passed: [string, (f: Files) => void][] = [
    ['A00 nothing to do', () => {}],
    ['A01 an Internal hyperlink to a network path', okTo('//evil-a01/x', '')],
    ['A02 TargetMode with a trailing space', okTo('//evil-a02/x', ' TargetMode="External "')],
    ['A03 TargetMode with a leading space', okTo('//evil-a03/x', ' TargetMode=" External"')],
    ['A04 TargetMode in capitals', okTo('//evil-a04/x', ' TargetMode="EXTERNAL"')],
    ['TargetMode in mixed case with spaces', okTo('//evil-tm/x', ' TargetMode="\texTeRnal "')],
    ['A05 rels with another prefix', (f) => set(f, DOCUMENT_RELS, get(f, DOCUMENT_RELS).replace('https://ok.example/', '//evil-a05/x').replace(/<(\/?)Relationship/g, '<$1pr:Relationship').replace(`xmlns="${PKG_NS}"`, `xmlns:pr="${PKG_NS}"`))],
    ['A06 an entity in the target', retarget('https://ok.example/', '&#x2F;&#x2F;evil-a06/x')],
    ['A07 rels with a byte order mark', (f) => set(f, DOCUMENT_RELS, '\ufeff' + get(f, DOCUMENT_RELS).replace('https://ok.example/', '//evil-a07/x'))],
    ['A09 .RELS in capitals', (f) => { f['word/_rels/document.xml.RELS'] = strToU8(get(f, DOCUMENT_RELS).replace('https://ok.example/', '//evil-a09/x')); delete f[DOCUMENT_RELS]; }],
    ['A11 a glossary hyperlink', (f) => { set(f, 'word/glossary/document.xml', minPart('<w:p><w:hyperlink r:id="rIdG"><w:r><w:t>gl</w:t></w:r></w:hyperlink></w:p>', 'w:glossaryDocument')); addRel(f, 'word/glossary/_rels/document.xml.rels', rel('rIdG', 'hyperlink', '//evil-a11/x')); }],
    ['A12 a footer hyperlink', (f) => { set(f, 'word/footer1.xml', `<?xml version="1.0"?><w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:p><w:hyperlink r:id="rIdF"><w:r><w:t>ft</w:t></w:r></w:hyperlink></w:p></w:ftr>`); addRel(f, 'word/_rels/footer1.xml.rels', rel('rIdF', 'hyperlink', '\\\\evil-a12\\x')); }],
    ['A13 a comments hyperlink', (f) => { set(f, 'word/comments.xml', `<?xml version="1.0"?><w:comments xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:comment w:id="0"><w:p><w:hyperlink r:id="rIdC"><w:r><w:t>cm</w:t></w:r></w:hyperlink></w:p></w:comment></w:comments>`); addRel(f, 'word/_rels/comments.xml.rels', rel('rIdC', 'hyperlink', 'file://evil-a13/x')); }],
    ['A14 an endnotes hyperlink', (f) => { addRel(f, 'word/_rels/endnotes.xml.rels', rel('rIdE', 'hyperlink', '//evil-a14/x')); set(f, 'word/endnotes.xml', get(f, 'word/endnotes.xml').replace(/(<w:endnote [^>]*>)/, '$1<w:p><w:hyperlink r:id="rIdE"><w:r><w:t>en</w:t></w:r></w:hyperlink></w:p>')); }],
    ['A29 a HYPERLINK to a bookmark', field(' HYPERLINK \\l "bm" ')],
    ['HYPERLINK with every switch to a web address', field(' HYPERLINK \\l "bm" \\m \\n \\o "tip" \\t "_blank" "https://ok.example/" ')],
    ['hyperlink in lower case to a web address', field(' hyperlink "https://ok.example/" ')],
    ['HYPERLINK in curly quotes to a web address', field(' HYPERLINK \u201chttps://ok.example/a b\u201d ')],
    ['A44 a linked image to a network path', retarget('https://img.example/', '//evil-a44/x')],
    ['A45 a hlinkClick on its own', (f) => { set(f, 'word/document.xml', get(f, 'word/document.xml').replace(/(<wp:docPr[^>]*?)(\/>|>)/, '$1><a:hlinkClick xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:id="rIdH"/>')); addRel(f, DOCUMENT_RELS, rel('rIdH', 'hyperlink', '//evil-a45/x')); }],
    ['A46 a duplicate relationship id', (f) => addRel(f, DOCUMENT_RELS, rel('rIdDup', 'hyperlink', '//evil-a46/x') + rel('rIdDup', 'hyperlink', 'https://fine.example/'))],
    ['A47 rels with no namespace', (f) => set(f, DOCUMENT_RELS, get(f, DOCUMENT_RELS).replace(`xmlns="${PKG_NS}"`, '').replace('https://ok.example/', '//evil-a47/x'))],
    ['A48 a footnote link to a network path', retarget('https://fn.example/', '//evil-a48/x', 'word/_rels/footnotes.xml.rels')],
    ['A49 a package hyperlink', (f) => addRel(f, '_rels/.rels', rel('rIdP', 'hyperlink', '//evil-a49/x'))],
    ['A51 a content type only', (f) => set(f, '[Content_Types].xml', get(f, '[Content_Types].xml').replace('</Types>', '<Override PartName="/word/links.xml" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'))],
    ['A52 _RELS in capitals', (f) => { set(f, 'word/footer2.xml', `<?xml version="1.0"?><w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:p><w:hyperlink r:id="rIdF"><w:r><w:t>ft</w:t></w:r></w:hyperlink></w:p></w:ftr>`); addRel(f, 'word/_RELS/footer2.xml.rels', rel('rIdF', 'hyperlink', '//evil-a52/x')); }],
  ];

  const stopped: [string, (f: Files) => void][] = [
    ['A10 an outside image in customXml', (f) => { set(f, 'customXml/item1.xml', '<?xml version="1.0"?><root/>'); addRel(f, 'customXml/_rels/item1.xml.rels', rel('rId1', 'image', 'https://evil-a10/x.png')); }],
    ['A15 an outside chart object', (f) => { set(f, 'word/charts/chart1.xml', '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>'); addRel(f, 'word/charts/_rels/chart1.xml.rels', rel('rId1', 'oleObject', 'file:///\\\\evil-a15\\x.xlsx')); }],
    ['A16 an altChunk of HTML inside the file', (f) => { body(f, '<w:altChunk r:id="rIdAC"/>'); addRel(f, DOCUMENT_RELS, rel('rIdAC', 'aFChunk', 'afchunk.htm', '')); set(f, 'word/afchunk.htm', '<html><body><img src="http://evil-a16/x.png"></body></html>'); }],
    ['A17 an outside altChunk', (f) => { body(f, '<w:altChunk r:id="rIdAC"/>'); addRel(f, DOCUMENT_RELS, rel('rIdAC', 'aFChunk', 'http://evil-a17/x.htm')); }],
    ['A18 an outside OLE object', (f) => addRel(f, DOCUMENT_RELS, rel('rIdO', 'oleObject', '\\\\evil-a18\\x.xls'))],
    ['A19 an outside template', (f) => addRel(f, 'word/_rels/settings.xml.rels', rel('rIdT', 'attachedTemplate', 'http://evil-a19/t.dotm'))],
    ['A20 an Internal template with a URL', (f) => { set(f, 'word/settings.xml', get(f, 'word/settings.xml').replace(/(<w:settings[^>]*>)/, '$1<w:attachedTemplate r:id="rIdT"/>')); addRel(f, 'word/_rels/settings.xml.rels', rel('rIdT', 'attachedTemplate', 'http://evil-a20/t.dotm', '')); }],
    ['an outside image beside the file, TargetMode in capitals', (f) => addRel(f, DOCUMENT_RELS, rel('rIdM', 'image', 'evil-up.png', ' TargetMode="EXTERNAL"'))],
    ['an outside image beside the file, TargetMode with spaces', (f) => addRel(f, DOCUMENT_RELS, rel('rIdM', 'image', 'evil-sp.png', ' TargetMode=" External "'))],
    ['an Internal image on a UNC path', internalImage('\\\\evil-iu\\x.png')],
    ['an Internal image on a network path', internalImage('//evil-in/x.png')],
    ['an Internal image at an absolute path', internalImage('/evil-abs/x.png')],
    ['an Internal image on a drive', internalImage('C:\\evil-c\\x.png')],
    ['A21 an outside frame', (f) => { set(f, 'word/webSettings.xml', `<?xml version="1.0"?><w:webSettings xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:frameset><w:frame><w:sourceFileName r:id="rIdW"/></w:frame></w:frameset></w:webSettings>`); addRel(f, 'word/_rels/webSettings.xml.rels', rel('rIdW', 'frame', 'http://evil-a21/f.htm')); }],
    ['A22 a field split over runs', (f) => body(f, fieldRuns('INCLUDEPIC', 'TURE "http://evil-a22/x.png"'))],
    ['A23 a field split over paragraphs', (f) => body(f, fieldRuns(' INCLUDE') + fieldRuns('PICTURE "http://evil-a23/x.png" '))],
    ['A24 a field in lower case', field(' includepicture "http://evil-a24/x.png" \\d ')],
    ['A25 a field in mixed case', field(' IncludeText "\\\\\\\\evil-a25\\\\x.docx" ')],
    ['A26 hyperlink in lower case', field(' hyperlink "\\\\\\\\evil-a26\\\\x" ')],
    ['A27 HYPERLINK with no space', field(' HYPERLINK"\\\\\\\\evil-a27\\\\x" ')],
    ['A28 HYPERLINK with a switch first', field(' HYPERLINK \\o "tip" "\\\\\\\\evil-a28\\\\x" ')],
    ['HYPERLINK with \\l and \\t first', field(' HYPERLINK \\l "bm" \\t "_blank" "//evil-lt/x" ')],
    ['HYPERLINK with \\m and \\n first, no spaces', field(' HYPERLINK\\m\\n"//evil-mn/x" ')],
    ['A30 HYPERLINK in curly quotes', field(' HYPERLINK \u201c\\\\\\\\evil-a30\\\\x\u201d ')],
    ['HYPERLINK in low and high curly quotes', field(' HYPERLINK \u201e//evil-lq/x\u201c ')],
    ['HYPERLINK with a bare address', field(' HYPERLINK //evil-bare/x ')],
    ['A31 a comment inside the instruction', (f) => body(f, '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INCLUDE<!-- c -->PICTURE "http://evil-a31/x.png"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')],
    ['A32 CDATA inside the instruction', (f) => body(f, '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText><![CDATA[INCLUDEPICTURE "http://evil-a32/x.png"]]></w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')],
    ['A33 an instruction with another prefix', (f) => body(f, `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><q:instrText xmlns:q="${W_NS}">INCLUDEPICTURE "http://evil-a33/x.png"</q:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`)],
    ['an instruction in another namespace', (f) => body(f, '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><q:instrText xmlns:q="http://purl.oclc.org/ooxml/wordprocessingml/main">INCLUDEPICTURE "http://evil-ns/x.png"</q:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')],
    ['a HYPERLINK built from a field inside it', (f) => body(f, '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "</w:instrText></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF evil </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:instrText>" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')],
    ['A34 an unknown field (MERGEFIELD)', field(' MERGEFIELD Name ')],
    ['A35 DATABASE', field(' DATABASE \\d "\\\\\\\\evil-a35\\\\db.mdb" \\s "select * from t" ')],
    ['A36 RD', field(' RD "\\\\\\\\evil-a36\\\\x.docx" ')],
    ['A37 INCLUDE', field(' INCLUDE "\\\\\\\\evil-a37\\\\x.docx" ')],
    ['an unknown field', field(' NEWLOADER "//evil-new/x" ')],
    ['A38 fldSimple in lower case', (f) => body(f, '<w:p><w:fldSimple w:instr=" includepicture &quot;http://evil-a38/x.png&quot; "><w:r><w:t>s</w:t></w:r></w:fldSimple></w:p>')],
    ['A39 fldSimple in capitals', (f) => body(f, '<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;http://evil-a39/x.png&quot; "><w:r><w:t>s</w:t></w:r></w:fldSimple></w:p>')],
    ['A40 VML o:href', (f) => body(f, '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" style="width:10pt;height:10pt"><v:imagedata r:id="rId7" o:href="http://evil-a40/x.png"/></v:shape></w:pict></w:r></w:p>')],
    ['A41 VML r:href to an outside image', (f) => { body(f, '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:imagedata r:href="rIdV"/></v:shape></w:pict></w:r></w:p>'); addRel(f, DOCUMENT_RELS, rel('rIdV', 'image', 'http://evil-a41/x.png')); }],
    ['A42 VML v:shape href', (f) => body(f, '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" href="http://evil-a42/" style="width:10pt;height:10pt"/></w:pict></w:r></w:p>')],
    ['A43 a linked picture', (f) => { set(f, 'word/document.xml', get(f, 'word/document.xml').replace(/r:embed="(rId[^"]*)"/, 'r:embed="$1" r:link="rIdL"')); addRel(f, DOCUMENT_RELS, rel('rIdL', 'image', 'http://evil-a43/x.png')); }],
    ['A50 an outside thumbnail', (f) => addRel(f, '_rels/.rels', rel('rIdP', 'metadata/thumbnail', 'http://evil-a50/t.png'))],
  ];

  async function attacked(attack: (f: Files) => void) {
    const files = await built(`[safe](https://ok.example/) and [![i](data:image/png;base64,${PNG_BASE64})](https://img.example/) note[^1].\n\n[^1]: See [fn](https://fn.example/).\n`);
    attack(files);
    return zipSync(files);
  }

  it.each(passed)('passes %s with no outside link and nothing broken', async (_name, attack) => {
    const out = unzip(await realGate(await attacked(attack)));
    for (const [name, text] of out) {
      if (!/\.(xml|rels)$/i.test(name)) continue;
      expect(text, name).not.toMatch(/evil/);
      expect(wellFormed(text), name).toBe(true);
    }
    expect(danglingRefs(out)).toEqual([]);
  });

  it.each(stopped)('stops the export for %s', async (_name, attack) => {
    await expect(realGate(await attacked(attack))).rejects.toThrow(OUTSIDE_CONTENT);
  });
});

describe('raw HTML the input layer cannot rewrite safely (Ruling 339)', () => {
  it('becomes its text when the rewritten HTML reads differently (M8b)', async () => {
    vi.mocked(gateDocx).mockImplementationOnce(async (bytes) => bytes);
    const xml = (await parts('<p><math><svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg></math></p>\n')).get(
      'word/document.xml',
    )!;
    expect(svgToPng).not.toHaveBeenCalled();
    expect(count(xml, /<w:drawing>/g)).toBe(0);
  });

  it('never draws an empty <svg> from a block split by a blank line', async () => {
    const text = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">\n\n<rect width="40" height="20"/></svg>\n';
    const xml = (await parts(text)).get('word/document.xml')!;
    for (const [svg] of vi.mocked(svgToPng).mock.calls) expect(svg).toMatch(/^<svg[^>]*>\s*<\w/);
    expect(count(xml, /<w:drawing>/g)).toBe(0);
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
