import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { openUrl } from '@tauri-apps/plugin-opener';
import { fetchRemoteImage, readImageAsDataUri } from '../ipc';
import { ImageLoader } from '../render/imageLoader';
import { openPaths } from '../os/open';
import { renderMarkdown } from '../render/markdown';
import { settings, updateSettings } from '../settings/settings.svelte';
import { fakePreviewLayout } from '../../test/layout';
import Preview from './Preview.svelte';

vi.mock('../ipc', () => ({ readImageAsDataUri: vi.fn(), fetchRemoteImage: vi.fn() }));
vi.mock('../settings/settings.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings/settings.svelte')>()),
  updateSettings: vi.fn(async () => {}),
}));
vi.mock('../os/open', () => ({ openPaths: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));
// Real mermaid cannot lay out under jsdom.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
let mermaidTheme: string | undefined;

const readImage = vi.mocked(readImageAsDataUri);
const fetchRemote = vi.mocked(fetchRemoteImage);
let docCount = 0;

beforeEach(() => {
  vi.clearAllMocks();
  readImage.mockImplementation(async (path) => `data:image/png;base64,${btoa(path)}`);
  fetchRemote.mockImplementation(async (url) => `data:image/png;base64,${btoa(url)}`);
  settings.remoteImages = 'ask';
  mermaid.initialize.mockImplementation((config: { theme?: string }) => (mermaidTheme = config.theme));
  mermaid.render.mockImplementation(async (id: string, src: string) => ({
    svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><text>${mermaidTheme}:${src.trim()}</text></svg>`,
  }));
});

function show(src: string, docPath: string | null = '/notes/doc.md', onLineVisible = vi.fn()) {
  docCount += 1;
  const view = render(Preview, { result: renderMarkdown(src), docId: `doc-${docCount}`, docPath, onLineVisible });
  return { ...view, onLineVisible };
}

function click(el: Element | null, type = 'click'): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'auxclick' ? 1 : 0 });
  el!.dispatchEvent(event);
  return event;
}

describe('Preview images', () => {
  it('shows a remote image as its alt text and never fetches it', () => {
    const { container } = show('![A chart](https://example.com/c.png)\n');

    expect(container.querySelector('img')).toBeNull();
    const box = container.querySelector('.image-alt');
    expect(box?.textContent).toBe('A chart');
    expect(readImage).not.toHaveBeenCalled();
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it('loads a relative image through the app, never by its relative src', async () => {
    const { container } = show('![pic](img/a%20b.png)\n');
    const img = container.querySelector('img')!;

    // Before the data URI arrives the image has no src at all.
    expect(img.hasAttribute('src')).toBe(false);
    expect(readImage).toHaveBeenCalledWith('/notes/img/a b.png');
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe(`data:image/png;base64,${btoa('/notes/img/a b.png')}`));
  });

  it('reuses a loaded image on the next render without asking again', async () => {
    const { container, rerender } = show('![pic](a.png)\n');
    await vi.waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:/));

    void rerender({ result: renderMarkdown('Changed.\n\n![pic](a.png)\n') });
    flushSync();

    // Set in the same pass as the patch, so the image never blinks out.
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:/);
    expect(readImage).toHaveBeenCalledTimes(1);
  });

  it('shows the alt text with the reason when an image cannot be read', async () => {
    readImage.mockRejectedValue('Lintel shows png, jpg, jpeg, gif, webp and svg images only.');
    const { container } = show('![notes](a.bmp)\n');

    await vi.waitFor(() => expect(container.querySelector('.image-alt')?.textContent).toBe('notes'));
    expect(container.querySelector('.image-alt')?.getAttribute('title')).toContain('svg images only');
  });

  it('drops srcset, so no candidate URL is ever fetched', () => {
    const { container } = show('<img src="a.png" srcset="https://evil.test/x.png 2x">\n');

    expect(container.querySelector('img')?.hasAttribute('srcset')).toBe(false);
  });

  it('forgets its images when it closes (Ruling 105)', () => {
    const clear = vi.spyOn(ImageLoader.prototype, 'clear');
    const { unmount } = show('![pic](a.png)\n');
    expect(clear).not.toHaveBeenCalled();

    unmount();

    expect(clear).toHaveBeenCalledTimes(1);
    clear.mockRestore();
  });

  it('cannot place a relative image in an unsaved document', () => {
    const { container } = show('![pic](a.png)\n', null);

    expect(container.querySelector('.image-alt')?.textContent).toBe('pic');
    expect(readImage).not.toHaveBeenCalled();
  });
});

describe('Preview remote images (spec: Remote images)', () => {
  const BANNER = 'This document has remote images.';
  const CHART = '![A chart](https://example.com/c.png)\n';
  const chartUri = `data:image/png;base64,${btoa('https://example.com/c.png')}`;

  function banner(container: Element) {
    return [...container.querySelectorAll('[role="status"]')].find((el) => el.textContent?.includes(BANNER));
  }

  function button(container: Element, name: string) {
    return [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
    )!;
  }

  it("with 'ask', shows the banner and gives the image no network src", () => {
    const { container } = show(CHART);

    expect(banner(container)).toBeDefined();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.image-alt')?.textContent).toBe('A chart');
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it('Load images fetches through Rust and sets the data URI, for that doc only', async () => {
    const first = show(CHART);
    const second = show('![Map](https://example.com/m.png)\n');

    click(button(first.container, 'Load images'));
    flushSync();

    expect(fetchRemote).toHaveBeenCalledWith('https://example.com/c.png');
    await vi.waitFor(() => expect(first.container.querySelector('img')?.getAttribute('src')).toBe(chartUri));
    expect(banner(first.container)).toBeUndefined();
    expect(banner(second.container)).toBeDefined();
    expect(second.container.querySelector('img')).toBeNull();
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('keeps the choice for the doc if its preview is built again, and asks for a new doc', async () => {
    const result = renderMarkdown(CHART);
    const first = render(Preview, { result, docId: 'kept-doc', docPath: '/notes/doc.md' });
    click(button(first.container, 'Load images'));
    first.unmount();

    const again = render(Preview, { result, docId: 'kept-doc', docPath: '/notes/doc.md' });
    const reopened = render(Preview, { result, docId: 'reopened-doc', docPath: '/notes/doc.md' });

    expect(banner(again.container)).toBeUndefined();
    await vi.waitFor(() => expect(again.container.querySelector('img')?.getAttribute('src')).toBe(chartUri));
    expect(banner(reopened.container)).toBeDefined();
  });

  it("Always load saves 'load' and hides the banner", async () => {
    const { container } = show(CHART);

    click(button(container, 'Always load'));
    flushSync();

    expect(updateSettings).toHaveBeenCalledWith({ remoteImages: 'load' });
    expect(banner(container)).toBeUndefined();
    await vi.waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(chartUri));
  });

  it('closing the banner keeps the image blocked', () => {
    const { container } = show(CHART);

    click(button(container, 'Keep images blocked'));
    flushSync();

    expect(banner(container)).toBeUndefined();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.image-alt')?.textContent).toBe('A chart');
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it("with 'load', fetches with no banner, and //host as https (Ruling 124)", async () => {
    settings.remoteImages = 'load';
    const { container } = show('![A](https://example.com/c.png) ![B](//example.com/b.png)\n');

    expect(banner(container)).toBeUndefined();
    expect(fetchRemote).toHaveBeenCalledWith('https://example.com/c.png');
    expect(fetchRemote).toHaveBeenCalledWith('https://example.com/b.png');
    await vi.waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(chartUri));
  });

  it("with 'block', shows no banner and never fetches", () => {
    settings.remoteImages = 'block';
    const { container } = show(CHART);

    expect(banner(container)).toBeUndefined();
    expect(container.querySelector('.image-alt')?.textContent).toBe('A chart');
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it('shows no banner for a doc without remote images, nor for other schemes', () => {
    const { container } = show('![pic](a.png) ![old](ftp://example.com/a.png) ![x](data:image/png;base64,AA)\n');

    expect(banner(container)).toBeUndefined();
    expect([...container.querySelectorAll('.image-alt')].map((b) => b.textContent)).toEqual(['old']);
  });

  it('never loads another scheme, even when remote images are allowed', () => {
    settings.remoteImages = 'load';
    const { container } = show('![old](ftp://example.com/a.png)\n');

    expect(container.querySelector('.image-alt')?.textContent).toBe('old');
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it('shows the alt text with the reason when a fetch fails', async () => {
    settings.remoteImages = 'load';
    fetchRemote.mockRejectedValue('Not an image file.');
    const { container } = show(CHART);

    await vi.waitFor(() => expect(container.querySelector('.image-alt')?.getAttribute('title')).toBe('Not an image file.'));
    expect(container.querySelector('.image-alt')?.textContent).toBe('A chart');
  });

  it('fetches an image used twice only once', async () => {
    settings.remoteImages = 'load';
    const { container } = show(`${CHART}\n${CHART}`);

    await vi.waitFor(() => expect(container.querySelectorAll(`img[src="${chartUri}"]`)).toHaveLength(2));
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });
});

describe('Preview links', () => {
  it('opens a web link in the system browser and never navigates', () => {
    const { container } = show('[site](https://example.com/a)\n');

    const event = click(container.querySelector('a'));

    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith('https://example.com/a');
  });

  it('scrolls to a heading for #anchor and reports its line', () => {
    const { container, onLineVisible } = show('[go](#Details)\n\nText\n\n## Details\n');

    const event = click(container.querySelector('a'));

    expect(event.defaultPrevented).toBe(true);
    expect(onLineVisible).toHaveBeenCalledWith(5);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('ignores an anchor that only raw HTML claims, so a forged id leads nowhere', () => {
    const { container, onLineVisible } = show('[go](#h-fake)\n\n<div id="h-fake">x</div>\n');

    expect(click(container.querySelector('a')).defaultPrevented).toBe(true);
    expect(onLineVisible).not.toHaveBeenCalled();
  });

  it('opens a relative .md link through openPaths, resolved against the doc folder', () => {
    const { container } = show('[next](../other.md#part)\n');

    click(container.querySelector('a'));

    expect(openPaths).toHaveBeenCalledWith(['/other.md']);
  });

  it('does nothing for a link to a file that is not markdown, but still never navigates', () => {
    const { container } = show('[data](data.csv)\n');

    expect(click(container.querySelector('a')).defaultPrevented).toBe(true);
    expect(openPaths).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('never lets a middle click on a link do its default', () => {
    const { container } = show('[site](https://example.com/a)\n');

    expect(click(container.querySelector('a'), 'auxclick').defaultPrevented).toBe(true);
  });

  it('handles a click on an element inside a link', () => {
    const { container } = show('[**bold**](mailto:a@b.test)\n');

    click(container.querySelector('a strong'));

    expect(openUrl).toHaveBeenCalledWith('mailto:a@b.test');
  });
});

describe('Preview layout', () => {
  it('replaces the previous render, and caps the width only when reading', async () => {
    const { container, rerender } = show('# One\n');
    expect(container.querySelector('.preview')?.classList.contains('reading')).toBe(false);

    await rerender({ result: renderMarkdown('# Two\n'), reading: true });

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h1')?.textContent).toBe('Two');
    expect(container.querySelector('.preview')?.classList.contains('reading')).toBe(true);
  });
});

describe('Preview scroll sync', () => {
  let restoreLayout: () => void;
  beforeEach(() => (restoreLayout = fakePreviewLayout()));
  afterEach(() => restoreLayout());

  function scrollBy(scroller: Element, top: number) {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
  }

  it('reports a user scroll, but not the scroll scrollToLine made', () => {
    const { component, container, onLineVisible } = show('# A\n\nb\n\nc\n');
    const scroller = container.querySelector('.preview')!;

    component.scrollToLine(3);
    expect(scroller.scrollTop).toBe(100);
    scroller.dispatchEvent(new Event('scroll'));
    expect(onLineVisible).not.toHaveBeenCalled();

    scrollBy(scroller, 200);
    expect(onLineVisible).toHaveBeenCalledWith(5);
  });

  it('syncs lines after the last block toward the end of the content', () => {
    const view = render(Preview, { result: renderMarkdown('# A\n\nb\n'), docId: 'doc-end', lineCount: 6 });

    view.component.scrollToLine(5);

    // Between line 3 at 100 px and the end (line 7) at 200 px.
    expect(view.container.querySelector('.preview')!.scrollTop).toBe(150);
  });

  it('still syncs to the block after a diagram draws (Ruling 100)', async () => {
    const src = '# A\n\n```mermaid\ngraph TD; Sync\n```\n\nc\n';
    const { container, rerender, onLineVisible } = show(src);
    await vi.waitFor(() => expect(container.querySelector('.mermaid-diagram')).not.toBeNull());
    // The next patch measures with the drawn diagram in place.
    await rerender({ result: renderMarkdown(src + '\nd\n') });

    scrollBy(container.querySelector('.preview')!, 100);

    expect(onLineVisible).toHaveBeenCalledWith(3);
  });

  it('ignores a forged source line in raw HTML (Ruling 85)', () => {
    const src = '# A\n\n<div data-source-line="50">x</div>\n\nc\n\nd\n\ne\n';
    const { container, onLineVisible } = show(src);

    scrollBy(container.querySelector('.preview')!, 150);

    expect(onLineVisible).toHaveBeenCalledWith(4);
  });
});

describe('Preview diagrams', () => {
  const diagram = (name: string) => '# A\n\n```mermaid\ngraph TD; ' + name + '\n```\n\nc\n';
  let restoreLayout: () => void;
  beforeEach(() => (restoreLayout = fakePreviewLayout()));
  afterEach(() => restoreLayout());

  it('draws nothing in a hidden tab until it is shown (Ruling 115)', async () => {
    restoreLayout(); // jsdom without the fake layout measures 0: hidden
    restoreLayout = () => {};
    const resized: (() => void)[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { container } = show(diagram('Hidden'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mermaid.initialize).not.toHaveBeenCalled();
      expect(container.querySelector('pre.mermaid-src')).not.toBeNull();

      Object.defineProperty(container.querySelector('.preview'), 'clientHeight', { value: 400 });
      for (const callback of resized) callback();

      await vi.waitFor(() => expect(container.querySelector('.mermaid-diagram svg')).not.toBeNull());
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('draws a mermaid block as a diagram that keeps its source line', async () => {
    const { container } = show(diagram('Draw'));

    await vi.waitFor(() => expect(container.querySelector('.mermaid-diagram svg')).not.toBeNull());
    const box = container.querySelector<HTMLElement>('.content > .mermaid-diagram')!;
    expect(box.dataset.sourceLine).toBe('3');
    expect(box.textContent).toBe('default:graph TD; Draw');
  });

  it('keeps a drawn diagram through an edit elsewhere, without drawing it again', async () => {
    const { container, rerender } = show(diagram('Keep'));
    await vi.waitFor(() => expect(container.querySelector('.mermaid-diagram')).not.toBeNull());

    void rerender({ result: renderMarkdown(diagram('Keep') + '\nMore.\n') });
    flushSync();

    expect(container.querySelector('.mermaid-diagram svg')).not.toBeNull();
    expect(container.querySelector('pre.mermaid-src')).toBeNull();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('shows a broken diagram as an error box and still renders the rest', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 1:\nfoo'));
    const { container } = show(diagram('Broken'));

    await vi.waitFor(() =>
      expect(container.querySelector('.mermaid-error strong')?.textContent).toBe(
        'Parse error on line 1 of the diagram (file line 4):',
      ),
    );
    expect(container.querySelector('h1')?.textContent).toBe('A');
    expect(container.querySelector('.content p')?.textContent).toBe('c');
  });

  it('draws diagrams again in the dark theme when the OS switches (Ruling 101)', async () => {
    const listeners: ((event: { matches: boolean }) => void)[] = [];
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      const { container } = show(diagram('Theme'));
      await vi.waitFor(() => expect(container.querySelector('svg')?.textContent).toBe('default:graph TD; Theme'));

      for (const listener of listeners) listener({ matches: true });

      await vi.waitFor(() => expect(container.querySelector('svg')?.textContent).toBe('dark:graph TD; Theme'));
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });
});

describe('Preview front matter', () => {
  it('shows the card above the document and keeps it through a re-render', async () => {
    const { container, rerender } = show('---\nname: plan-reviewer\ntools: [Bash, Read]\n---\n# Title\n');

    expect(container.querySelector('.page > .front-matter + .content')).not.toBeNull();
    expect(container.querySelectorAll('.fm-pill')).toHaveLength(2);
    expect(container.querySelector('.content')?.textContent).not.toContain('---');

    await rerender({ result: renderMarkdown('---\nname: other\n---\n# Title\n') });

    expect(container.querySelector('.front-matter')?.textContent).toContain('other');
  });

  it('shows invalid YAML as the card with its error line', () => {
    const { container } = show('---\nname: [unclosed\n---\n# Title\n');

    expect(container.querySelector('.fm-error')?.textContent).toMatch(/at line \d+, column \d+/);
  });
});
