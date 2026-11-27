import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckMenuItem, Menu, MenuItem } from '@tauri-apps/api/menu';
import { history } from '@codemirror/commands';
import { search } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createDoc } from '../docs/store.svelte';
import { outline } from '../layout/outline.svelte';
import { registerView, setActiveDocSource } from '../editor/views';
import { eventModule, events, listenCalls, resetFakes } from '../../test/fakes';
import { loadSettings, updateSettings } from '../settings/settings.svelte';
import {
  buildAppMenu,
  menuEntries,
  setOutlineChecked,
  setSplitEnabled,
  syncAppMenu,
  takeAppMenu,
  type MenuHandlers,
} from './menu';
import { getRecent, knownRecent } from './recent';
import { focusedSettingsWindow } from '../../settings/settingsWindow';

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
  CheckMenuItem: {
    new: vi.fn(async (opts: { id: string; action: (id: string) => void; checked: boolean }) => {
      tauri.channels.set(opts.id, opts.action);
      return {
        id: opts.id,
        checked: opts.checked,
        setChecked: vi.fn(async function (this: { checked: boolean }, checked: boolean) {
          this.checked = checked;
        }),
        close: vi.fn(async () => {}),
      };
    }),
  },
  MenuItem: {
    new: vi.fn(async (opts: { id: string; action: (id: string) => void; enabled?: boolean }) => {
      tauri.channels.set(opts.id, opts.action);
      return {
        id: opts.id,
        enabled: opts.enabled ?? true,
        setEnabled: vi.fn(async function (this: { enabled: boolean }, enabled: boolean) {
          this.enabled = enabled;
        }),
        close: vi.fn(async () => {}),
      };
    }),
  },
}));

vi.mock('../../settings/settingsWindow', () => ({ focusedSettingsWindow: vi.fn(async () => null) }));
const thisWindow = vi.hoisted(() => ({ label: 'main', isFocused: vi.fn(async () => true) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => thisWindow }));
vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/core', () => import('../../test/fakes').then((f) => f.coreModule));
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
  vi.mocked(CheckMenuItem.new).mockClear();
  await setSplitEnabled(true);
  vi.mocked(MenuItem.new).mockClear();
  vi.mocked(focusedSettingsWindow).mockResolvedValue(null);
  outline.visible = true;
  thisWindow.label = 'main';
  thisWindow.isFocused.mockReset();
  thisWindow.isFocused.mockResolvedValue(true);
  // A test may leave the menu with another window.
  takeAppMenu();
});

// Edit commands first ask which window is focused (Ruling 142).
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    nextTab: vi.fn(),
    previousTab: vi.fn(),
    split: vi.fn(),
    openNotices: vi.fn(),
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

  it('gives Linux a Window menu with only the tab switching items, as GTK cannot minimize or maximize', () => {
    const entries = menuEntries(handlers(), [], 'linux') as Entry[];

    expect(entries.map((e) => e.text)).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    expect(entries[3].items!.map((e) => e.text)).toEqual(['Show Next Tab', 'Show Previous Tab']);
    const predefined = flatten(entries).map((e) => e.item);
    expect(predefined).not.toContain('Minimize');
    expect(predefined).not.toContain('Maximize');
  });

  it.each([
    ['macos', 'CmdOrCtrl+Shift+]', 'CmdOrCtrl+Shift+['],
    ['windows', 'Ctrl+Tab', 'Ctrl+Shift+Tab'],
    ['linux', 'Ctrl+Tab', 'Ctrl+Shift+Tab'],
  ] as const)('puts Show Next and Show Previous Tab in the Window menu on %s (Ruling 167)', (platform, next, previous) => {
    const h = handlers();
    const entries = menuEntries(h, [], platform) as Entry[];
    const window = entries.find((e) => e.text === 'Window')!;

    const nextItem = byId(window.items!, 'next-tab');
    const previousItem = byId(window.items!, 'previous-tab');
    expect([nextItem.text, nextItem.accelerator]).toEqual(['Show Next Tab', next]);
    expect([previousItem.text, previousItem.accelerator]).toEqual(['Show Previous Tab', previous]);
    nextItem.action!();
    previousItem.action!();
    expect(h.nextTab).toHaveBeenCalledOnce();
    expect(h.previousTab).toHaveBeenCalledOnce();
  });

  it.each([
    ['macos', ['third-party-notices']],
    ['windows', ['About', 'Separator', 'third-party-notices']],
    ['linux', ['About', 'Separator', 'third-party-notices']],
  ] as const)('puts Third-Party Notices in the Help menu on %s (Ruling 328)', (platform, expected) => {
    const h = handlers();
    const help = (menuEntries(h, [], platform) as Entry[]).find((e) => e.text === 'Help')!;

    const kinds = help.items!.map((e) => e.id ?? (typeof e.item === 'string' ? e.item : Object.keys(e.item!)[0]));
    expect(kinds).toEqual(expected);
    const item = byId(help.items!, 'third-party-notices');
    expect(item.text).toBe('Third-Party Notices');
    item.action!();
    expect(h.openNotices).toHaveBeenCalledOnce();
  });

  it('has no predefined Quit, Close Window, Undo or Redo on any platform', () => {
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const predefined = flatten(menuEntries(handlers(), [], platform) as Entry[]).map((e) => e.item);
      for (const kind of ['Quit', 'CloseWindow', 'Undo', 'Redo']) {
        expect(predefined).not.toContain(kind);
      }
    }
  });

  it('enables Export as Word along with the other items', () => {
    const entries = menuEntries(handlers(), [], 'macos') as Entry[];
    const ready = [
      ...['settings', 'new', 'open', 'save', 'save-as', 'close-tab', 'undo', 'redo', 'find', 'toggle-outline'],
      ...['split-right', 'split-down', 'print', 'export-pdf', 'export-html', 'export-docx'],
    ];
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

  it.each(['macos', 'windows', 'linux'] as const)(
    'puts Split Right on CmdOrCtrl+\\ and Split Down in View on %s (Ruling 180)',
    (platform) => {
      const h = handlers();
      const view = (menuEntries(h, [], platform) as Entry[]).find((e) => e.text === 'View')!;

      const right = byId(view.items!, 'split-right');
      const down = byId(view.items!, 'split-down');
      expect([right.text, right.accelerator]).toEqual(['Split Right', 'CmdOrCtrl+\\']);
      expect([down.text, down.accelerator]).toEqual(['Split Down', undefined]);
      right.action!();
      expect(h.split).toHaveBeenLastCalledWith('right');
      down.action!();
      expect(h.split).toHaveBeenLastCalledWith('below');
    },
  );

  it('makes View > Show Outline a check item that follows the outline and toggles it (Ruling 110)', () => {
    const h = handlers();
    const item = byId(menuEntries(h, [], 'macos') as Entry[], 'toggle-outline') as Entry & {
      checked?: boolean;
    };
    expect(item.text).toBe('Show Outline');
    expect(item.checked).toBe(true);

    item.action!();
    expect(h.toggleOutline).toHaveBeenCalledOnce();

    outline.visible = false;
    const hidden = byId(menuEntries(h, [], 'macos') as Entry[], 'toggle-outline') as { checked?: boolean };
    expect(hidden.checked).toBe(false);
  });

  it('opens Settings from Settings… on Cmd+, in the app menu on macOS and in File elsewhere (Ruling 141)', () => {
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const h = handlers();
      const entries = menuEntries(h, [], platform) as Entry[];
      const item = byId(entries, 'settings');
      expect(item.text).toBe('Settings…');
      expect(item.accelerator).toBe('CmdOrCtrl+,');
      item.action!();
      expect(h.openSettings).toHaveBeenCalledOnce();
      const home = platform === 'macos' ? entries[0] : entries.find((e) => e.text === 'File')!;
      expect(home.items!.some((e) => e.id === 'settings')).toBe(true);
    }
  });

  it('leaves the editor alone while Settings is focused: Undo, Redo and Find do nothing (Ruling 142)', async () => {
    const doc = createDoc({ path: '/s.md', raw: 'a', hash: 'h', mode: 'split' });
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'a', extensions: [history(), search()] }),
    });
    const forget = registerView(doc.id, view);
    setActiveDocSource({ activeDocId: () => doc.id });
    view.dispatch({ changes: { from: 1, insert: 'b' } });
    const entries = menuEntries(handlers(), [], 'macos') as Entry[];
    vi.mocked(focusedSettingsWindow).mockResolvedValue({} as never);

    byId(entries, 'undo').action!();
    byId(entries, 'find').action!();
    await settle();
    expect(view.state.doc.toString()).toBe('ab');
    expect(view.dom.querySelector('.cm-search')).toBeNull();

    vi.mocked(focusedSettingsWindow).mockResolvedValue(null);
    byId(entries, 'undo').action!();
    await settle();
    expect(view.state.doc.toString()).toBe('a');

    forget();
    setActiveDocSource(null);
    view.destroy();
  });

  it('leaves the hidden editor alone in Read: Undo, Redo and Find do nothing (Ruling 97)', async () => {
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
    await settle();
    expect(view.state.doc.toString()).toBe('ab');
    expect(view.dom.querySelector('.cm-search')).toBeNull();

    doc.mode = 'split';
    byId(entries, 'undo').action!();
    await settle();
    expect(view.state.doc.toString()).toBe('a');
    byId(entries, 'redo').action!();
    await settle();
    expect(view.state.doc.toString()).toBe('ab');

    doc.mode = 'read';
    byId(entries, 'undo').action!();
    await settle();
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

  it("stamps every id with this window's label, so windows never share an id (Ruling 188)", async () => {
    await buildAppMenu(handlers(), []);

    const ids = [...tauri.channels.keys()];
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id).toMatch(/^[a-z-]+#main#\d+$/);
  });

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

  it('builds Show Outline as a check item and ticks it without a rebuild (Ruling 110)', async () => {
    const h = handlers();
    await buildAppMenu(h, []);
    const first = await vi.mocked(CheckMenuItem.new).mock.results[0].value;
    expect(first.checked).toBe(true);
    // The live item itself goes into the menu, or ticking it would change nothing on screen.
    const view = (vi.mocked(Menu.new).mock.lastCall![0]!.items as Built[]).find(
      (entry) => (entry as { text?: string }).text === 'View',
    );
    expect(view?.items).toContain(first);

    await setOutlineChecked(false);

    expect(first.setChecked).toHaveBeenLastCalledWith(false);
    expect(Menu.new).toHaveBeenCalledOnce();
  });

  it('greys out View > Split Right and Split Down without a rebuild (Ruling 192)', async () => {
    await buildAppMenu(handlers(), []);
    const live = await Promise.all(vi.mocked(MenuItem.new).mock.results.map((r) => r.value));
    const splits = live.filter((item) => /^split-(right|down)#/.test(item.id));
    expect(splits).toHaveLength(2);
    const view = (vi.mocked(Menu.new).mock.lastCall![0]!.items as Built[]).find(
      (entry) => (entry as { text?: string }).text === 'View',
    );
    for (const item of splits) expect(view?.items).toContain(item);

    await setSplitEnabled(false);
    for (const item of splits) expect(item.enabled).toBe(false);
    await setSplitEnabled(true);
    for (const item of splits) expect(item.enabled).toBe(true);
    expect(Menu.new).toHaveBeenCalledOnce();
  });

  it('builds the splits greyed when the active tab is already alone, and keeps a change made mid-build', async () => {
    await setSplitEnabled(false);
    await buildAppMenu(handlers(), []);
    const first = await Promise.all(vi.mocked(MenuItem.new).mock.results.map((r) => r.value));
    expect(first.map((item) => item.enabled)).toEqual([false, false]);

    vi.mocked(MenuItem.new).mockClear();
    const real = vi.mocked(MenuItem.new).getMockImplementation()!;
    vi.mocked(MenuItem.new).mockImplementationOnce(async (opts) => {
      const item = await real(opts);
      void setSplitEnabled(true); // the active tab changes mid-build
      return item;
    });
    await buildAppMenu(handlers(), []);
    const second = await Promise.all(vi.mocked(MenuItem.new).mock.results.map((r) => r.value));
    expect(second.map((item) => item.enabled)).toEqual([true, true]);
    for (const item of first) expect(item.close).toHaveBeenCalled();
  });

  it('re-ticks the item when the outline is toggled while the menu is being built', async () => {
    const real = vi.mocked(CheckMenuItem.new).getMockImplementation()!;
    vi.mocked(CheckMenuItem.new).mockImplementationOnce(async (opts) => {
      const item = await real(opts);
      outline.visible = false; // a toggle lands mid-build
      return item;
    });

    await buildAppMenu(handlers(), []);

    const item = await vi.mocked(CheckMenuItem.new).mock.results[0].value;
    expect(item.checked).toBe(false);
    expect(item.setChecked).toHaveBeenCalledWith(false);
  });

  it('moves the tick to the new item after a rebuild, which starts with the current value', async () => {
    const h = handlers();
    await buildAppMenu(h, []);
    const first = await vi.mocked(CheckMenuItem.new).mock.results[0].value;
    outline.visible = false;

    await buildAppMenu(h, ['/notes/a.md']);
    const second = await vi.mocked(CheckMenuItem.new).mock.results[1].value;
    expect(second.checked).toBe(false);
    expect(first.close).toHaveBeenCalled();

    click('toggle-outline');
    expect(h.toggleOutline).toHaveBeenCalledOnce();
    await setOutlineChecked(true);
    expect(second.setChecked).toHaveBeenLastCalledWith(true);
    expect(first.setChecked).not.toHaveBeenCalledWith(true);
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

  describe('with several document windows (Ruling 188)', () => {
    const otherWindowTakesTheMenu = async () => {
      await eventModule.emit('lintel://menu-owner', 'w-2');
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    it('tells the other windows when this one installs the menu', async () => {
      const listener = vi.fn();
      await eventModule.listen('lintel://menu-owner', listener);

      await buildAppMenu(handlers(), []);

      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ payload: 'main' })));
    });

    it('leaves the menu alone on a recent-list change once another window has it', async () => {
      const stop = syncAppMenu(handlers(), vi.fn());
      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
      await settle();
      await otherWindowTakesTheMenu();

      for (const cb of recentList.changed) cb();
      await updateSettings({ recentLimit: 3 });
      await settle();

      expect(Menu.new).toHaveBeenCalledOnce();
      stop();
    });

    it('rebuilds the menu when this window gains focus after another had it', async () => {
      const stop = syncAppMenu(handlers(), vi.fn());
      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
      await settle();
      await otherWindowTakesTheMenu();

      takeAppMenu();

      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(2));
      for (const cb of recentList.changed) cb();
      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(3));
      stop();
    });

    async function installedCount(): Promise<number> {
      let count = 0;
      for (const result of vi.mocked(Menu.new).mock.results) {
        const menu = (await result.value) as unknown as { setAsAppMenu: ReturnType<typeof vi.fn> };
        count += menu.setAsAppMenu.mock.calls.length;
      }
      return count;
    }

    it('gives up a rebuild once this window has lost focus, leaving the shown menu (Ruling 198)', async () => {
      const stop = syncAppMenu(handlers(), vi.fn());
      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
      await settle();
      thisWindow.isFocused.mockResolvedValue(false);

      for (const cb of recentList.changed) cb();
      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledTimes(2));
      await settle();

      expect(await installedCount()).toBe(1);
      const unused = (await vi.mocked(Menu.new).mock.results[1].value) as unknown as {
        close: ReturnType<typeof vi.fn>;
      };
      expect(unused.close).toHaveBeenCalled();

      thisWindow.isFocused.mockResolvedValue(true);
      takeAppMenu();
      await vi.waitFor(async () => expect(await installedCount()).toBe(2));
      stop();
    });

    it("hears Rust's menu hand-over only when it names this window (Rulings 198, 213)", async () => {
      const stop = syncAppMenu(handlers(), vi.fn());
      await vi.waitFor(() =>
        expect(listenCalls).toContainEqual({
          event: 'lintel://menu-claim',
          options: { target: { kind: 'WebviewWindow', label: 'main' } },
        }),
      );
      stop();
    });

    it('takes the menu at once when Rust hands it over, focused or not (Ruling 198)', async () => {
      const stop = syncAppMenu(handlers(), vi.fn());
      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
      await settle();
      await otherWindowTakesTheMenu();
      thisWindow.isFocused.mockResolvedValue(false);

      await eventModule.emit('lintel://menu-claim');

      await vi.waitFor(async () => expect(await installedCount()).toBe(2));
      stop();
    });

    it("builds the main window's first menu while it is still hidden, but not a new window's", async () => {
      thisWindow.isFocused.mockResolvedValue(false);
      let stop = syncAppMenu(handlers(), vi.fn());
      await vi.waitFor(async () => expect(await installedCount()).toBe(1));
      stop();
      await settle();

      thisWindow.label = 'w-1';
      await otherWindowTakesTheMenu();
      takeAppMenu();
      vi.mocked(Menu.new).mockClear();
      stop = syncAppMenu(handlers(), vi.fn());
      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalled());
      await settle();
      expect(await installedCount()).toBe(0);
      stop();
    });

    it('does not rebuild on focus while its own menu is still the one shown', async () => {
      const stop = syncAppMenu(handlers(), vi.fn());
      await vi.waitFor(() => expect(Menu.new).toHaveBeenCalledOnce());
      await settle();

      takeAppMenu();
      await settle();

      expect(Menu.new).toHaveBeenCalledOnce();
      stop();
    });
  });

  it('reports a settings listener that could not be registered', async () => {
    events.failNextListen = new Error('event plugin down');
    const onError = vi.fn();
    const stop = syncAppMenu(handlers(), onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(new Error('event plugin down')));
    stop();
  });
});
