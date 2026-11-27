import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import ConflictBanner from './ConflictBanner.svelte';

// The tsconfig has no Node types, as in theme.test.ts.
const { readFileSync } = (await import(/* @vite-ignore */ 'node:fs' as string)) as {
  readFileSync(path: string, encoding: 'utf8'): string;
};

function banner() {
  const props = { fileName: 'plan.md', onKeep: vi.fn(), onLoad: vi.fn() };
  return { ...render(ConflictBanner, props), ...props };
}

describe('ConflictBanner', () => {
  it('names the file, in the words of the Reload artboard', () => {
    const { getByRole } = banner();

    expect(getByRole('alert').textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'plan.md changed on disk while you have unsaved edits. Keep my edits Load disk version',
    );
  });

  it('puts both buttons in one row, with room for a third (Ruling 261)', () => {
    const { getByRole } = banner();

    const keep = getByRole('button', { name: 'Keep my edits' });
    const load = getByRole('button', { name: 'Load disk version' });
    expect(keep.parentElement).toBe(load.parentElement);
    expect(keep.parentElement?.children).toHaveLength(2);
  });

  it('calls one handler per button', async () => {
    const { getByRole, onKeep, onLoad } = banner();

    await fireEvent.click(getByRole('button', { name: 'Keep my edits' }));
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onLoad).not.toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Load disk version' }));
    expect(onLoad).toHaveBeenCalledOnce();
  });
});

describe('ConflictBanner layout (Ruling 265)', () => {
  // jsdom applies no component CSS, so the rule itself is checked.
  it('keeps its buttons on one line and lets the message wrap instead', () => {
    const css = readFileSync('src/lib/ui/ConflictBanner.svelte', 'utf8');
    expect(css).toMatch(/\.conflict \{[^}]*flex-wrap: nowrap/);
    expect(css).toMatch(/\.actions \{[^}]*flex: none[^}]*flex-wrap: nowrap/);
    expect(css).toMatch(/\.message \{[^}]*min-width: 0/);
    expect(css).toMatch(/button \{[^}]*white-space: nowrap/);
  });
});
