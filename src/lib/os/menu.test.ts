import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '@tauri-apps/api/menu';
import { history } from '@codemirror/commands';
import { search } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createDoc } from '../docs/store.svelte';
import { registerView, setActiveDocSource } from '../editor/views';
import { events, resetFakes } from '../../test/fakes';
import { loadSettings, updateSettings } from '../settings/settings.svelte';
import { buildAppMenu, menuEntries, syncAppMenu, type MenuHandlers } from './menu';
import { getRecent, knownRecent } from './recent';

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
  knownRecent: vi.fn(),
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
  vi.mocked(knownRecent).mockReset();
  vi.mocked(knownRecent).mockImplementation(async (limit) => ['/notes/a.md'].slice(0, limit));
  await loadSettings();
  vi.mocked(Menu.new).mockClear();
});

type Entry = {
  id?: string;
  text?: string;
  enabled?: boolean;
  accelerator?: string;
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
    for (const id of [...later, 'toggle-outline']) expect(byId(entries, id).enabled).toBe(false);
    const ready = ['new', 'open', 'save', 'save-as', 'close-tab', 'undo', 'redo', 'find'];
    for (const id of [...ready, 'mode-edit', 'mode-split', 'mode-read']) {
      expect(byId(entries, id).enabled).not.toBe(false);
    }
  });

  it('sets the mode from View > Edit, Split and Read, on Mod-1, 2 and 3', () => {
    const h = handlers();
    const entries = menuEntries(h, [], 'macos') as Entry[];
    const cases = [
      ['mode-edit', 'edit', 'CmdOrCtrl+1'],
      ['mode-split', 'split', 'CmdOrCtrl+2'],
      ['mode-read', 'read', 'CmdOrCtrl+3'],
    ] as const;
    for (const [id, mode, accelerator] of cases) {
      const item = byId(entries, id);
      expect(item.accelerator).toBe(accelerator);
      item.action!();
      expect(h.setMode).toHaveBeenLastCalledWith(mode);
    }
  });

  it('leaves the hidden editor alone in Read: Undo, Redo and Find do nothing (Ruling 97)', () => {
    const doc = createDoc({ path: '/r.md', raw: 'a', hash: 'h', mode: 'read' });
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'a', extensions: [history(), search()] }),
    });
    const forget = registerView(doc.id, view);
    setActiveDocSource({ activeDocId: () => doc.id });
    view.dispatch({ changes: { from: 1, insert: 'b' } });
    const entries = menuEntries(handlers(), [], 'macos') as Entry[];

    byId(entries, 'undo').action!();
    byId(entries, 'find').action!();
    expect(view.state.doc.toString()).toBe('ab');
    expect(view.dom.querySelector('.cm-search')).toBeNull();

    doc.mode = 'split';
    byId(entries, 'undo').action!();
    expect(view.state.doc.toString()).toBe('a');
    byId(entries, 'redo').action!();
    expect(view.state.doc.toString()).toBe('ab');

    doc.mode = 'read';
    byId(entries, 'undo').action!();
    expect(view.state.doc.toString()).toBe('ab');

    forget();
    setActiveDocSource(null);
    view.destroy();
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

  it('doubles & in a path label so it is not read as a mnemonic, and opens the real path', () => {
    const h = handlers();
    const recent = byId(menuEntries(h, ['/R&D/a.md'], 'macos') as Entry[], 'open-recent');

    expect(recent.items![0].text).toBe('/R&&D/a.md');
    recent.items![0].action!();
    expect(h.openRecent).toHaveBeenCalledWith('/R&D/a.md');
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

  function recentTexts(): string[] | undefined {
    return openRecentIn(lastBuild())?.items?.map((e) => e.text ?? '');
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('builds the menu with the newest recentLimit paths, once when the check changes nothing', async () => {
    const stop = syncAppMenu(handlers(), vi.fn());

    await vi.waitFor(() => expect(getRecent).toHaveBeenCalledWith(5));
    await settle();
    expect(Menu.new).toHaveBeenCalledOnce();
    expect(knownRecent).toHaveBeenCalledWith(5);
    expect(recentTexts()?.[0]).toBe('/notes/a.md');
    stop();
  });

  it('builds at once from the stored list while the disk check is slow, then refines it', async () => {
    const check = deferred<string[]>();
    vi.mocked(getRecent).mockReturnValueOnce(check.promise);
    const stop = syncAppMenu(handlers(), vi.fn());

    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
    expect(recentTexts()?.[0]).toBe('/notes/a.md');

    check.resolve([]);
    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(2));
    expect(recentTexts()).toEqual(['Clear Menu']);
    stop();
  });

  it('rebuilds when the recent list changes', async () => {
    const stop = syncAppMenu(handlers(), vi.fn());
    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());

    vi.mocked(knownRecent).mockResolvedValue(['/notes/b.md', '/notes/a.md']);
    vi.mocked(getRecent).mockResolvedValue(['/notes/b.md', '/notes/a.md']);
    for (const cb of recentList.changed) cb();

    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(2));
    expect(recentTexts()?.[0]).toBe('/notes/b.md');
    stop();
  });

  it('rebuilds once for a burst of changes', async () => {
    const stop = syncAppMenu(handlers(), vi.fn());
    await vi.waitFor(() => expect(getRecent).toHaveBeenCalledOnce());

    // Spaced out like the writes of a multi-file open, so each would finish on its own.
    for (let i = 0; i < 3; i++) {
      for (const cb of recentList.changed) cb();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await settle();

    expect(getRecent).toHaveBeenCalledTimes(2);
    expect(Menu.new).toHaveBeenCalledTimes(2);
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
    await settle();
    expect(Menu.new).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores a slow list check once a later change has rebuilt the menu', async () => {
    const check = deferred<string[]>();
    vi.mocked(getRecent).mockReturnValueOnce(check.promise);
    const stop = syncAppMenu(handlers(), vi.fn());
    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());

    await updateSettings({ recentLimit: 0 });
    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(2));
    check.resolve(['/notes/old.md']);
    await settle();

    expect(Menu.new).toHaveBeenCalledTimes(2);
    expect(openRecentIn(lastBuild())).toBeUndefined();
    stop();
  });

  it('still builds the menu, with an empty Open Recent, when the list cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(knownRecent).mockRejectedValue(new Error('store gone'));
    vi.mocked(getRecent).mockRejectedValue(new Error('store gone'));
    const onError = vi.fn();
    const stop = syncAppMenu(handlers(), onError);

    await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
    await settle();
    expect(Menu.new).toHaveBeenCalledOnce();
    expect(recentTexts()).toEqual(['Clear Menu']);
    expect(onError).not.toHaveBeenCalled();
    stop();
    error.mockRestore();
  });

  it('reports a settings listener that could not be registered', async () => {
    events.failNextListen = new Error('event plugin down');
    const onError = vi.fn();
    const stop = syncAppMenu(handlers(), onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(new Error('event plugin down')));
    stop();
  });
});
