import { describe, expect, it, vi } from 'vitest';
import { Menu } from '@tauri-apps/api/menu';
import { buildAppMenu, menuEntries, type MenuHandlers } from './menu';

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn() } }));

type Entry = {
  id?: string;
  text?: string;
  enabled?: boolean;
  item?: unknown;
  items?: Entry[];
  action?: () => void;
};

function handlers(): MenuHandlers {
  return {
    quit: vi.fn(),
    newDoc: vi.fn(),
    open: vi.fn(),
    openRecent: vi.fn(),
    clearRecent: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    closeTab: vi.fn(),
    setMode: vi.fn(),
    toggleOutline: vi.fn(),
    print: vi.fn(),
    exportPdf: vi.fn(),
    exportHtml: vi.fn(),
    exportDocx: vi.fn(),
    openSettings: vi.fn(),
  };
}

function flatten(entries: Entry[]): Entry[] {
  return entries.flatMap((e) => [e, ...flatten(e.items ?? [])]);
}

function byId(entries: Entry[], id: string): Entry {
  const found = flatten(entries).find((e) => e.id === id);
  if (!found) throw new Error(`no menu item ${id}`);
  return found;
}

describe('menuEntries', () => {
  it('puts the app menu first on macOS, with a Quit that asks about unsaved docs', () => {
    const h = handlers();
    const entries = menuEntries(h, [], true) as Entry[];

    expect(entries.map((e) => e.text)).toEqual(['Lintel', 'File', 'Edit', 'View', 'Window', 'Help']);
    const quit = entries[0].items!.at(-1)!;
    expect(quit.text).toBe('Quit Lintel');
    quit.action!();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('ends File with an Exit that calls the same quit on Windows and Linux', () => {
    const h = handlers();
    const entries = menuEntries(h, [], false) as Entry[];

    expect(entries.map((e) => e.text)).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    const exit = entries[0].items!.at(-1)!;
    expect(exit.text).toBe('Exit');
    exit.action!();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('has no predefined Quit, Close Window, Undo or Redo on any platform', () => {
    for (const mac of [true, false]) {
      const predefined = flatten(menuEntries(handlers(), [], mac) as Entry[]).map((e) => e.item);
      for (const kind of ['Quit', 'CloseWindow', 'Undo', 'Redo']) {
        expect(predefined).not.toContain(kind);
      }
    }
  });

  it('disables the items whose features come later', () => {
    const entries = menuEntries(handlers(), [], true) as Entry[];
    const later = ['settings', 'print', 'export-pdf', 'export-html', 'export-docx'];
    const modes = ['mode-edit', 'mode-split', 'mode-read', 'toggle-outline'];
    for (const id of [...later, ...modes]) expect(byId(entries, id).enabled).toBe(false);
    for (const id of ['new', 'open', 'save', 'save-as', 'close-tab', 'undo', 'redo', 'find']) {
      expect(byId(entries, id).enabled).not.toBe(false);
    }
  });

  it('lists recent paths, and disables Open Recent when there are none', () => {
    const h = handlers();
    expect(byId(menuEntries(h, [], true) as Entry[], 'open-recent').enabled).toBe(false);

    const recent = byId(menuEntries(h, ['/notes/a.md'], true) as Entry[], 'open-recent');
    expect(recent.enabled).toBe(true);
    recent.items![0].action!();
    expect(h.openRecent).toHaveBeenCalledWith('/notes/a.md');
  });
});

describe('buildAppMenu', () => {
  it('closes the menu it replaces', async () => {
    const previous = { close: vi.fn(async () => {}) };
    const built = { setAsAppMenu: vi.fn(async () => previous) };
    vi.mocked(Menu.new).mockResolvedValue(built as unknown as Menu);

    await buildAppMenu(handlers(), []);

    expect(built.setAsAppMenu).toHaveBeenCalledOnce();
    expect(previous.close).toHaveBeenCalledOnce();
  });
});
