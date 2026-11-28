import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { runHistory, type MenuHandlers } from '../os/menu';
import { isMac } from '../os/platform';
import WindowToolbar from './WindowToolbar.svelte';

vi.mock('../os/menu', () => ({ runHistory: vi.fn(async () => {}) }));
vi.mock('../os/platform', () => ({ isMac: vi.fn(() => true) }));

// Read from disk: the project has no Node types.
const { readFileSync } = (await import(/* @vite-ignore */ 'node:fs' as string)) as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const source = readFileSync('src/lib/ui/WindowToolbar.svelte', 'utf8');

const NAMES = ['New', 'Open', 'Save', 'Undo', 'Redo', 'Split Right', 'Split Down', 'Outline'];

function handlers() {
  return { newDoc: vi.fn(), open: vi.fn(), save: vi.fn(), split: vi.fn(), toggleOutline: vi.fn() };
}

function toolbar({ canSplit = true, outlineVisible = true } = {}) {
  const h = handlers();
  const view = render(WindowToolbar, { handlers: h as unknown as MenuHandlers, canSplit, outlineVisible });
  const buttons = () => view.getAllByRole('button') as HTMLButtonElement[];
  const button = (name: string) => view.getByRole('button', { name }) as HTMLButtonElement;
  return { ...view, h, buttons, button };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isMac).mockReturnValue(true);
});

describe('WindowToolbar (v0.2 item 5)', () => {
  it('shows New, Open, Save, Undo, Redo, Split Right, Split Down and Outline in that order', () => {
    const { buttons, getByRole } = toolbar();

    expect(getByRole('toolbar', { name: 'Window toolbar' })).toBeTruthy();
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(NAMES);
  });

  it('shows each name with its menu shortcut in Cmd form on macOS, and none where the menu has none', () => {
    const { buttons } = toolbar();

    expect(buttons().map((b) => b.title)).toEqual([
      'New (Cmd+N)',
      'Open (Cmd+O)',
      'Save (Cmd+S)',
      'Undo (Cmd+Z)',
      'Redo (Shift+Cmd+Z)',
      'Split Right (Cmd+\\)',
      'Split Down',
      'Outline',
    ]);
  });

  it('uses Ctrl in the tooltips on Windows and Linux', () => {
    vi.mocked(isMac).mockReturnValue(false);
    const { buttons } = toolbar();

    expect(buttons().map((b) => b.title)).toEqual([
      'New (Ctrl+N)',
      'Open (Ctrl+O)',
      'Save (Ctrl+S)',
      'Undo (Ctrl+Z)',
      'Redo (Shift+Ctrl+Z)',
      'Split Right (Ctrl+\\)',
      'Split Down',
      'Outline',
    ]);
  });

  it('calls the same handler as each menu item', async () => {
    const { h, button } = toolbar();

    await fireEvent.click(button('New'));
    expect(h.newDoc).toHaveBeenCalledOnce();
    await fireEvent.click(button('Open'));
    expect(h.open).toHaveBeenCalledOnce();
    await fireEvent.click(button('Save'));
    expect(h.save).toHaveBeenCalledOnce();
    await fireEvent.click(button('Undo'));
    expect(runHistory).toHaveBeenLastCalledWith('undo');
    await fireEvent.click(button('Redo'));
    expect(runHistory).toHaveBeenLastCalledWith('redo');
    expect(runHistory).toHaveBeenCalledTimes(2);
    await fireEvent.click(button('Split Right'));
    expect(h.split).toHaveBeenLastCalledWith('right');
    await fireEvent.click(button('Split Down'));
    expect(h.split).toHaveBeenLastCalledWith('below');
    expect(h.split).toHaveBeenCalledTimes(2);
    await fireEvent.click(button('Outline'));
    expect(h.toggleOutline).toHaveBeenCalledOnce();
  });

  it('greys out only Split Right and Split Down while splitting is off', async () => {
    const { h, buttons, button, rerender } = toolbar({ canSplit: false });

    const disabled = buttons().filter((b) => b.disabled).map((b) => b.getAttribute('aria-label'));
    expect(disabled).toEqual(['Split Right', 'Split Down']);
    // click() is what a user's click does: jsdom, like a browser, skips it on a disabled button.
    button('Split Right').click();
    button('Split Down').click();
    expect(h.split).not.toHaveBeenCalled();

    await rerender({ canSplit: true });
    expect(buttons().some((b) => b.disabled)).toBe(false);
  });

  it('presses Outline while the outline is shown', async () => {
    const { button, buttons, rerender } = toolbar({ outlineVisible: true });

    expect(button('Outline').getAttribute('aria-pressed')).toBe('true');
    expect(buttons().filter((b) => b.hasAttribute('aria-pressed'))).toHaveLength(1);

    await rerender({ outlineVisible: false });
    expect(button('Outline').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps focus where it is on mouse down, so Undo acts on the editor that had it', async () => {
    const { buttons } = toolbar();

    for (const b of buttons()) expect(await fireEvent.mouseDown(b)).toBe(false);
  });

  it('draws each icon as inline 16 px SVG in currentColor at stroke-width 2 (Ruling 6)', () => {
    const { buttons, container } = toolbar();

    for (const b of buttons()) {
      const svg = b.querySelector('svg');
      expect(svg, b.title).not.toBeNull();
      expect([svg!.getAttribute('width'), svg!.getAttribute('height')]).toEqual(['16', '16']);
      expect(svg!.getAttribute('stroke')).toBe('currentColor');
      expect(svg!.getAttribute('stroke-width')).toBe('2');
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
    }
    expect(container.querySelector('img')).toBeNull();
  });

  it('dims a disabled button to 0.4 with no hover, and gives the pressed one the hover tint in accent (Ruling 6)', () => {
    expect(source).toMatch(/button:disabled \{[^}]*opacity: 0\.4;/);
    expect(source).toMatch(/button:hover:not\(:disabled\) \{[^}]*background: var\(--toolbar-hover\)/);
    expect(source).not.toMatch(/button:hover \{/);
    expect(source).toMatch(/button\[aria-pressed='true'\] \{[^}]*background: var\(--hover\);[^}]*color: var\(--accent\);/);
  });

  it("matches the formatting bar's button size, radius, colour and focus ring", () => {
    expect(source).toMatch(/button \{[^}]*width: 32px;[^}]*height: 30px;[^}]*border-radius: 6px;[^}]*color: var\(--toolbar-icon\);/);
    expect(source).toMatch(/button:focus-visible \{[^}]*outline: 2px solid var\(--accent\);[^}]*outline-offset: -2px;/);
    expect(source).toMatch(/\.window-toolbar \{[^}]*background: var\(--chrome\);[^}]*border-bottom: 1px solid var\(--toolbar-border\);/);
  });
});
