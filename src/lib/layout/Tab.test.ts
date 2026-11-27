import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { createDoc, docs, type DocState } from '../docs/store.svelte';
import Tab from './Tab.svelte';

vi.mock('../ipc', () => ({
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
}));

beforeEach(() => docs.clear());

function tab(external: DocState['external']) {
  const doc = createDoc({ path: '/notes/a.md', raw: '', hash: 'h', mode: 'edit' });
  doc.external = external;
  return render(Tab, { doc, onClose: vi.fn() });
}

describe('Tab', () => {
  it('shows "Updated" for a doc reloaded while its tab was not active', () => {
    const { container } = tab('updated');
    expect(container.querySelector('.lintel-tab')?.textContent).toContain('Updated');
  });

  it('shows "Deleted on disk" for a doc whose file is gone', () => {
    const { container } = tab('deleted');
    expect(container.querySelector('.lintel-tab')?.textContent).toContain('Deleted on disk');
  });

  it('shows neither for a doc in step with its file, or in conflict', () => {
    for (const external of ['none', 'conflict'] as const) {
      const { container, unmount } = tab(external);
      const text = container.querySelector('.lintel-tab')?.textContent ?? '';
      expect(text).not.toMatch(/Updated|Deleted on disk/);
      unmount();
    }
  });
});
