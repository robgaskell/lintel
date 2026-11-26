import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render, within } from '@testing-library/svelte';
import { EditorView } from '@codemirror/view';
import { fakePreviewLayout } from '../../test/layout';
import { cursors } from '../docs/cursor.svelte';
import { createDoc, docs, type ViewMode } from '../docs/store.svelte';
import { largeFileNotices } from '../os/open';
import DocPane from './DocPane.svelte';
import { outline } from './outline.svelte';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const NOTICE = 'Large file: preview is off. Switch to Split or Read to render it.';

beforeEach(() => {
  docs.clear();
  largeFileNotices.clear();
  outline.visible = true;
});

afterEach(() => vi.useRealTimers());

function pane(mode: ViewMode, raw = '# Title\n') {
  const doc = createDoc({ path: '/notes/a.md', raw, hash: 'h', mode });
  const view = render(DocPane, { doc });
  const q = (selector: string) => view.container.querySelector(selector);
  return { doc, ...view, q };
}

describe('DocPane modes', () => {
  it('switches mode from the toolbar and marks the pressed button', async () => {
    const { doc, getByRole, q } = pane('split');
    expect(getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(getByRole('button', { name: 'Read' }));

    expect(doc.mode).toBe('read');
    expect(getByRole('button', { name: 'Read' }).getAttribute('aria-pressed')).toBe('true');
    expect(q('.panes')?.classList.contains('mode-read')).toBe(true);
  });

  it('keeps the editor mounted but inert in Read, and hides the formatting buttons', async () => {
    const { doc, q } = pane('split');
    const editor = q('.cm-editor');
    // Svelte sets the inert property; jsdom does not reflect it to the attribute.
    const editorHost = () => q('.editor-host') as HTMLElement;

    doc.mode = 'read';
    flushSync();

    expect(q('.cm-editor')).toBe(editor);
    expect(editorHost().inert).toBe(true);
    expect(q('[aria-label="Formatting"]')).toBeNull();

    doc.mode = 'edit';
    flushSync();
    expect(editorHost().inert).toBe(false);
    expect(q('[aria-label="Formatting"]')).not.toBeNull();
  });

  it('does not render in Edit, and renders at once when the preview is shown', () => {
    const { doc, q } = pane('edit');
    expect(q('.preview')).toBeNull();

    doc.mode = 'split';
    flushSync();

    expect(q('.preview h1')?.textContent).toBe('Title');
  });

  it('re-renders an edit only after the debounce', () => {
    vi.useFakeTimers();
    const { doc, q } = pane('split');

    doc.text = '# Changed\n';
    flushSync();
    vi.advanceTimersByTime(149);
    expect(q('.preview h1')?.textContent).toBe('Title');

    vi.advanceTimersByTime(1);
    flushSync();
    expect(q('.preview h1')?.textContent).toBe('Changed');
  });
});

describe('DocPane large-file notice', () => {
  it('shows the notice until Split or Read is chosen, and not again after', () => {
    const doc = createDoc({ path: '/big.md', raw: 'x', hash: 'h', mode: 'edit' });
    largeFileNotices.add(doc.id);
    const { getByRole, queryByText } = render(DocPane, { doc });

    expect(getByRole('status').textContent).toBe(NOTICE);

    doc.mode = 'split';
    flushSync();
    expect(queryByText(NOTICE)).toBeNull();

    doc.mode = 'edit';
    flushSync();
    expect(queryByText(NOTICE)).toBeNull();
  });

  it('shows no notice for an ordinary doc', () => {
    const { queryByText } = pane('edit');
    expect(queryByText(NOTICE)).toBeNull();
  });
});

describe('DocPane scroll sync', () => {
  let restoreLayout: () => void;
  beforeEach(() => (restoreLayout = fakePreviewLayout()));
  afterEach(() => restoreLayout());

  const src = '# A\n\nb\n\nc\n\nd\n';

  function userScroll(el: Element, top?: number) {
    if (top !== undefined) el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  }

  it('does not send the editor scroll that following the preview caused back to it', () => {
    const { q } = pane('split', src);
    const preview = q('.preview')!;
    const editorScroller = q('.cm-scroller')!;

    userScroll(preview, 200);
    userScroll(editorScroller); // the echo of the editor following line 5
    expect(preview.scrollTop).toBe(200);

    // The next editor scroll is the user's own, so the preview follows it.
    userScroll(editorScroller, 0);
    expect(preview.scrollTop).toBe(0);
  });

  it('brings the editor to the line being read when leaving Read', () => {
    const { doc, q } = pane('read', src);
    userScroll(q('.preview')!, 200);
    const view = EditorView.findFromDOM(q('.cm-editor') as HTMLElement)!;
    const measure = vi.spyOn(view, 'requestMeasure');
    const dispatch = vi.spyOn(view, 'dispatch');

    doc.mode = 'split';
    flushSync();

    expect(measure).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ effects: expect.anything() }));
  });
});

describe('DocPane outline', () => {
  let restoreLayout: () => void;
  beforeEach(() => (restoreLayout = fakePreviewLayout()));
  afterEach(() => restoreLayout());

  // With the fake layout each top-level block is 100 px: A at 0, C at 200, E at 400.
  const src = '# A\n\nb\n\n## C\n\nd\n\n### E\n\nf\n';

  function links(getByRole: (role: string, options: { name: string }) => HTMLElement) {
    return within(getByRole('navigation', { name: 'Outline' })).getAllByRole('link');
  }
  const current = (all: HTMLElement[]) =>
    all.filter((a) => a.getAttribute('aria-current') === 'true').map((a) => a.textContent);
  const editorOf = (q: (s: string) => Element | null) =>
    EditorView.findFromDOM(q('.cm-editor') as HTMLElement)!;

  it('lists headings in Edit mode, where nothing is rendered (Ruling 107)', () => {
    const { getByRole, q } = pane('edit', src);

    expect(q('.preview')).toBeNull();
    expect(links(getByRole).map((a) => a.textContent)).toEqual(['A', 'C', 'E']);
    expect(current(links(getByRole))).toEqual(['A']);
  });

  it('updates the headings after an edit only after the debounce', () => {
    vi.useFakeTimers();
    const { doc, getByRole } = pane('edit', src);

    doc.text = '# Only\n';
    flushSync();
    vi.advanceTimersByTime(149);
    flushSync();
    expect(links(getByRole)).toHaveLength(3);

    vi.advanceTimersByTime(1);
    flushSync();
    expect(links(getByRole).map((a) => a.textContent)).toEqual(['Only']);
  });

  it('hides the panel when the outline is turned off for the window', () => {
    const { queryByRole } = pane('split', src);
    expect(queryByRole('navigation', { name: 'Outline' })).not.toBeNull();

    outline.visible = false;
    flushSync();
    expect(queryByRole('navigation', { name: 'Outline' })).toBeNull();
  });

  it('in Split, a pick puts the cursor on the heading and scrolls both sides (Ruling 108)', async () => {
    const { getByRole, q } = pane('split', src);
    const view = editorOf(q);
    const dispatch = vi.spyOn(view, 'dispatch');

    await fireEvent.click(links(getByRole)[1]);

    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ effects: expect.anything() }));
    expect(q('.preview')!.scrollTop).toBe(200);
    expect(current(links(getByRole))).toEqual(['C']);
  });

  it('in Edit, a pick moves the cursor and marks the heading at once', async () => {
    const { getByRole, q } = pane('edit', src);
    const view = editorOf(q);

    await fireEvent.click(links(getByRole)[2]);

    expect(view.state.selection.main.head).toBe(view.state.doc.line(9).from);
    expect(current(links(getByRole))).toEqual(['E']);
  });

  it('in Read, a pick scrolls the preview and leaves the hidden editor alone', async () => {
    const { getByRole, q } = pane('read', src);
    const view = editorOf(q);

    await fireEvent.click(links(getByRole)[1]);

    expect(q('.preview')!.scrollTop).toBe(200);
    expect(view.state.selection.main.head).toBe(0);
    expect(current(links(getByRole))).toEqual(['C']);
  });

  it('marks the heading in view as the user scrolls the preview', () => {
    const { getByRole, q } = pane('read', src);
    const preview = q('.preview')!;

    preview.scrollTop = 250;
    preview.dispatchEvent(new Event('scroll'));
    flushSync();

    expect(current(links(getByRole))).toEqual(['C']);
  });
});

describe('DocPane cursor', () => {
  it('reports the cursor line and column for the status bar (Ruling 109)', () => {
    const { doc, q } = pane('edit', 'ab\ncdef\n');
    expect(cursors.get(doc.id)).toEqual({ line: 1, col: 1 });

    const view = EditorView.findFromDOM(q('.cm-editor') as HTMLElement)!;
    view.dispatch({ selection: { anchor: 6 } });
    expect(cursors.get(doc.id)).toEqual({ line: 2, col: 4 });

    view.dispatch({ changes: { from: 0, insert: 'x\n' } });
    expect(cursors.get(doc.id)).toEqual({ line: 3, col: 4 });
  });

  it('forgets the cursor when the pane goes', () => {
    const { doc, unmount } = pane('edit', 'a');
    unmount();
    expect(cursors.has(doc.id)).toBe(false);
  });
});
