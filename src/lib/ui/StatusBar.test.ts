import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import StatusBar from './StatusBar.svelte';

type Props = {
  line: number;
  col: number;
  words: number;
  saveState: 'saved' | 'unsaved' | 'untitled';
  lintCount: number | null;
  lintFixable: boolean;
  onFixAll?: () => void;
  lintConfigStatus?: { text: string; details: string | null } | null;
  notice: string | null;
  update: 'none' | 'ready';
  onUpdate?: () => void;
  reading?: boolean;
};

function bar(overrides: Partial<Props> = {}) {
  const props: Props = {
    line: 15,
    col: 32,
    words: 64,
    saveState: 'saved',
    lintCount: null,
    lintFixable: false,
    notice: null,
    update: 'none',
    ...overrides,
  };
  const view = render(StatusBar, props);
  return { ...view, text: () => view.container.textContent?.replace(/\s+/g, ' ').trim() };
}

describe('StatusBar', () => {
  it('shows a broken lint config in the lint area, with the error on hover (Ruling 287)', () => {
    const { getByText } = bar({
      lintCount: 2,
      lintConfigStatus: { text: 'Lint config error: .markdownlint.json', details: 'Comma expected on line 3.' },
      notice: 'a.md reloaded from disk',
    });

    const status = getByText('Lint config error: .markdownlint.json');
    expect(status.title).toBe('Comma expected on line 3.');
    expect(status.closest('.group')!.classList.contains('right')).toBe(false);
    expect(getByText('a.md reloaded from disk')).toBeTruthy();
  });

  it('shows no lint config status when there is none', () => {
    const { container } = bar({ lintCount: 0 });

    expect(container.querySelector('.lint-config')).toBeNull();
  });

  it('shows cursor, word count and save state', () => {
    const { getByText, text } = bar();

    expect(getByText('Ln 15, Col 32')).toBeTruthy();
    expect(getByText('64 words')).toBeTruthy();
    expect(getByText('Saved')).toBeTruthy();
    expect(text()).toContain('Ln 15, Col 32 · 64 words · Saved');
    expect(text()).toContain('Markdown · UTF-8');
  });

  it('shows "Unsaved" for a dirty doc and a plain label for an untitled one', () => {
    expect(bar({ saveState: 'unsaved' }).getByText('Unsaved')).toBeTruthy();
    expect(bar({ saveState: 'untitled' }).getByText('Not saved yet')).toBeTruthy();
  });

  it('shows the lint count, and no lint text when the count is null', () => {
    expect(bar({ lintCount: 2 }).getByText('2 lint warnings')).toBeTruthy();
    expect(bar({ lintCount: 1 }).getByText('1 lint warning')).toBeTruthy();

    const { text } = bar({ lintCount: null });
    expect(text()).not.toMatch(/lint/i);
  });

  it('offers Fix all only when lint is fixable and a handler is given', async () => {
    const onFixAll = vi.fn();
    expect(bar({ lintCount: 2, lintFixable: false, onFixAll }).queryByRole('button', { name: 'Fix all' })).toBeNull();

    const { getByRole } = bar({ lintCount: 2, lintFixable: true, onFixAll });
    await fireEvent.click(getByRole('button', { name: 'Fix all' }));
    expect(onFixAll).toHaveBeenCalledOnce();
  });

  it('shows "Update ready: restart" only when an update is ready', async () => {
    expect(bar({ update: 'none' }).queryByText('Update ready: restart')).toBeNull();

    const onUpdate = vi.fn();
    const { getByRole } = bar({ update: 'ready', onUpdate });
    await fireEvent.click(getByRole('button', { name: 'Update ready: restart' }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('shows a notice in place of the file type', () => {
    const { getByText, text } = bar({ notice: 'a.md reloaded from disk' });
    expect(getByText('a.md reloaded from disk')).toBeTruthy();
    expect(text()).not.toContain('UTF-8');
  });

  it('shows words and reading time, without cursor or save state, in Read mode', () => {
    const { text, queryByText } = bar({ reading: true, words: 412 });

    expect(text()).toContain('412 words · 3 min read');
    expect(queryByText('Ln 15, Col 32')).toBeNull();
    expect(queryByText('Saved')).toBeNull();
  });
});
