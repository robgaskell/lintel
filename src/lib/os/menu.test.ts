import { describe, expect, it, vi } from 'vitest';
import { Menu } from '@tauri-apps/api/menu';
import { buildAppMenu, menuEntries, type MenuHandlers } from './menu';

// Models Tauri: one app-wide id -> handler map; a later item with the same id replaces
// the handler, and closing a menu removes its ids whoever owns them now.
const tauri = vi.hoisted(() => ({
  channels: new Map<string, (id: string) => void>(),
  appMenu: null as unknown,
}));

type Built = { id?: string; action?: (id: string) => void; items?: Built[] };

function eachItem(items: Built[], visit: (item: Built) => void): void {
  for (const item of items) {
    visit(item);
    eachItem(item.items ?? [], visit);
  }
}

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: vi.fn(async ({ items }: { items: Built[] }) => {
      eachItem(items, (item) => {
        if (item.id && item.action) tauri.channels.set(item.id, item.action);
      });
      const menu = {
        setAsAppMenu: vi.fn(async () => {
          const previous = tauri.appMenu;
          tauri.appMenu = menu;
          return previous;
        }),
        close: vi.fn(async () => {
          eachItem(items, (item) => item.id && tauri.channels.delete(item.id));
        }),
      };
      return menu;
    }),
  },
}));

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
    const entries = menuEntries(h, [], 'macos') as Entry[];

    expect(entries.map((e) => e.text)).toEqual(['Lintel', 'File', 'Edit', 'View', 'Window', 'Help']);
    const quit = entries[0].items!.at(-1)!;
    expect(quit.text).toBe('Quit Lintel');
    quit.action!();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('ends File with an Exit that calls the same quit on Windows and Linux', () => {
    const h = handlers();
    const entries = menuEntries(h, [], 'windows') as Entry[];

    expect(entries.map((e) => e.text)).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    const exit = entries[0].items!.at(-1)!;
    expect(exit.text).toBe('Exit');
    exit.action!();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('leaves out the Window menu on Linux, where GTK cannot minimize or maximize', () => {
    const entries = menuEntries(handlers(), [], 'linux') as Entry[];

    expect(entries.map((e) => e.text)).toEqual(['File', 'Edit', 'View', 'Help']);
    const predefined = flatten(entries).map((e) => e.item);
    expect(predefined).not.toContain('Minimize');
    expect(predefined).not.toContain('Maximize');
  });

  it('has no predefined Quit, Close Window, Undo or Redo on any platform', () => {
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const predefined = flatten(menuEntries(handlers(), [], platform) as Entry[]).map((e) => e.item);
      for (const kind of ['Quit', 'CloseWindow', 'Undo', 'Redo']) {
        expect(predefined).not.toContain(kind);
      }
    }
  });

  it('disables the items whose features come later', () => {
    const entries = menuEntries(handlers(), [], 'macos') as Entry[];
    const later = ['settings', 'print', 'export-pdf', 'export-html', 'export-docx'];
    const modes = ['mode-edit', 'mode-split', 'mode-read', 'toggle-outline'];
    for (const id of [...later, ...modes]) expect(byId(entries, id).enabled).toBe(false);
    for (const id of ['new', 'open', 'save', 'save-as', 'close-tab', 'undo', 'redo', 'find']) {
      expect(byId(entries, id).enabled).not.toBe(false);
    }
  });

  it('lists recent paths, and disables Open Recent when there are none', () => {
    const h = handlers();
    expect(byId(menuEntries(h, [], 'macos') as Entry[], 'open-recent').enabled).toBe(false);

    const recent = byId(menuEntries(h, ['/notes/a.md'], 'macos') as Entry[], 'open-recent');
    expect(recent.enabled).toBe(true);
    recent.items![0].action!();
    expect(h.openRecent).toHaveBeenCalledWith('/notes/a.md');
  });
});

describe('buildAppMenu', () => {
  function click(base: string): void {
    const hits = [...tauri.channels].filter(([id]) => id.split('#')[0] === base);
    expect(hits).toHaveLength(1);
    const [id, action] = hits[0];
    action(id);
  }

  it('keeps every item working after a rebuild closes the old menu', async () => {
    const h = handlers();

    await buildAppMenu(h, []);
    await buildAppMenu(h, ['/notes/a.md']);
    click('quit');
    click('save');

    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.save).toHaveBeenCalledOnce();
    expect(vi.mocked(Menu.new)).toHaveBeenCalledTimes(2);
  });
});
