import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message, save } from '@tauri-apps/plugin-dialog';
import { createDoc, docs, opening, type DocState } from '../docs/store.svelte';
import { claimPath, fetchRemoteImage, readImageAsDataUri, releasePath, writeTextFile } from '../ipc';
import { DEFAULT_SETTINGS, settings, type Settings } from '../settings/settings.svelte';
import { applyTheme } from '../theme/theme';
import { buildStandaloneHtml, exportHtml } from './html';

vi.mock('../ipc', () => ({
  readImageAsDataUri: vi.fn(),
  fetchRemoteImage: vi.fn(),
  writeTextFile: vi.fn(async () => 'hash'),
  normalizePath: vi.fn(async (path: string) => path),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  setWindowAppearance: vi.fn(async () => {}),
}));
vi.mock('../settings/settings.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings/settings.svelte')>()),
  updateSettings: vi.fn(async () => {}),
}));
vi.mock('../os/open', () => ({ openPaths: vi.fn() }));
vi.mock('../os/platform', () => ({ currentPlatform: vi.fn(() => 'macos') }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(async () => {}), save: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ setBackgroundColor: async () => {} }),
}));
// Real mermaid cannot lay out under jsdom. Its SVGs carry their own <style>, as real ones do.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
let mermaidTheme: string | undefined;

const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5));

function doc(text: string, path: string | null = '/notes/doc.md', title = 'doc.md'): DocState {
  return { id: `doc-${Math.random()}`, path, title, text } as DocState;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const light = () => buildStandaloneHtml(doc(SAMPLE), { theme: 'light' });

const SAMPLE = [
  '---',
  'title: Plan',
  '---',
  '# Intro',
  '',
  'Text with `code` and [a link](#Intro).',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '![Chart](img/a.png)',
  '',
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  docs.clear();
  opening.clear();
  settings.remoteImages = 'ask';
  applyTheme({ ...structuredClone(DEFAULT_SETTINGS), theme: 'light' } as Settings);
  vi.mocked(readImageAsDataUri).mockImplementation((path) => later(`data:image/png;base64,${btoa(path)}`));
  vi.mocked(fetchRemoteImage).mockImplementation((url) => later(`data:image/png;base64,${btoa(url)}`));
  mermaid.initialize.mockImplementation((config: { theme?: string }) => (mermaidTheme = config.theme));
  mermaid.render.mockImplementation(async (id: string, src: string) =>
    later({
      svg:
        `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><style>#${id} .edge{stroke:red}</style>` +
        `<g class="edge"><text>${mermaidTheme}:${src.trim()}</text></g></svg>`,
    }),
  );
});

describe('buildStandaloneHtml', () => {
  it('is one HTML file with a CSP that loads nothing, and no script', async () => {
    const html = await light();

    expect(html.startsWith('<!doctype html>\n')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    const page = parse(html);
    const csp = page.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(csp?.getAttribute('content')).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    // Before the style, so it covers everything after it.
    expect(page.head.firstElementChild?.getAttribute('charset')).toBe('utf-8');
    expect(page.head.children[1]).toBe(csp);
    expect(page.title).toBe('doc');
  });

  it('has one document <style> with the light variables, tokens, highlight and article CSS, plus each diagram\'s own (Ruling 306)', async () => {
    const page = parse(await light());

    expect(page.head.querySelectorAll('style')).toHaveLength(1);
    expect(page.querySelectorAll('style')).toHaveLength(1 + page.querySelectorAll('svg').length);
    const css = page.head.querySelector('style')!.textContent!;
    expect(css).toContain(`--bg: ${settings.palettes.light.background};`);
    expect(css).toContain('--scheme: light;');
    expect(css).toContain('--preview-code-keyword: #1d4ed8;');
    expect(css).toContain('.hljs-keyword');
    expect(css).toMatch(/\.article\.reading \.page \{\s*max-width: 720px;/);
    expect(css).toMatch(/\.article \.front-matter \{/);
    expect(page.documentElement.dataset.theme).toBe('light');
  });

  it('leaves out the app chrome, so the page scrolls (Ruling 306)', async () => {
    const css = parse(await light()).head.querySelector('style')!.textContent!;

    expect(css).not.toContain('overflow: hidden');
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).not.toContain('.notice');
    expect(css).not.toContain('.preview-frame');
    expect(css).toMatch(/body \{\s*margin: 0;\s*\}/);
  });

  it('is the Read-mode render: front matter, highlighted code, a table, diagrams and the image', async () => {
    const page = parse(await light());

    expect(page.querySelector('.article.reading .page')).not.toBeNull();
    expect(page.querySelector('.front-matter')!.textContent).toContain('Plan');
    expect(page.querySelector('pre code.hljs .hljs-keyword')!.textContent).toBe('const');
    expect(page.querySelector('table td')!.textContent).toBe('1');
    expect(page.querySelector('img')!.getAttribute('src')).toBe(`data:image/png;base64,${btoa('/notes/img/a.png')}`);
    expect(readImageAsDataUri).toHaveBeenCalledWith('/notes/img/a.png');
    const svgs = [...page.querySelectorAll('.mermaid-diagram svg')];
    expect(svgs).toHaveLength(2);
    expect(svgs[0].textContent).toContain('default:graph TD; A-->B');
    // The same diagram twice: its ids, and the style rules keyed on them, stay apart.
    expect(new Set(svgs.map((svg) => svg.id)).size).toBe(2);
    expect(svgs[1].querySelector('style')!.textContent).toContain(`#${svgs[1].id} .edge`);
  });

  it('uses the dark palette, tokens and diagrams for the dark theme', async () => {
    const page = parse(await buildStandaloneHtml(doc(SAMPLE), { theme: 'dark' }));

    expect(page.documentElement.dataset.theme).toBe('dark');
    const css = page.head.querySelector('style')!.textContent!;
    expect(css).toContain(`--bg: ${settings.palettes.dark.background};`);
    expect(css).toContain("[data-theme='dark']");
    expect(page.querySelector('.mermaid-diagram svg')!.textContent).toContain('dark:graph TD');
  });

  it('points #fragment links at heading ids and keeps file links as written (Ruling 308)', async () => {
    const text = '# Intro\n\n## Next Part\n\n[a](#Intro) [b](#next-part) [c](#nowhere) [rel](other.md) [ext](https://example.com/)\n';
    const links = [...parse(await buildStandaloneHtml(doc(text), { theme: 'light' })).querySelectorAll('.content a')];

    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#h-intro',
      '#h-next-part',
      '#nowhere',
      'other.md',
      'https://example.com/',
    ]);
  });

  it('leaves an untitled doc\'s relative images as alt boxes, but embeds absolute ones', async () => {
    const page = parse(await buildStandaloneHtml(doc('![Rel](img/a.png) ![Abs](/abs/d.png)\n', null, 'Untitled-1'), { theme: 'light' }));

    expect(page.querySelector('.image-alt')!.textContent).toBe('Rel');
    expect(page.querySelectorAll('img')).toHaveLength(1);
    expect(readImageAsDataUri).toHaveBeenCalledTimes(1);
    expect(readImageAsDataUri).toHaveBeenCalledWith('/abs/d.png');
  });

  it('escapes the title', async () => {
    const html = await buildStandaloneHtml(doc('x', '/n/a<b>&.md', 'a<b>&.md'), { theme: 'light' });
    expect(html).toContain('<title>a&lt;b&gt;&amp;</title>');
  });
});

describe('buildStandaloneHtml privacy (Ruling 307)', () => {
  beforeEach(() => {
    // Even when the app would load them, the export never fetches remote images.
    settings.remoteImages = 'load';
  });

  // Every attribute that names the remote host may only be a link's href.
  function expectNothingRemote(html: string) {
    const page = parse(html);
    for (const el of page.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        if (!attr.value.includes('x.example')) continue;
        expect(`${el.localName} ${attr.name}`).toBe('a href');
      }
    }
    for (const img of page.querySelectorAll('img')) expect(img.getAttribute('src')).toMatch(/^data:/);
    expect(html).not.toMatch(/@import|url\(\s*['"]?https?:/i);
    expect(fetchRemoteImage).not.toHaveBeenCalled();
  }

  it('turns remote images into links showing the alt text or the address', async () => {
    const text = '![Far](https://x.example/b.png) ![](//x.example/c.png) [![Badge](https://x.example/d.svg)](https://example.com/)\n';
    const html = await buildStandaloneHtml(doc(text), { theme: 'light' });

    const links = [...parse(html).querySelectorAll('.content a')].map((a) => [a.getAttribute('href'), a.textContent]);
    expect(links).toEqual([
      ['https://x.example/b.png', 'Far'],
      ['https://x.example/c.png', 'https://x.example/c.png'],
      // Inside a link, the image's text joins the link it is in.
      ['https://example.com/', 'Badge'],
    ]);
    expect(parse(html).querySelector('img')).toBeNull();
    expectNothingRemote(html);
  });

  // The pre-flight's probe: what the sanitiser keeps or removes, all loaders of remote content.
  it.each([
    ['img srcset', '<img src="https://x.example/s.png" srcset="https://x.example/s2.png 2x">'],
    ['video src and poster', '<video src="https://x.example/v.mp4" poster="https://x.example/p.png"></video>'],
    ['audio src', '<audio src="https://x.example/a.mp3"></audio>'],
    ['picture source srcset', '<picture><source srcset="https://x.example/p.webp"><img src="q.png"></picture>'],
    ['input type=image', '<input type="image" src="https://x.example/i.png">'],
    ['svg image and use', '<svg><image href="https://x.example/svgimg.png"/><use href="https://x.example/u.svg#a"/></svg>'],
    ['svg xlink:href and feImage', '<svg><image xlink:href="https://x.example/x.png"/><filter id="f"><feImage href="https://x.example/fe.png"/></filter></svg>'],
    [
      'link, meta refresh and base',
      '<link rel="stylesheet" href="https://x.example/s.css"><meta http-equiv="refresh" content="0;url=https://x.example"><base href="https://x.example/">',
    ],
    ['table background', '<table background="https://x.example/bg.png"><tr><td>x</td></tr></table>'],
    ['object, embed and iframe', '<object data="https://x.example/o"></object><embed src="https://x.example/e"><iframe src="https://x.example/f"></iframe>'],
    ['track src and script', '<track src="https://x.example/t.vtt"><script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">j</a>'],
    ['form and svg style @import', '<form action="https://x.example"><input name=a></form><svg><style>@import "https://x.example/x.css";</style></svg>'],
    ['link ping', '<a href="https://example.com/" ping="https://x.example/ping">p</a>'],
  ])('keeps nothing remote from %s', async (_name, markup) => {
    const html = await buildStandaloneHtml(doc(`${markup}\n`), { theme: 'light' });

    expectNothingRemote(html);
    expect(html).not.toMatch(/<(script|iframe|object|embed|base|link|form)\b|\son\w+=|javascript:/i);
  });

  it('never puts a remote-loading attribute into the app page while it renders', async () => {
    const added: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) added.push(node, ...node.querySelectorAll('*'));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      await buildStandaloneHtml(doc('<video src="https://x.example/v.mp4" poster="https://x.example/p.png"></video>\n\n![Far](https://x.example/b.png)\n'), { theme: 'light' });
      await later(null);
    } finally {
      observer.disconnect();
    }
    expect(added.length).toBeGreaterThan(0);
    for (const el of added) {
      for (const attr of el.attributes) {
        if (attr.value.includes('x.example')) expect(`${el.localName} ${attr.name}`).toBe('a href');
      }
    }
  });

  it('keeps data: images as they are', async () => {
    const page = parse(await buildStandaloneHtml(doc('![d](data:image/png;base64,AAAA)\n'), { theme: 'light' }));
    expect(page.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });
});

describe('exportHtml', () => {
  beforeEach(() => {
    vi.mocked(save).mockResolvedValue('/out/doc.html');
  });

  it('offers <name>.html next to the doc and writes the light page there (Ruling 305)', async () => {
    applyTheme({ ...structuredClone(DEFAULT_SETTINGS), theme: 'dark' } as Settings);
    await exportHtml(doc('# Title\n'));

    expect(save).toHaveBeenCalledWith({
      defaultPath: '/notes/doc.html',
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    const [path, html] = vi.mocked(writeTextFile).mock.calls[0];
    expect(path).toBe('/out/doc.html');
    expect(html).toMatch(/^<!doctype html>/);
    expect(parse(html).documentElement.dataset.theme).toBe('light');
    expect(html).toContain(`--bg: ${settings.palettes.light.background};`);
    expect(message).not.toHaveBeenCalled();
  });

  it.each([
    ['/n/READ.MARKDOWN', 'READ.MARKDOWN', '/n/READ.html'],
    [null, 'Untitled-3', 'Untitled-3.html'],
  ])('strips the Markdown extension from %s for the default name', async (path, title, expected) => {
    vi.mocked(save).mockResolvedValue(null);
    await exportHtml(doc('x', path, title));
    expect(vi.mocked(save).mock.calls[0][0]!.defaultPath).toBe(expected);
  });

  it('writes nothing when the dialog is cancelled', async () => {
    vi.mocked(save).mockResolvedValue(null);
    await exportHtml(doc('x'));
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(claimPath).not.toHaveBeenCalled();
  });

  it('refuses a file open in this window (Ruling 309)', async () => {
    createDoc({ path: '/out/doc.html', raw: 'open', hash: 'h', mode: 'edit' });
    await exportHtml(doc('# Title\n'));

    expect(writeTextFile).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith('That file is open in Lintel. Choose another name.', { title: 'Lintel', kind: 'error' });
  });

  it('refuses a file this window is opening (Ruling 309)', async () => {
    opening.add('/out/doc.html');
    await exportHtml(doc('# Title\n'));
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith('That file is open in Lintel. Choose another name.', { title: 'Lintel', kind: 'error' });
  });

  it('refuses a file another window has open (Ruling 309)', async () => {
    vi.mocked(claimPath).mockResolvedValueOnce('w-2');
    await exportHtml(doc('# Title\n'));

    expect(writeTextFile).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith('That file is open in Lintel. Choose another name.', { title: 'Lintel', kind: 'error' });
  });

  it('holds the claim while it writes, then releases it', async () => {
    vi.mocked(writeTextFile).mockImplementationOnce(async (path) => {
      expect(opening.has(path)).toBe(true);
      return 'hash';
    });
    await exportHtml(doc('# Title\n'));

    expect(claimPath).toHaveBeenCalledWith('/out/doc.html');
    expect(releasePath).toHaveBeenCalledWith('/out/doc.html');
    expect(opening.size).toBe(0);
  });

  it('rejects when the write fails, so the menu shows the error, and still releases the claim', async () => {
    vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('This file is read-only.'));
    await expect(exportHtml(doc('# Title\n'))).rejects.toThrow('This file is read-only.');
    expect(releasePath).toHaveBeenCalledWith('/out/doc.html');
    expect(opening.size).toBe(0);
  });

  it('says after writing when an untitled doc\'s relative images were left out (Ruling 308)', async () => {
    await exportHtml(doc('![Rel](img/a.png)\n', null, 'Untitled-1'));

    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenCalledWith('Save the document first to embed its local images.', {
      title: 'Export as HTML',
      kind: 'info',
    });
    expect(vi.mocked(writeTextFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(message).mock.invocationCallOrder[0]);
  });

  it.each([
    ['an untitled doc without relative images', doc('![Abs](/abs/d.png) ![Far](https://x.example/b.png)\n', null, 'Untitled-1')],
    ['a saved doc with relative images', doc('![Rel](img/a.png)\n')],
  ])('says nothing for %s', async (_name, d) => {
    await exportHtml(d);
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(message).not.toHaveBeenCalled();
  });
});
