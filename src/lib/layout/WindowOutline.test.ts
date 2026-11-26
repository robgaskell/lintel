import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { outline, outlineSources } from './outline.svelte';
import WindowOutline from './WindowOutline.svelte';

function source(text: string) {
  return { headings: [{ level: 1 as const, text, id: 'h-intro', line: 1 }], activeLine: 1, pick: vi.fn() };
}

beforeEach(() => {
  outline.visible = true;
  outlineSources.clear();
});

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
  });
});
