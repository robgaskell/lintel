import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render, within } from '@testing-library/svelte';
import { EditorView } from '@codemirror/view';
import { fakePreviewLayout } from '../../test/layout';
import { cursors, setStartCursor, setStartTopLine, topLineOf } from '../docs/cursor.svelte';
import { createDoc, docs, type ViewMode } from '../docs/store.svelte';
import { largeFileNotices } from '../os/open';
import type { LintIssue } from '../lint/lint';
import { lintExtension } from '../lint/lintExtension';
import { lintIssues } from '../lint/lintState.svelte';
import { settings } from '../settings/settings.svelte';
import DocPane, { PANE_MOVED } from './DocPane.svelte';
import { outline, outlineSources } from './outline.svelte';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
// Load disk version reads the file again (Ruling 263).
vi.mock('../ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc')>()),
  readTextFile: vi.fn(async () => ({ text: 'theirs\n', hash: 'h-theirs' })),
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
}));
 // Stubbed, so real markdownlint never runs on live 400 ms timers here (Ruling 275).
vi.mock('../lint/lintExtension', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lint/lintExtension')>()),
  lintExtension: vi.fn(() => []),
}));

const NOTICE = 'Large file: preview is off. Switch to Split or Read to render it.';

beforeEach(() => {
  docs.clear();
  largeFileNotices.clear();
  outline.visible = true;
  outline.collapsed = false;
  settings.showToolbar = true;
});

afterEach(() => vi.useRealTimers());

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

function pane(mode: ViewMode, raw = '# Title\n') {
  const doc = createDoc({ path: '/notes/a.md', raw, hash: 'h', mode });
  const view = render(DocPane, { doc });
  const q = (selector: string) => view.container.querySelector(selector);
  return { doc, ...view, q };
}

describe('lint (M6.1)', () => {
  it("lints the pane's editor and keeps its issues for the status bar until the pane goes", () => {
    const { doc, unmount } = pane('edit');
    const report = vi.mocked(lintExtension).mock.lastCall![1];
    const issues = [{ rule: 'MD004' }] as LintIssue[];

    report(issues);
    expect(lintIssues.get(doc.id)).toBe(issues);

    unmount();
    expect(lintIssues.has(doc.id)).toBe(false);
  });
});

describe('a doc moved from another window', () => {
  it('starts with the cursor where it was there, line and column (Rulings 186, 201)', () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'one\ntwo\nthree\nfour\n', hash: 'h', mode: 'edit' });
    setStartCursor(doc.id, { line: 3, col: 4 });

    render(DocPane, { doc });

    expect(cursors.get(doc.id)).toEqual({ line: 3, col: 4 });
  });

  it('keeps the cursor inside a line that is shorter than its column', () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'one\nab\n', hash: 'h', mode: 'edit' });
    setStartCursor(doc.id, { line: 2, col: 9 });

    render(DocPane, { doc });

    expect(cursors.get(doc.id)).toEqual({ line: 2, col: 3 });
  });

  it('uses the line once; the next editor for the doc starts at the top', () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'one\ntwo\nthree\n', hash: 'h', mode: 'edit' });
    setStartCursor(doc.id, { line: 2, col: 1 });
    render(DocPane, { doc }).unmount();

    render(DocPane, { doc });

    expect(cursors.get(doc.id)).toEqual({ line: 1, col: 1 });
  });
});

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

  it('hides the formatting buttons but keeps the Edit/Split/Read switch while Show Toolbar is off (Ruling 5)', () => {
    const { q, getByRole } = pane('edit');
    const modeNames = () =>
      within(getByRole('group', { name: 'View mode' }))
        .getAllByRole('button')
        .map((b) => b.textContent);
    expect(q('[aria-label="Formatting"]')).not.toBeNull();

    settings.showToolbar = false;
    flushSync();
    expect(q('[aria-label="Formatting"]')).toBeNull();
    expect(q('.toolbar button[aria-label="Bold"]')).toBeNull();
    expect(modeNames()).toEqual(['Edit', 'Split', 'Read']);

    settings.showToolbar = true;
    flushSync();
    expect(q('[aria-label="Formatting"]')).not.toBeNull();
    expect(modeNames()).toEqual(['Edit', 'Split', 'Read']);
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

describe('DocPane conflict banner', () => {
  function conflicted() {
    const view = pane('edit', 'old\n');
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement)!;
    editor.dispatch({ changes: { from: 3, insert: ' mine' } });
    view.doc.external = 'conflict';
    view.doc.diskText = 'theirs\n';
    flushSync();
    return { ...view, editor };
  }

  it('shows the banner for a conflict only, and Load disk version puts the disk text in the editor', async () => {
    const { doc, editor, getByRole, queryByRole } = conflicted();
    expect(getByRole('alert').textContent).toContain('a.md changed on disk');

    await fireEvent.click(getByRole('button', { name: 'Load disk version' }));

    await vi.waitFor(() => expect(editor.state.doc.toString()).toBe('theirs\n'));
    expect(doc.text).toBe('theirs\n');
    expect(queryByRole('alert')).toBeNull();
  });

  it('Keep my edits hides the banner and leaves the editor alone', async () => {
    const { doc, editor, getByRole, queryByRole } = conflicted();

    await fireEvent.click(getByRole('button', { name: 'Keep my edits' }));

    expect(editor.state.doc.toString()).toBe('old mine\n');
    expect(doc.external).toBe('none');
    expect(queryByRole('alert')).toBeNull();
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

  it('brings the preview back to its line after a move to another group', () => {
    const { q } = pane('read', src);
    const preview = q('.preview')!;
    userScroll(preview, 200);
    preview.scrollTop = 0; // what leaving the page does

    q('[data-doc-pane]')!.dispatchEvent(new Event(PANE_MOVED));

    expect(preview.scrollTop).toBe(200);
  });

  it('leaves the scroll alone when moved while out of the page, as a hidden tab is', () => {
    const { q, container } = pane('read', src);
    const preview = q('.preview')!;
    userScroll(preview, 200);
    preview.scrollTop = 0;
    const root = q('[data-doc-pane]')!;
    root.remove();

    root.dispatchEvent(new Event(PANE_MOVED));

    expect(preview.scrollTop).toBe(0);
    container.append(root);
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

  it('publishes the first visible line as a whole number, for the session (Ruling 208)', () => {
    const { doc, q } = pane('read', src);
    userScroll(q('.preview')!, 225); // line 5.5
    flushSync();
    expect(topLineOf(doc.id)).toBe(5);
  });

  it('opens a restored doc with its saved line at the top of the preview', () => {
    const doc = createDoc({ path: '/notes/a.md', raw: src, hash: 'h', mode: 'read' });
    setStartTopLine(doc.id, 5);

    const { container } = render(DocPane, { doc });

    expect(container.querySelector('.preview')!.scrollTop).toBe(200);
    expect(topLineOf(doc.id)).toBe(5);
  });

  it('scrolls a restored editor so its saved line is at the top once the pane shows', () => {
    const observers = fakeResizeObservers();
    try {
      const scroll = vi.spyOn(EditorView, 'scrollIntoView');
      const doc = createDoc({ path: '/notes/a.md', raw: src, hash: 'h', mode: 'edit' });
      setStartTopLine(doc.id, 5);
      render(DocPane, { doc });
      expect(scroll).not.toHaveBeenCalled();

      observers.resize(300);

      // Line 5 starts at offset 8; y 'start', not centred (Ruling 208).
      expect(scroll).toHaveBeenCalledWith(8, { y: 'start', yMargin: 0 });
      scroll.mockClear();
      observers.resize(0);
      observers.resize(300);
      expect(scroll).toHaveBeenCalledTimes(1);
      scroll.mockRestore();
    } finally {
      observers.restore();
    }
  });
});

// The column's own tests, with a pane beside it, are in WindowOutline.test.ts.
describe('DocPane outline source', () => {
  const src = '# A\n\nb\n\n## C\n\nd\n\n### E\n\nf\n';
  const headingsOf = (id: string) => outlineSources.get(id)?.headings.map((h) => h.text);

  it('gives the window outline its headings while mounted, and takes them back after', () => {
    const { doc, unmount } = pane('split', src);
    expect(headingsOf(doc.id)).toEqual(['A', 'C', 'E']);

    unmount();
    expect(outlineSources.has(doc.id)).toBe(false);
  });

  it('extracts no Edit-mode headings while the column is collapsed, then extracts at once on expand', () => {
    vi.useFakeTimers();
    outline.collapsed = true;
    const { doc } = pane('edit', src);

    vi.advanceTimersByTime(1000);
    flushSync();
    expect(headingsOf(doc.id)).toEqual([]);

    outline.collapsed = false;
    flushSync();
    expect(headingsOf(doc.id)).toEqual(['A', 'C', 'E']);
  });

  it('extracts no Edit-mode headings while the outline is hidden, then extracts at once when shown', () => {
    vi.useFakeTimers();
    outline.visible = false;
    const { doc } = pane('edit', src);

    vi.advanceTimersByTime(1000);
    flushSync();
    expect(headingsOf(doc.id)).toEqual([]);

    outline.visible = true;
    flushSync();
    expect(headingsOf(doc.id)).toEqual(['A', 'C', 'E']);
  });

  it('still waits for the debounce when a tab opens with the column shown (Ruling 119)', () => {
    vi.useFakeTimers();
    const { doc } = pane('edit', src);
    flushSync();
    expect(headingsOf(doc.id)).toEqual([]);

    vi.advanceTimersByTime(150);
    flushSync();
    expect(headingsOf(doc.id)).toEqual(['A', 'C', 'E']);
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
