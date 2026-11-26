import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { openUrl } from '@tauri-apps/plugin-opener';
import { readImageAsDataUri } from '../ipc';
import { openPaths } from '../os/open';
import { renderMarkdown } from '../render/markdown';
import Preview from './Preview.svelte';

vi.mock('../ipc', () => ({ readImageAsDataUri: vi.fn() }));
vi.mock('../os/open', () => ({ openPaths: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));

const readImage = vi.mocked(readImageAsDataUri);

beforeEach(() => {
  vi.clearAllMocks();
  readImage.mockImplementation(async (path) => `data:image/png;base64,${btoa(path)}`);
});

function show(src: string, docPath: string | null = '/notes/doc.md', onLineVisible = vi.fn()) {
  const view = render(Preview, { result: renderMarkdown(src), docPath, onLineVisible });
  return { ...view, onLineVisible };
}

function click(el: Element | null): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
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

  it('cannot place a relative image in an unsaved document', () => {
    const { container } = show('![pic](a.png)\n', null);

    expect(container.querySelector('.image-alt')?.textContent).toBe('pic');
    expect(readImage).not.toHaveBeenCalled();
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
