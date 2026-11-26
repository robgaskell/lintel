import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/svelte';
import type { Heading } from '../render/markdown';
import Outline from './Outline.svelte';

const headings: Heading[] = [
  { level: 1, text: 'Release checklist', id: 'h-release-checklist', line: 1 },
  { level: 2, text: 'Before you start', id: 'h-before-you-start', line: 5 },
  { level: 3, text: 'If the build fails', id: 'h-if-the-build-fails', line: 12 },
];

function outline(activeLine: number, onPick = vi.fn()) {
  const view = render(Outline, { headings, activeLine, onPick });
  const nav = within(view.container).getByRole('navigation', { name: 'Outline' });
  const links = within(nav).getAllByRole('link');
  return { ...view, links, onPick };
}

describe('Outline', () => {
  it('renders one link per heading, indented by level', () => {
    const { links } = outline(1);

    expect(links.map((a) => a.textContent)).toEqual(headings.map((h) => h.text));
    expect(links.map((a) => a.style.paddingLeft)).toEqual(['8px', '20px', '32px']);
    expect(links[1].getAttribute('href')).toBe('#h-before-you-start');
  });

  it('marks the heading at activeLine as current', () => {
    const { links } = outline(5);

    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'true', null]);
  });

  it('marks the last heading above activeLine when it falls between headings', () => {
    const { links } = outline(9.5);
    expect(links[1].getAttribute('aria-current')).toBe('true');

    const before = outline(0.5).links;
    expect(before.every((a) => a.getAttribute('aria-current') === null)).toBe(true);
  });

  it('calls onPick with the clicked heading and does not follow the link', async () => {
    const { links, onPick } = outline(1);

    const notPrevented = await fireEvent.click(links[2]);

    expect(onPick).toHaveBeenCalledExactlyOnceWith(headings[2]);
    expect(notPrevented).toBe(false);
  });

  it('says so when the document has no headings', () => {
    const { getByText } = render(Outline, { headings: [], activeLine: 1, onPick: vi.fn() });
    expect(getByText('No headings')).toBeTruthy();
  });
});
