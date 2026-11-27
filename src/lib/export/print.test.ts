import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { message } from '@tauri-apps/plugin-dialog';
import type { DocState } from '../docs/store.svelte';
import { createDoc } from '../docs/store.svelte';
import { handleFileChanged } from '../docs/reload';
import { fetchRemoteImage, readImageAsDataUri, readTextFile } from '../ipc';
import { currentPlatform } from '../os/platform';
import { DEFAULT_SETTINGS, settings, type Settings } from '../settings/settings.svelte';
import { applyTheme } from '../theme/theme';
import { renderMarkdown } from '../render/markdown';
import { dropStalePrintRoot, printDoc } from './print';

vi.mock('../ipc', () => ({
  readImageAsDataUri: vi.fn(),
  fetchRemoteImage: vi.fn(),
  readTextFile: vi.fn(),
  setWindowAppearance: vi.fn(async () => {}),
}));
vi.mock('../render/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render/markdown')>();
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});
vi.mock('../settings/settings.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings/settings.svelte')>()),
  updateSettings: vi.fn(async () => {}),
}));
vi.mock('../os/open', () => ({ openPaths: vi.fn() }));
vi.mock('../os/platform', () => ({ currentPlatform: vi.fn(() => 'macos') }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ setBackgroundColor: async () => {} }),
}));
// Real mermaid cannot lay out under jsdom.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
let mermaidTheme: string | undefined;

const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 20));

// What the page held when print was called.
let printed: { root: HTMLElement | null; html: string; connected: boolean }[] = [];
const print = vi.fn(() => {
  const root = document.querySelector<HTMLElement>('.print-root');
  printed.push({ root, html: root?.innerHTML ?? '', connected: root?.isConnected ?? false });
});

let docCount = 0;
function doc(text: string, path: string | null = '/notes/doc.md'): DocState {
  docCount += 1;
  return { id: `doc-${docCount}`, path, title: 'doc.md', text } as DocState;
}

function withTheme(theme: Settings['theme']): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), theme } as Settings;
}

beforeEach(() => {
  vi.clearAllMocks();
  printed = [];
  window.print = print;
  settings.remoteImages = 'ask';
  vi.mocked(readImageAsDataUri).mockImplementation((path) => later(`data:image/png;base64,${btoa(path)}`));
  vi.mocked(fetchRemoteImage).mockImplementation((url) => later(`data:image/png;base64,${btoa(url)}`));
  mermaid.initialize.mockImplementation((config: { theme?: string }) => (mermaidTheme = config.theme));
  mermaid.render.mockImplementation(async (id: string, src: string) =>
    later({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><text>${mermaidTheme}:${src.trim()}</text></svg>` }),
  );
});

// The print sheet has closed: the user pressed a key (Ruling 311).
function endPrint() {
  window.dispatchEvent(new KeyboardEvent('keydown'));
}

afterEach(() => {
  endPrint();
  dropStalePrintRoot(undefined);
  applyTheme(withTheme('light'));
});

describe('printDoc', () => {
  it('prints a root in the page that holds the rendered doc', async () => {
    await printDoc(doc('---\ntitle: Plan\n---\n# Heading one\n\n## Heading two\n\nText.\n'), { pdfHint: false });

    expect(print).toHaveBeenCalledTimes(1);
    const [{ root, html, connected }] = printed;
    expect(connected).toBe(true);
    expect(root!.querySelector('h1')!.textContent).toBe('Heading one');
    expect(root!.querySelector('h2')!.textContent).toBe('Heading two');
    expect(html).toContain('Front matter');
    expect(html).toContain('Plan');
    expect(message).not.toHaveBeenCalled();
  });

  it('draws diagrams and loads images before print is called', async () => {
    const text = '# A\n\n```mermaid\ngraph TD; Print\n```\n\n![Chart](img/c.png)\n';
    await printDoc(doc(text), { pdfHint: false });

    const page = document.createElement('div');
    page.innerHTML = printed[0].html;
    expect(page.querySelector('pre.mermaid-src')).toBeNull();
    expect(page.querySelector('.mermaid-diagram svg')!.textContent).toBe('default:graph TD; Print');
    expect(page.querySelector('img')!.getAttribute('src')).toBe(`data:image/png;base64,${btoa('/notes/img/c.png')}`);
  });

  it('uses the light palette on its root while the app is dark', async () => {
    applyTheme(withTheme('dark'));
    await printDoc(doc('# A\n\n```mermaid\ngraph TD; Dark\n```\n'), { pdfHint: false });

    const root = printed[0].root!;
    expect(root.querySelector('.mermaid-diagram svg')!.textContent).toBe('default:graph TD; Dark');
    const light = settings.palettes.light;
    expect(root.style.getPropertyValue('--bg')).toBe(light.background);
    expect(root.style.getPropertyValue('--text')).toBe(light.text);
    expect(root.style.getPropertyValue('--scheme')).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });

  it('maps the light code colours and preview tokens onto the root, never the dark ones', async () => {
    const { readFileSync } = (await import(/* @vite-ignore */ 'node:fs' as string)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const css = readFileSync('src/lib/theme/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
      selectors: selector.split(',').map((s) => s.trim()),
      body,
    }));
    const forRoot = rules.filter((r) => r.selectors.includes('.print-root'));
    expect(forRoot).toHaveLength(1);
    expect(forRoot[0].selectors).toContain(':root');
    expect(forRoot[0].body).toMatch(/--preview-text: var\(--text\);/);
    expect(forRoot[0].body).toMatch(/--preview-code-keyword: #1d4ed8;/);
    expect(forRoot[0].body).toMatch(/color-scheme: light;/);
  });

  it('makes every print override win whatever order the stylesheets load in (Ruling 301)', async () => {
    const { readFileSync } = (await import(/* @vite-ignore */ 'node:fs' as string)) as {
      readFileSync(path: string, encoding: 'utf8'): string;
    };
    const css = readFileSync('src/lib/export/print.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const media = css.indexOf('@media print');
    expect(media).toBeGreaterThan(-1);
    const screen = css.slice(0, media);
    const printed = css.slice(media);
    expect(screen).toMatch(/\.print-root \{\s*display: none;\s*\}/);
    expect(screen).toMatch(/@page \{\s*margin: 18mm 16mm;\s*\}/);
    const decls = [...printed.matchAll(/([a-z-]+):\s*([^;{}]+);/g)].map(([, name, value]) => `${name}: ${value.trim()}`);
    for (const decl of decls) expect(decl, decl).toMatch(/!important$/);
    for (const needed of [
      /html,\s*body \{\s*height: auto !important;\s*overflow: visible !important;\s*background: none !important;/,
      /body > :not\(\.print-root\) \{\s*display: none !important;/,
      /\.print-root \{\s*display: block !important;/,
      /break-inside: avoid !important;/,
    ]) {
      expect(printed).toMatch(needed);
    }
    const preview = readFileSync('src/lib/ui/Preview.svelte', 'utf8');
    expect(preview).toMatch(/\.print \.content :global\(pre\) \{\s*white-space: pre-wrap;/);
  });

  it('prints remote images only when the doc already shows them', async () => {
    await printDoc(doc('![Far](https://example.com/far.png)\n'), { pdfHint: false });
    expect(printed[0].root!.querySelector('img')).toBeNull();
    expect(printed[0].root!.querySelector('.image-alt')!.textContent).toBe('Far');
    expect(printed[0].root!.querySelector('.remote-images, button')).toBeNull();
    expect(fetchRemoteImage).not.toHaveBeenCalled();

    settings.remoteImages = 'load';
    await printDoc(doc('![Far](https://example.com/far.png)\n'), { pdfHint: false });
    expect(printed[1].root!.querySelector('img')!.getAttribute('src')).toBe(
      `data:image/png;base64,${btoa('https://example.com/far.png')}`,
    );
  });

  it('keeps the root after print returns, until the next print replaces it (Ruling 294)', async () => {
    await printDoc(doc('# First\n'), { pdfHint: false });
    expect(document.querySelectorAll('.print-root')).toHaveLength(1);
    expect(printed[0].root!.isConnected).toBe(true);

    await printDoc(doc('# Second\n'), { pdfHint: false });
    const roots = document.querySelectorAll('.print-root');
    expect(roots).toHaveLength(1);
    expect(roots[0].querySelector('h1')!.textContent).toBe('Second');
    expect(printed[0].root!.isConnected).toBe(false);
  });

  it('keeps the root while its doc is the active tab with the same text (Ruling 302)', async () => {
    const printedDoc = doc('# Kept\n');
    await printDoc(printedDoc, { pdfHint: false });

    dropStalePrintRoot({ id: printedDoc.id, text: '# Kept\n' });
    expect(document.querySelector('.print-root')).not.toBeNull();
  });

  it('drops the root when its text changes (Ruling 302)', async () => {
    const printedDoc = doc('# Kept\n');
    await printDoc(printedDoc, { pdfHint: false });
    endPrint();

    dropStalePrintRoot({ id: printedDoc.id, text: '# Kept, edited\n' });
    expect(document.querySelector('.print-root')).toBeNull();
  });

  it('drops the root when another tab or none is active (Ruling 302)', async () => {
    await printDoc(doc('# Kept\n'), { pdfHint: false });
    endPrint();
    dropStalePrintRoot({ id: 'other', text: '# Kept\n' });
    expect(document.querySelector('.print-root')).toBeNull();

    await printDoc(doc('# Kept\n'), { pdfHint: false });
    endPrint();
    dropStalePrintRoot(undefined);
    expect(document.querySelector('.print-root')).toBeNull();
  });

  it('freezes the printed root: allowing remote images later fetches nothing (Ruling 302)', async () => {
    await printDoc(doc('![Far](https://example.com/far.png)\n'), { pdfHint: false });

    settings.remoteImages = 'load';
    flushSync();
    await later(null);
    await later(null);

    expect(fetchRemoteImage).not.toHaveBeenCalled();
    expect(document.querySelector('.print-root .image-alt')!.textContent).toBe('Far');
  });

  it('prints only the later of two overlapping prints (Ruling 303)', async () => {
    const first = printDoc(doc('# First\n\n![Chart](img/c.png)\n'), { pdfHint: false });
    const second = printDoc(doc('# Second\n'), { pdfHint: false });
    await Promise.all([first, second]);

    expect(print).toHaveBeenCalledTimes(1);
    expect(printed[0].root!.querySelector('h1')!.textContent).toBe('Second');
    expect(document.querySelectorAll('.print-root')).toHaveLength(1);
  });

  it('rejects when the print call rejects, so the menu shows the error (Ruling 303)', async () => {
    print.mockImplementationOnce(() => Promise.reject(new Error('print is not allowed')) as never);
    await expect(printDoc(doc('# A\n'), { pdfHint: false })).rejects.toThrow('print is not allowed');
    // No print is in progress, so a stale root goes at once.
    dropStalePrintRoot({ id: 'other', text: '' });
    expect(document.querySelector('.print-root')).toBeNull();
  });

  it('sets up no resize observer for the print preview (Ruling 304)', async () => {
    const Original = globalThis.ResizeObserver;
    const made = vi.fn();
    globalThis.ResizeObserver = class {
      constructor() {
        made();
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      await printDoc(doc('# A\n'), { pdfHint: false });
    } finally {
      globalThis.ResizeObserver = Original;
    }
    expect(made).not.toHaveBeenCalled();
  });

  it('keeps the root through an outside reload during the print, until the next key (Ruling 311)', async () => {
    const reloaded = createDoc({ path: '/notes/reloaded.md', raw: '# Before\n', hash: 'h1', mode: 'read' });
    vi.mocked(readTextFile).mockResolvedValue({ text: '# After\n', hash: 'h2' } as never);
    // What App's effect does whenever the active doc or its text changes.
    const appEffect = () => dropStalePrintRoot({ id: reloaded.id, text: reloaded.text });
    // On macOS print returns before its sheet opens; the reload lands while it is up.
    await printDoc(reloaded, { pdfHint: false });
    await handleFileChanged({ path: '/notes/reloaded.md', hash: 'h2' } as never);
    expect(reloaded.text).toBe('# After\n');
    appEffect();

    const root = document.querySelector('.print-root');
    expect(root?.isConnected).toBe(true);
    expect(root!.querySelector('h1')!.textContent).toBe('Before');

    endPrint();
    expect(document.querySelector('.print-root')).toBeNull();
  });

  it('keeps the root when a stale check comes during the print call itself (Ruling 311)', async () => {
    const printedDoc = doc('# Kept\n');
    print.mockImplementationOnce(() => {
      dropStalePrintRoot({ id: 'other', text: '' });
      printed.push({ root: document.querySelector('.print-root'), html: '', connected: true });
    });
    await printDoc(printedDoc, { pdfHint: false });
    expect(document.querySelector('.print-root')).not.toBeNull();
  });

  it.each([
    ['a key', () => window.dispatchEvent(new KeyboardEvent('keydown'))],
    ['a click', () => window.dispatchEvent(new Event('pointerdown'))],
    ['focus', () => window.dispatchEvent(new FocusEvent('focus'))],
  ])('ends the print at %s, then drops a root that went stale meanwhile (Ruling 311)', async (_name, input) => {
    const printedDoc = doc('# Kept\n');
    await printDoc(printedDoc, { pdfHint: false });
    dropStalePrintRoot({ id: printedDoc.id, text: '# Edited\n' });
    expect(document.querySelector('.print-root')).not.toBeNull();

    input();
    expect(document.querySelector('.print-root')).toBeNull();
  });

  it('keeps the root at the end of the print when the latest check found it current (Ruling 311)', async () => {
    const printedDoc = doc('# Kept\n');
    await printDoc(printedDoc, { pdfHint: false });
    dropStalePrintRoot({ id: printedDoc.id, text: '# Edited\n' });
    dropStalePrintRoot({ id: printedDoc.id, text: '# Kept\n' });

    endPrint();
    expect(document.querySelector('.print-root')).not.toBeNull();
  });

  it('drops the root and prints nothing when rendering fails (Ruling 302)', async () => {
    vi.mocked(renderMarkdown).mockImplementationOnce(() => {
      throw new Error('render failed');
    });
    await expect(printDoc(doc('# A\n'), { pdfHint: false })).rejects.toThrow('render failed');
    expect(document.querySelector('.print-root')).toBeNull();
    expect(print).not.toHaveBeenCalled();
  });

  it('waits for the copied images to decode before printing (Ruling 302)', async () => {
    let decoded!: () => void;
    const decode = vi.fn(() => new Promise<void>((resolve) => (decoded = resolve)));
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = decode;
    try {
      const printing = printDoc(doc('![Chart](img/c.png)\n'), { pdfHint: false });
      await vi.waitFor(() => expect(decode).toHaveBeenCalled());
      await later(null);
      expect(print).not.toHaveBeenCalled();

      decoded();
      await printing;
      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      HTMLImageElement.prototype.decode = original;
    }
  });

  it.each([
    ['macos', 'In the print dialog, choose PDF > Save as PDF.'],
    ['windows', 'In the print dialog, choose Microsoft Print to PDF.'],
    ['linux', 'In the print dialog, choose Print to File, then PDF.'],
  ] as const)('on %s, shows the PDF hint before the dialog (Ruling 295)', async (platform, hint) => {
    vi.mocked(currentPlatform).mockReturnValue(platform);
    await printDoc(doc('# A\n'), { pdfHint: true });

    expect(message).toHaveBeenCalledWith(hint, { title: 'Export as PDF', kind: 'info' });
    expect(vi.mocked(message).mock.invocationCallOrder[0]).toBeLessThan(print.mock.invocationCallOrder[0]);
  });
});
