import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { MenuItem } from '@tauri-apps/api/menu';
import { message } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { releasePath } from '../ipc';
import { createDoc, docs, removeDoc, trackHandoff, untitledCounter, type DocState } from '../docs/store.svelte';
import { openDocInNewWindow } from '../os/windows';
import { showTabMenu, tabMenuItems } from './tabMenu';
import { Workspace } from './workspace';

type FakeItem = {
  id?: string;
  item?: string;
  text: string;
  enabled: boolean;
  accelerator?: string;
  action?: (id: string) => void;
};

// One app-wide id -> item map, as Tauri keeps it.
const native = vi.hoisted(() => ({
  items: new Map<string, FakeItem>(),
  menus: [] as { items: FakeItem[]; popup: ReturnType<typeof vi.fn> }[],
}));

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: vi.fn(async ({ items }: { items: FakeItem[] }) => {
      const menu = { items, popup: vi.fn(async () => {}) };
      native.menus.push(menu);
      return menu;
    }),
  },
  MenuItem: {
    new: vi.fn(async (opts: FakeItem) => {
      const item: FakeItem & Record<string, unknown> = {
        ...opts,
        enabled: opts.enabled ?? true,
        setText: vi.fn(async (text: string) => void (item.text = text)),
        setEnabled: vi.fn(async (enabled: boolean) => void (item.enabled = enabled)),
      };
      native.items.set(opts.id!, item);
      return item;
    }),
  },
  PredefinedMenuItem: {
    new: vi.fn(async (opts: { item: string }) => ({ item: opts.item, text: '', enabled: true })),
  },
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn(async () => {}) }));
vi.mock('../ipc', () => ({
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  frontendReady: vi.fn(async () => []),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => 1),
  completeHandoff: vi.fn(async () => true),
  cancelHandoff: vi.fn(async () => true),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', setTheme: async () => {} }),
}));
vi.mock('../os/windows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../os/windows')>()),
  openDocInNewWindow: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('../os/platform', () => ({ currentPlatform: () => 'macos', isMac: () => true }));

const messageDialog = vi.mocked(message);
let host: HTMLElement;
let ws: Workspace;

function fileDoc(name: string): DocState {
  return createDoc({ path: `/notes/${name}`, raw: `# ${name}\n`, hash: 'h', mode: 'split' });
}

function untitled(): DocState {
  return createDoc({ path: null, raw: '', hash: '', mode: 'split' });
}

function open(...list: DocState[]): void {
  for (const doc of list) ws.openDoc(doc);
  flushSync();
}

// Chooses an item in the menu that the last right-click showed.
function choose(id: string): void {
  const item = native.items.get(id);
  if (!item?.action) throw new Error(`no tab menu item ${id}`);
  item.action(id);
}

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  messageDialog.mockReset();
  vi.mocked(writeText).mockClear();
  vi.mocked(revealItemInDir).mockClear();
  vi.mocked(releasePath).mockClear();
  vi.mocked(openDocInNewWindow).mockClear();
  host = document.createElement('div');
  document.body.append(host);
  ws = new Workspace(host);
});

afterEach(() => {
  ws.dispose();
  host.remove();
});

describe('tabMenuItems', () => {
  it('lists the ten items in order, ending with Reveal in Finder on macOS', () => {
    expect(tabMenuItems(fileDoc('a.md'), 'macos', false).map((item) => item.label)).toEqual([
      'Close',
      'Close Others',
      'Close All',
      'Copy Contents',
      'Copy Path',
      'Split Right',
      'Split Down',
      'Open in New Window',
      'Pin Tab',
      'Reveal in Finder',
    ]);
  });

  it('names the reveal item for each platform', () => {
    const doc = fileDoc('a.md');
    expect(tabMenuItems(doc, 'windows', false).at(-1)?.label).toBe('Show in Explorer');
    expect(tabMenuItems(doc, 'linux', false).at(-1)?.label).toBe('Show in Folder');
  });

  it('reads Unpin Tab on a pinned tab', () => {
    const doc = fileDoc('a.md');
    doc.pinned = true;
    expect(tabMenuItems(doc, 'macos', false).map((item) => item.label)).toContain('Unpin Tab');
    expect(tabMenuItems(doc, 'macos', false).map((item) => item.label)).not.toContain('Pin Tab');
  });

  it('disables Copy Path and Reveal for an untitled doc', () => {
    const enabled = (doc: DocState) =>
      Object.fromEntries(tabMenuItems(doc, 'macos', false).map((item) => [item.label, item.enabled]));

    expect(enabled(untitled())).toMatchObject({ 'Copy Path': false, 'Reveal in Finder': false });
    expect(enabled(fileDoc('a.md'))).toMatchObject({ 'Copy Path': true, 'Reveal in Finder': true });
  });

  it('enables every item, Open in New Window included, on a file in a shared group (Ruling 189)', () => {
    const items = tabMenuItems(fileDoc('a.md'), 'macos', false);
    for (const item of items) expect(item.enabled).toBe(true);
  });

  it('enables Open in New Window for an untitled doc and a lone tab', () => {
    const item = tabMenuItems(untitled(), 'macos', true).find((i) => i.id === 'tab-new-window');
    expect(item?.enabled).toBe(true);
  });

  it('disables Open in New Window above 10,000,000 bytes, saying why in its label (Rulings 187, 196)', () => {
    const doc = untitled();
    const item = () => tabMenuItems(doc, 'macos', false).find((i) => i.id === 'tab-new-window');

    doc.text = 'x'.repeat(10_000_000);
    expect(item()).toMatchObject({ enabled: true, label: 'Open in New Window' });

    // Two bytes each in UTF-8, so 5,000,001 of them are just over the limit.
    doc.text = 'é'.repeat(5_000_001);
    expect(item()).toMatchObject({ enabled: false, label: 'Open in New Window (too large)' });
  });

  it('disables Split Right and Split Down on a tab alone in its group', () => {
    const enabled = Object.fromEntries(
      tabMenuItems(fileDoc('a.md'), 'macos', true).map((item) => [item.label, item.enabled]),
    );
    expect(enabled).toMatchObject({ 'Split Right': false, 'Split Down': false, Close: true });
  });
});

describe('closing a tab while a doc moves to another window (Ruling 217)', () => {
  function pendingHandoff(): () => void {
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    return settle;
  }

  it('waits, and asks nothing about the tab once it has moved away', async () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    open(a, b);
    a.text = 'unsaved';
    const settle = pendingHandoff();

    const closing = ws.closeDoc(a.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messageDialog).not.toHaveBeenCalled();
    // As the hand-over takes it out.
    removeDoc(a.id, { keepClaim: true });
    void ws.closeDoc(a.id);
    expect(ws.docIdsInOrder()).toEqual([b.id]);
    settle();

    expect(await closing).toBe(true);
    expect(messageDialog).not.toHaveBeenCalled();
  });

  it('Close All waits too, and asks nothing about a tab that moved away', async () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    open(a, b);
    a.text = 'unsaved';
    const settle = pendingHandoff();

    const closing = ws.closeAll(a.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    removeDoc(a.id, { keepClaim: true });
    void ws.closeDoc(a.id);
    settle();
    await closing;

    expect(messageDialog).not.toHaveBeenCalled();
    expect(ws.docIdsInOrder()).toEqual([]);
  });

  it('asks once about a tab that stayed, once the hand-over has settled', async () => {
    const a = fileDoc('a.md');
    open(a);
    a.text = 'unsaved';
    const settle = pendingHandoff();
    messageDialog.mockResolvedValue("Don't Save");

    const closing = ws.closeDoc(a.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messageDialog).not.toHaveBeenCalled();
    settle();

    expect(await closing).toBe(true);
    expect(messageDialog).toHaveBeenCalledOnce();
  });
});

describe('Close Others and Close All', () => {
  it('closeOthers leaves the target and pinned tabs open', async () => {
    const p = fileDoc('p.md');
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    const c = fileDoc('c.md');
    open(p, a, b, c);
    ws.setPinned(p.id, true);

    await ws.closeOthers(b.id);

    expect(ws.docIdsInOrder()).toEqual([p.id, b.id]);
    expect([...docs.keys()].sort()).toEqual([p.id, b.id].sort());
  });

  it("closeAll closes every unpinned tab once a dirty one gets Don't Save", async () => {
    const p = fileDoc('p.md');
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    open(p, a, b);
    ws.setPinned(p.id, true);
    b.text = 'unsaved';
    messageDialog.mockResolvedValue("Don't Save");

    await ws.closeAll();

    expect(ws.docIdsInOrder()).toEqual([p.id]);
    expect([...docs.keys()]).toEqual([p.id]);
    expect(messageDialog).toHaveBeenCalledTimes(1);
  });

  it('closeAll closes nothing when the prompt for a dirty tab is cancelled (Ruling 166)', async () => {
    const p = fileDoc('p.md');
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    open(p, a, b);
    ws.setPinned(p.id, true);
    b.text = 'unsaved';
    messageDialog.mockResolvedValue('Cancel');

    await ws.closeAll();

    expect(ws.docIdsInOrder()).toEqual([p.id, a.id, b.id]);
    expect(docs.size).toBe(3);
  });

  it("closes nothing after Don't Save on one tab and Cancel on the next", async () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    open(a, b, c);
    b.text = 'unsaved b';
    c.text = 'unsaved c';
    messageDialog.mockResolvedValueOnce("Don't Save").mockResolvedValueOnce('Cancel');

    await ws.closeAll();

    expect(messageDialog).toHaveBeenCalledTimes(2);
    expect(ws.docIdsInOrder()).toEqual([a.id, b.id, c.id]);
    expect(docs.size).toBe(3);
  });

  it("acts on the target tab's group only (Ruling 172)", async () => {
    const [a1, a2, a3, b1, b2] = ['a1.md', 'a2.md', 'a3.md', 'b1.md', 'b2.md'].map(fileDoc);
    open(a1, a2, a3);
    ws.openDoc(b1, { referenceId: a1.id, direction: 'right' });
    ws.openDoc(b2, { referenceId: b1.id });

    await ws.closeOthers(a2.id);
    expect(ws.docIdsInOrder()).toEqual([a2.id, b1.id, b2.id]);

    await ws.closeAll(b2.id);
    expect(ws.docIdsInOrder()).toEqual([a2.id]);
    expect([...docs.keys()]).toEqual([a2.id]);
  });

  it('closeAll with no target acts on the active group', async () => {
    const [a1, a2, b1] = ['a1.md', 'a2.md', 'b1.md'].map(fileDoc);
    open(a1, a2);
    ws.openDoc(b1, { referenceId: a1.id, direction: 'right' });
    ws.activate(a2.id);

    await ws.closeAll();

    expect(ws.docIdsInOrder()).toEqual([b1.id]);
  });

  it('releases the path of every tab Close Others and Close All close (Ruling 185)', async () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    open(a, b, c);

    await ws.closeOthers(a.id);
    expect(vi.mocked(releasePath).mock.calls.map(([path]) => path).sort()).toEqual(['/notes/b.md', '/notes/c.md']);

    await ws.closeAll();
    expect(releasePath).toHaveBeenLastCalledWith('/notes/a.md');
  });

  it('closeOthers asks about a dirty tab before closing any', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    const c = fileDoc('c.md');
    open(a, b, c);
    c.text = 'unsaved';
    messageDialog.mockResolvedValue('Cancel');

    await ws.closeOthers(a.id);

    expect(ws.docIdsInOrder()).toEqual([a.id, b.id, c.id]);
  });
});

describe('showTabMenu', () => {
  it('builds one shared menu with separators and only the bound shortcut hints (Rulings 164, 179)', async () => {
    const a = fileDoc('a.md');
    const b = untitled();
    open(a, b);

    await showTabMenu(a.id, 10, 20);
    await showTabMenu(b.id, 30, 40);

    expect(native.menus).toHaveLength(1);
    const menu = native.menus[0];
    expect(menu.items.map((item) => item.item ?? item.text)).toEqual([
      'Close',
      'Close Others',
      'Close All',
      'Separator',
      'Copy Contents',
      'Copy Path',
      'Separator',
      'Split Right',
      'Split Down',
      'Open in New Window',
      'Separator',
      'Pin Tab',
      'Reveal in Finder',
    ]);
    const hints = menu.items.filter((item) => item.accelerator).map((item) => item.text);
    expect(hints).toEqual(['Close', 'Split Right']);
    expect(menu.items.find((item) => item.text === 'Close')?.accelerator).toBe('CmdOrCtrl+W');
    expect(menu.items.find((item) => item.text === 'Split Right')?.accelerator).toBe('CmdOrCtrl+\\');
    expect(menu.popup).toHaveBeenLastCalledWith(expect.objectContaining({ x: 30, y: 40 }));
  });

  it('updates labels and enabled flags for the doc right-clicked', async () => {
    const a = fileDoc('a.md');
    const b = untitled();
    open(a, b);
    ws.setPinned(a.id, true);

    await showTabMenu(a.id, 0, 0);
    const pin = [...native.items.values()].find((item) => /pin tab/i.test(item.text))!;
    const copyPath = [...native.items.values()].find((item) => item.text === 'Copy Path')!;
    expect(pin.text).toBe('Unpin Tab');
    expect(copyPath.enabled).toBe(true);

    const built = vi.mocked(MenuItem.new).mock.calls.length;
    await showTabMenu(b.id, 0, 0);
    expect(pin.text).toBe('Pin Tab');
    expect(copyPath.enabled).toBe(false);
    expect(vi.mocked(MenuItem.new).mock.calls.length).toBe(built);
    expect(native.menus).toHaveLength(1);
  });

  it('copies the buffer, unsaved edits included, from Copy Contents', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    open(a, b);
    a.text = '# a.md\nnot saved yet\n';

    await showTabMenu(a.id, 0, 0);
    choose(idOf('Copy Contents'));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('# a.md\nnot saved yet\n'));
  });

  it('copies the absolute path and reveals the file of the doc right-clicked', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    open(a, b);

    await showTabMenu(a.id, 0, 0);
    choose(idOf('Copy Path'));
    choose(idOf('Reveal in Finder'));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('/notes/a.md');
      expect(revealItemInDir).toHaveBeenCalledWith('/notes/a.md');
    });
  });

  it('pins the doc right-clicked, moving it left', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    open(a, b);

    await showTabMenu(b.id, 0, 0);
    choose(idOf('Pin Tab'));

    await vi.waitFor(() => expect(b.pinned).toBe(true));
    expect(ws.docIdsInOrder()).toEqual([b.id, a.id]);
  });

  it('closes the doc right-clicked, not the active one', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    open(a, b);

    await showTabMenu(a.id, 0, 0);
    choose(idOf('Close'));

    await vi.waitFor(() => expect(ws.docIdsInOrder()).toEqual([b.id]));
  });

  it("closes the right-clicked tab's group only from Close All", async () => {
    const [a1, b1, b2] = ['a1.md', 'b1.md', 'b2.md'].map(fileDoc);
    open(a1);
    ws.openDoc(b1, { referenceId: a1.id, direction: 'right' });
    ws.openDoc(b2, { referenceId: b1.id });
    ws.activate(a1.id);

    await showTabMenu(b1.id, 0, 0);
    choose(idOf('Close All'));

    await vi.waitFor(() => expect(ws.docIdsInOrder()).toEqual([a1.id]));
  });

  it('splits the doc right-clicked into a new group on the right or below (Ruling 178)', async () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    open(a, b, c);

    await showTabMenu(a.id, 0, 0);
    choose(idOf('Split Right'));
    await vi.waitFor(() => expect(ws.groupCount()).toBe(2));
    expect(ws.isAloneInGroup(a.id)).toBe(true);
    expect(ws.docIdsInOrder()).toEqual([b.id, c.id, a.id]);

    await showTabMenu(b.id, 0, 0);
    choose(idOf('Split Down'));
    await vi.waitFor(() => expect(ws.groupCount()).toBe(3));
    expect(ws.isAloneInGroup(b.id)).toBe(true);
  });

  it("gives each item an id of this window's own (Ruling 188)", async () => {
    const a = fileDoc('a.md');
    open(a);

    await showTabMenu(a.id, 0, 0);

    expect(idOf('Close')).toBe('tab-close@main');
    expect([...native.items.keys()].every((id) => id.endsWith('@main'))).toBe(true);
  });

  it('moves the doc right-clicked to a new window', async () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    open(a, b);

    await showTabMenu(a.id, 0, 0);
    choose(idOf('Open in New Window'));

    await vi.waitFor(() => expect(openDocInNewWindow).toHaveBeenCalledWith(a.id));
  });

  it('greys out the splits for a tab alone in its group', async () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    open(a);

    await showTabMenu(a.id, 0, 0);
    expect(native.items.get(idOf('Split Right'))?.enabled).toBe(false);
    expect(native.items.get(idOf('Split Down'))?.enabled).toBe(false);

    open(b);
    await showTabMenu(a.id, 0, 0);
    expect(native.items.get(idOf('Split Right'))?.enabled).toBe(true);
    expect(native.items.get(idOf('Split Down'))?.enabled).toBe(true);
  });

  it('greys out the splits when no workspace is attached to ask', async () => {
    const a = fileDoc('a.md');
    open(a, fileDoc('b.md'));
    const otherHost = document.createElement('div');
    new Workspace(otherHost).dispose(); // the last one attached, now gone

    await showTabMenu(a.id, 0, 0);

    expect(native.items.get(idOf('Split Right'))?.enabled).toBe(false);
    expect(native.items.get(idOf('Split Down'))?.enabled).toBe(false);
  });

  it('ignores a second right-click until the first menu has closed (Ruling 175)', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    open(a, b);
    ws.setPinned(a.id, true);
    await showTabMenu(b.id, 0, 0);
    const popup = native.menus[0].popup;
    popup.mockClear();
    let closeMenu: () => void = () => {};
    popup.mockImplementationOnce(() => new Promise<void>((resolve) => (closeMenu = resolve)));

    const first = showTabMenu(a.id, 0, 0);
    await vi.waitFor(() => expect(popup).toHaveBeenCalledOnce());
    await showTabMenu(b.id, 0, 0);
    expect(popup).toHaveBeenCalledOnce();
    expect(native.items.get(idOf('Unpin Tab'))).toBeDefined();
    choose(idOf('Close'));
    closeMenu();
    await first;

    await vi.waitFor(() => expect(ws.docIdsInOrder()).toEqual([b.id]));
    await showTabMenu(b.id, 0, 0);
    expect(popup).toHaveBeenCalledTimes(2);
  });

  it('shows an error when the menu cannot open (Ruling 175)', async () => {
    const a = fileDoc('a.md');
    open(a);
    await showTabMenu(a.id, 0, 0);
    native.menus[0].popup.mockRejectedValueOnce(new Error('popup refused'));

    host
      .querySelector(`.lintel-tab[data-doc-id="${a.id}"]`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(String(messageDialog.mock.calls[0]?.[0])).toContain('popup refused'));
    await showTabMenu(a.id, 0, 0);
    expect(native.menus[0].popup).toHaveBeenCalled();
  });

  it('shows an error from an action in a dialog', async () => {
    const a = fileDoc('a.md');
    open(a);
    vi.mocked(writeText).mockRejectedValueOnce(new Error('clipboard busy'));

    await showTabMenu(a.id, 0, 0);
    choose(idOf('Copy Contents'));

    await vi.waitFor(() => expect(String(messageDialog.mock.calls[0]?.[0])).toContain('clipboard busy'));
  });
});

describe('right-clicking a tab', () => {
  it('opens the tab menu for that tab instead of the webview menu', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    open(a, b);
    const name = host.querySelector(`.lintel-tab[data-doc-id="${a.id}"] .name`)!;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 });

    name.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(native.menus[0]?.popup).toHaveBeenCalled());
    choose(idOf('Close'));
    await vi.waitFor(() => expect(ws.docIdsInOrder()).toEqual([b.id]));
  });
});

function idOf(label: string): string {
  const found = [...native.items.values()].find((item) => item.text === label);
  if (!found?.id) throw new Error(`no item labelled ${label}`);
  return found.id;
}
