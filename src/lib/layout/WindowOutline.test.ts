import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { EditorView } from '@codemirror/view';
import { fakePreviewLayout } from '../../test/layout';
import { createDoc, docs, type ViewMode } from '../docs/store.svelte';
import { largeFileNotices } from '../os/open';
import DocPane from './DocPane.svelte';
import { outline, outlineSources } from './outline.svelte';
import WindowOutline from './WindowOutline.svelte';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc')>()),
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
}));
// Stubbed, so real markdownlint never runs on live 400 ms timers here (Ruling 275).
vi.mock('../lint/lintExtension', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lint/lintExtension')>()),
  lintExtension: vi.fn(() => []),
}));

function source(text: string) {
  return { headings: [{ level: 1 as const, text, id: 'h-intro', line: 1 }], activeLine: 1, pick: vi.fn() };
}

const column = () => document.querySelector<HTMLElement>('.outline-column');
const nav = () => screen.queryByRole('navigation', { name: 'Outline' });

beforeEach(() => {
  docs.clear();
  largeFileNotices.clear();
  outline.visible = true;
  outline.collapsed = false;
  outline.width = 210;
  outlineSources.clear();
});

afterEach(() => vi.useRealTimers());

describe('WindowOutline', () => {
  it('builds a fresh outline for each doc, so no scroll or focus carries over', async () => {
    outlineSources.set('a', source('Intro'));
    outlineSources.set('b', source('Intro'));
    const { container, rerender } = render(WindowOutline, { docId: 'a' });
    const first = container.querySelector('nav');
    expect(first).not.toBeNull();

    await rerender({ docId: 'b' });

    const second = container.querySelector('nav');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('shows nothing until the doc has published its headings', () => {
    const { container } = render(WindowOutline, { docId: 'a' });
    expect(container.querySelector('nav')).toBeNull();
    expect(column()).toBeNull();
  });

  it('shows nothing with no active tab, as in an empty window (Ruling 9 of the v0.2 ledger)', () => {
    outlineSources.set('a', source('Intro'));
    render(WindowOutline, { docId: null });
    expect(column()).toBeNull();
  });
});

describe('WindowOutline collapse (v0.2 item 8)', () => {
  it('collapses to a 28 px rail with an expand button, and expands back', async () => {
    outlineSources.set('a', source('Intro'));
    render(WindowOutline, { docId: 'a' });

    await fireEvent.click(screen.getByRole('button', { name: 'Collapse Outline' }));

    expect(outline.collapsed).toBe(true);
    expect(nav()).toBeNull();
    expect(getComputedStyle(column()!).width).toBe('28px');
    expect(within(column()!).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Expand Outline',
    ]);

    await fireEvent.click(screen.getByRole('button', { name: 'Expand Outline' }));

    expect(outline.collapsed).toBe(false);
    expect(nav()).not.toBeNull();
    expect(column()!.style.width).toBe('210px');
  });

  it('puts the collapse button at the top of the column, in the Outline label row', () => {
    outlineSources.set('a', source('Intro'));
    render(WindowOutline, { docId: 'a' });

    const button = screen.getByRole('button', { name: 'Collapse Outline' });
    expect(button.closest('.label')?.textContent).toContain('Outline');
  });

  it.each([false, true])('hides the whole column while Show Outline is off (collapsed: %s)', (collapsed) => {
    outlineSources.set('a', source('Intro'));
    outline.collapsed = collapsed;
    render(WindowOutline, { docId: 'a' });
    expect(column()).not.toBeNull();

    outline.visible = false;
    flushSync();

    expect(column()).toBeNull();
    expect(screen.queryByRole('button', { name: /Outline/ })).toBeNull();
  });
});

describe('WindowOutline width (v0.2 item 8)', () => {
  const edge = () => screen.getByRole('separator', { name: 'Resize Outline' });
  const pointer = (type: string, clientX: number, button = 0) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX, button, pointerId: 1 });

  beforeEach(() => {
    outlineSources.set('a', source('Intro'));
  });

  it('is as wide as the outline width', () => {
    outline.width = 300;
    render(WindowOutline, { docId: 'a' });
    expect(column()!.style.width).toBe('300px');
  });

  it("shows the split sashes' resize arrow over the edge", () => {
    render(WindowOutline, { docId: 'a' });
    expect(getComputedStyle(edge()).cursor).toBe('ew-resize');
  });

  it('follows a drag of the edge, clamped to 160-480, until the pointer is let go', () => {
    render(WindowOutline, { docId: 'a' });

    edge().dispatchEvent(pointer('pointerdown', 210));
    document.dispatchEvent(pointer('pointermove', 300));
    flushSync();
    expect(outline.width).toBe(300);
    expect(column()!.style.width).toBe('300px');

    document.dispatchEvent(pointer('pointermove', 1000));
    expect(outline.width).toBe(480);
    document.dispatchEvent(pointer('pointermove', 0));
    expect(outline.width).toBe(160);

    document.dispatchEvent(pointer('pointerup', 0));
    document.dispatchEvent(pointer('pointermove', 300));
    expect(outline.width).toBe(160);
  });

  it('stops following the pointer on a cancel too', () => {
    render(WindowOutline, { docId: 'a' });

    edge().dispatchEvent(pointer('pointerdown', 210));
    document.dispatchEvent(pointer('pointercancel', 250));
    document.dispatchEvent(pointer('pointermove', 300));

    expect(outline.width).toBe(210);
  });

  it('ignores a press with a button other than the main one', () => {
    render(WindowOutline, { docId: 'a' });

    edge().dispatchEvent(pointer('pointerdown', 210, 2));
    document.dispatchEvent(pointer('pointermove', 300));

    expect(outline.width).toBe(210);
  });

  it('goes back to 210 px on a double-click of the edge', async () => {
    outline.width = 400;
    render(WindowOutline, { docId: 'a' });

    await fireEvent.dblClick(edge());

    expect(outline.width).toBe(210);
  });

  it('lets go of the pointer when the column goes mid-drag', () => {
    const { unmount } = render(WindowOutline, { docId: 'a' });
    edge().dispatchEvent(pointer('pointerdown', 210));

    unmount();
    document.dispatchEvent(pointer('pointermove', 300));

    expect(outline.width).toBe(210);
  });
});

// Moved from DocPane.test.ts when the outline left the pane (spec item 7).
describe('WindowOutline beside a pane (Rulings 107, 108, 119, 122)', () => {
  let restoreLayout: () => void;
  beforeEach(() => (restoreLayout = fakePreviewLayout()));
  afterEach(() => restoreLayout());

  // With the fake layout each top-level block is 100 px: A at 0, C at 200, E at 400.
  const src = '# A\n\nb\n\n## C\n\nd\n\n### E\n\nf\n';

  function pane(mode: ViewMode, raw = src) {
    const doc = createDoc({ path: '/notes/a.md', raw, hash: 'h', mode });
    const view = render(DocPane, { doc });
    render(WindowOutline, { docId: doc.id });
    const q = (selector: string) => view.container.querySelector(selector);
    return { doc, q };
  }

  const links = () => within(nav()!).getAllByRole('link');
  const current = (all: HTMLElement[]) =>
    all.filter((a) => a.getAttribute('aria-current') === 'true').map((a) => a.textContent);
  const editorOf = (q: (s: string) => Element | null) => EditorView.findFromDOM(q('.cm-editor') as HTMLElement)!;

  // Lets a test report a pane's size, as dockview's show and hide do.
  function fakeResizeObservers() {
    const real = globalThis.ResizeObserver;
    const callbacks: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    return {
      resize(height: number) {
        const entry = { contentRect: { height } } as ResizeObserverEntry;
        for (const cb of callbacks) cb([entry], {} as ResizeObserver);
      },
      restore: () => (globalThis.ResizeObserver = real),
    };
  }

  it('keeps the large-file notice to the document column, apart from the outline (Ruling 122)', () => {
    const doc = createDoc({ path: '/big.md', raw: '# x', hash: 'h', mode: 'edit' });
    largeFileNotices.add(doc.id);
    render(DocPane, { doc });
    render(WindowOutline, { docId: doc.id });

    const notice = screen.getByRole('status');
    expect(notice.closest('.doc-column')?.querySelector('nav')).toBeNull();
    expect(nav()).not.toBeNull();
    expect(nav()!.contains(notice)).toBe(false);
  });

  it('lists headings in Edit mode, where nothing is rendered, after the debounce (Rulings 107, 119)', () => {
    vi.useFakeTimers();
    const { q } = pane('edit');

    expect(q('.preview')).toBeNull();
    expect(screen.getByText('No headings')).toBeTruthy();
    vi.advanceTimersByTime(150);
    flushSync();
    expect(links().map((a) => a.textContent)).toEqual(['A', 'C', 'E']);
    expect(current(links())).toEqual(['A']);
  });

  it('waits until a hidden tab is shown before extracting its headings (Ruling 119)', () => {
    vi.useFakeTimers();
    const observers = fakeResizeObservers();
    pane('edit');

    observers.resize(0);
    flushSync();
    vi.advanceTimersByTime(1000);
    flushSync();
    expect(screen.getByText('No headings')).toBeTruthy();

    observers.resize(500);
    flushSync();
    vi.advanceTimersByTime(150);
    flushSync();
    expect(links()).toHaveLength(3);
    observers.restore();
  });

  it('marks the last heading once the preview is scrolled to its end (Ruling 122)', () => {
    const { q } = pane('read');
    const preview = q('.preview') as HTMLElement;
    Object.defineProperty(preview, 'scrollHeight', { configurable: true, value: 700 });

    preview.scrollTop = 300;
    preview.dispatchEvent(new Event('scroll'));
    flushSync();

    expect(current(links())).toEqual(['E']);
  });

  it('marks the last heading once the editor is scrolled to its end', () => {
    vi.useFakeTimers();
    const { q } = pane('edit');
    vi.advanceTimersByTime(150);
    const scroller = q('.cm-scroller') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 405 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });

    scroller.scrollTop = 5;
    scroller.dispatchEvent(new Event('scroll'));
    flushSync();

    expect(current(links())).toEqual(['E']);
  });

  it('updates the headings after an edit only after the debounce', () => {
    vi.useFakeTimers();
    const { doc } = pane('edit');
    vi.advanceTimersByTime(150);

    doc.text = '# Only\n';
    flushSync();
    vi.advanceTimersByTime(149);
    flushSync();
    expect(links()).toHaveLength(3);

    vi.advanceTimersByTime(1);
    flushSync();
    expect(links().map((a) => a.textContent)).toEqual(['Only']);
  });

  it('in Split, a pick puts the cursor on the heading and scrolls both sides (Ruling 108)', async () => {
    const { q } = pane('split');
    const view = editorOf(q);
    const dispatch = vi.spyOn(view, 'dispatch');

    await fireEvent.click(links()[1]);

    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ effects: expect.anything() }));
    expect(q('.preview')!.scrollTop).toBe(200);
    expect(current(links())).toEqual(['C']);
  });

  it('in Edit, a pick moves the cursor and marks the heading at once', async () => {
    vi.useFakeTimers();
    const { q } = pane('edit');
    vi.advanceTimersByTime(150);
    flushSync();
    const view = editorOf(q);

    await fireEvent.click(links()[2]);

    expect(view.state.selection.main.head).toBe(view.state.doc.line(9).from);
    expect(current(links())).toEqual(['E']);
  });

  it('in Read, a pick scrolls the preview and leaves the hidden editor alone', async () => {
    const { q } = pane('read');
    const view = editorOf(q);

    await fireEvent.click(links()[1]);

    expect(q('.preview')!.scrollTop).toBe(200);
    expect(view.state.selection.main.head).toBe(0);
    expect(current(links())).toEqual(['C']);
  });

  it('in Read, a pick moves focus to the preview, so the keyboard carries on there (Ruling 9 of the v0.2 ledger)', async () => {
    const { q } = pane('read');
    links()[1].focus();

    await fireEvent.click(links()[1]);

    expect(document.activeElement).toBe(q('.preview'));
  });

  it('marks the heading in view as the user scrolls the preview', () => {
    const { q } = pane('read');
    const preview = q('.preview')!;

    preview.scrollTop = 250;
    preview.dispatchEvent(new Event('scroll'));
    flushSync();

    expect(current(links())).toEqual(['C']);
  });
});
