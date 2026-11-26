import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import EmptyState from './EmptyState.svelte';

vi.mock('../os/platform', () => ({ isMac: () => true }));

function empty(recent: string[] = []) {
  const props = { recent, onOpen: vi.fn(), onNew: vi.fn(), onOpenRecent: vi.fn() };
  return { ...render(EmptyState, props), ...props };
}

describe('EmptyState (Ruling 106)', () => {
  it('offers Open and New with their shortcuts', async () => {
    const { container, getByRole, onOpen, onNew } = empty();

    expect(container.textContent?.replace(/\s+/g, ' ')).toContain(
      'Open a file (Cmd+O) or create one (Cmd+N)',
    );
    await fireEvent.click(getByRole('button', { name: 'Open a file' }));
    await fireEvent.click(getByRole('button', { name: 'create one' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it('lists recent files and opens the one clicked', async () => {
    const { getAllByRole, onOpenRecent } = empty(['/notes/a.md', '/work/b.md']);
    const items = getAllByRole('button').filter((b) => b.closest('ul'));

    expect(items.map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'a.md /notes',
      'b.md /work',
    ]);
    await fireEvent.click(items[1]);
    expect(onOpenRecent).toHaveBeenCalledWith('/work/b.md');
  });

  it('shows no recent section when there are none', () => {
    expect(empty([]).queryByText('Recent')).toBeNull();
  });
});
