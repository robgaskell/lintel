import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '@tauri-apps/api/menu';
import { resetFakes } from '../../test/fakes';
import { loadSettings, updateSettings } from '../settings/settings.svelte';
import { buildAppMenu, menuEntries, syncAppMenu, type MenuHandlers } from './menu';
import { getRecent } from './recent';

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

vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../../test/fakes').then((f) => f.eventModule));
const recentList = vi.hoisted(() => ({ changed: new Set<() => void>() }));
vi.mock('./recent', () => ({
  getRecent: vi.fn(),
  onRecentChanged: (cb: () => void) => {
    recentList.changed.add(cb);
    return () => recentList.changed.delete(cb);
  },
}));

beforeEach(async () => {
  resetFakes();
  recentList.changed.clear();
  vi.mocked(getRecent).mockReset();
  vi.mocked(getRecent).mockImplementation(async (limit) => ['/notes/a.md'].slice(0, limit));
  await loadSettings();
  vi.mocked(Menu.new).mockClear();
});

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

  it('keeps recent paths in the order given, newest first', () => {
    const recent = byId(menuEntries(handlers(), ['/b.md', '/a.md'], 'macos') as Entry[], 'open-recent');
    expect(recent.items!.slice(0, 2).map((e) => e.text)).toEqual(['/b.md', '/a.md']);
  });

  it('leaves Open Recent out when the list is null (recentLimit 0)', () => {
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const ids = flatten(menuEntries(handlers(), null, platform) as Entry[]).map((e) => e.id);
      expect(ids).not.toContain('open-recent');
      expect(ids).not.toContain('clear-recent');
      expect(ids).toContain('open');
    }
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

describe('syncAppMenu', () => {
  type Built = { id?: string; text?: string; items?: Built[] };

  function lastBuild(): Built[] {
    const items = vi.mocked(Menu.new).mock.lastCall?.[0]?.items as Built[] | undefined;
    if (!items) throw new Error('no menu built');
    return items;
  }

  function openRecentIn(items: Built[]): Built | undefined {
    const all: Built[] = [];
    eachItem(items, (item) => all.push(item));
    return all.find((item) => item.id === 'open-recent');
  }

  it('builds the menu with the newest recentLimit paths', async () => {
    const stop = syncAppMenu(handlers(), vi.fn());

    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
    expect(getRecent).toHaveBeenCalledWith(5);
    expect(openRecentIn(lastBuild())?.items?.[0].text).toBe('/notes/a.md');
    stop();
  });

  it('rebuilds when the recent list changes', async () => {
    const stop = syncAppMenu(handlers(), vi.fn());
    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());

    vi.mocked(getRecent).mockResolvedValue(['/notes/b.md', '/notes/a.md']);
    for (const cb of recentList.changed) cb();

    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(2));
    expect(openRecentIn(lastBuild())?.items?.[0].text).toBe('/notes/b.md');
    stop();
  });

  it('hides Open Recent at once when recentLimit becomes 0 (Ruling 53)', async () => {
    const stop = syncAppMenu(handlers(), vi.fn());
    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
    expect(openRecentIn(lastBuild())).toBeDefined();

    await updateSettings({ recentLimit: 0 });

    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(2));
    expect(openRecentIn(lastBuild())).toBeUndefined();
    expect(getRecent).toHaveBeenCalledOnce();
    stop();
  });

  it('does not rebuild for a setting that does not touch the menu', async () => {
    const stop = syncAppMenu(handlers(), vi.fn());
    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());

    await updateSettings({ fontSize: 18 });
    await updateSettings({ recentLimit: 3 });

    await vi.waitFor(() => expect(getRecent).toHaveBeenLastCalledWith(3));
    expect(Menu.new).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores a slow list read once a later change has rebuilt the menu', async () => {
    let finishRead: (paths: string[]) => void = () => {};
    vi.mocked(getRecent).mockReturnValueOnce(new Promise((resolve) => (finishRead = resolve)));
    const stop = syncAppMenu(handlers(), vi.fn());

    await updateSettings({ recentLimit: 0 });
    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
    finishRead(['/notes/old.md']);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(Menu.new).toHaveBeenCalledOnce();
    expect(openRecentIn(lastBuild())).toBeUndefined();
    stop();
  });

  it('still builds the menu, with an empty Open Recent, when the list cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getRecent).mockRejectedValue(new Error('store gone'));
    const onError = vi.fn();
    const stop = syncAppMenu(handlers(), onError);

    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
    expect(openRecentIn(lastBuild())?.items?.map((e) => e.text)).toEqual(['Clear Menu']);
    expect(onError).not.toHaveBeenCalled();
    stop();
    error.mockRestore();
  });
});
