import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from '@tauri-apps/plugin-dialog';
import type { DocState } from '../docs/store.svelte';
import { fetchRemoteImage, readImageAsDataUri } from '../ipc';
import { currentPlatform } from '../os/platform';
import { DEFAULT_SETTINGS, settings, type Settings } from '../settings/settings.svelte';
import { applyTheme } from '../theme/theme';
import { dropPrintRootUnlessOpen, printDoc } from './print';

vi.mock('../ipc', () => ({
  readImageAsDataUri: vi.fn(),
  fetchRemoteImage: vi.fn(),
  setWindowAppearance: vi.fn(async () => {}),
}));
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

afterEach(() => {
  dropPrintRootUnlessOpen(new Set());
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
    const css = readFileSync('src/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
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

  it('drops the root once its doc is no longer open', async () => {
    const printedDoc = doc('# Kept\n');
    await printDoc(printedDoc, { pdfHint: false });

    dropPrintRootUnlessOpen(new Set([printedDoc.id, 'other']));
    expect(document.querySelector('.print-root')).not.toBeNull();

    dropPrintRootUnlessOpen(new Set(['other']));
    expect(document.querySelector('.print-root')).toBeNull();
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
