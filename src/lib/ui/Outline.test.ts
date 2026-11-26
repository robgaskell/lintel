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

  it('ignores modifier clicks and stops middle-click defaults (Ruling 122)', async () => {
    const { links, onPick } = outline(1);

    expect(await fireEvent.click(links[1], { metaKey: true })).toBe(false);
    expect(await fireEvent.click(links[1], { shiftKey: true })).toBe(false);
    expect(await fireEvent(links[1], new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('is one tab stop, on the current heading, moved by arrow keys; Enter picks (Ruling 122)', async () => {
    const { links, onPick } = outline(5);
    expect(links.map((a) => a.tabIndex)).toEqual([-1, 0, -1]);

    links[1].focus();
    await fireEvent.keyDown(links[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(links[2]);
    expect(links.map((a) => a.tabIndex)).toEqual([-1, -1, 0]);

    await fireEvent.keyDown(links[2], { key: 'Home' });
    expect(document.activeElement).toBe(links[0]);
    await fireEvent.keyDown(links[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(links[0]);
    await fireEvent.keyDown(links[0], { key: 'End' });
    expect(document.activeElement).toBe(links[2]);

    await fireEvent.keyDown(links[2], { key: 'Enter' });
    expect(onPick).toHaveBeenCalledExactlyOnceWith(headings[2]);
  });

  it('makes the first row the tab stop when no heading is current', () => {
    const { links } = outline(0.5);
    expect(links.map((a) => a.tabIndex)).toEqual([0, -1, -1]);
  });

  it('updates at most two rows when the current heading changes (Ruling 119)', async () => {
    const reads = new Set<number>();
    const many = Array.from({ length: 100 }, (_, i) => {
      const plain = { level: 2 as const, id: `h-s${i}`, line: i * 10 + 1 };
      // Rows re-render by reading text; count which headings were read.
      return Object.defineProperty(plain, 'text', {
        enumerable: true,
        get: () => (reads.add(i), `Section ${i}`),
      }) as Heading;
    });
    const view = render(Outline, { headings: many, activeLine: 1, onPick: vi.fn() });
    reads.clear();

    await view.rerender({ activeLine: 41 });

    expect([...reads].every((i) => i === 0 || i === 4)).toBe(true);
    const current = view.container.querySelector('[aria-current="true"]');
    expect(current?.textContent).toBe('Section 4');
  });

  it('shows at most 5,000 rows and says how many more there are (Ruling 119)', () => {
    const many: Heading[] = Array.from({ length: 5003 }, (_, i) => ({
      level: 2,
      text: `S${i}`,
      id: `h-s${i}`,
      line: i + 1,
    }));
    const view = render(Outline, { headings: many, activeLine: 1, onPick: vi.fn() });

    expect(view.container.querySelectorAll('a')).toHaveLength(5000);
    expect(view.getByText('… 3 more headings')).toBeTruthy();
  });

  it('says so when the document has no headings', () => {
    const { getByText } = render(Outline, { headings: [], activeLine: 1, onPick: vi.fn() });
    expect(getByText('No headings')).toBeTruthy();
  });
});
