import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import { createDoc, docs, type ViewMode } from '../docs/store.svelte';
import { largeFileNotices } from '../os/open';
import DocPane from './DocPane.svelte';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const NOTICE = 'Large file: preview is off. Switch to Split or Read to render it.';

beforeEach(() => {
  docs.clear();
  largeFileNotices.clear();
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
