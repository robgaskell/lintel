import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { message } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { docs, type DocState } from '../docs/store.svelte';
import { currentPlatform, type Platform } from '../os/platform';
import { openDocInNewWindow, TOO_LARGE_TO_MOVE, tooLargeToMove } from '../os/windows';
import type { Workspace } from './workspace';

export interface TabMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  /** Why the item is off. Native menus cannot show it yet (Tauri 2.12 has no item tooltips). */
  tooltip?: string;
}

type TabActions = Pick<
  Workspace,
  'closeDoc' | 'closeOthers' | 'closeAll' | 'setPinned' | 'split' | 'isAloneInGroup'
>;

const REVEAL_LABEL: Record<Platform, string> = {
  macos: 'Reveal in Finder',
  windows: 'Show in Explorer',
  linux: 'Show in Folder',
};

/** The tab menu's items for `doc`, in order. Separators exist only in the native menu. */
export function tabMenuItems(doc: DocState, platform: Platform, aloneInGroup: boolean): TabMenuItem[] {
  const onDisk = doc.path !== null;
  const tooLarge = tooLargeToMove(doc);
  return [
    { id: 'tab-close', label: 'Close', enabled: true },
    { id: 'tab-close-others', label: 'Close Others', enabled: true },
    { id: 'tab-close-all', label: 'Close All', enabled: true },
    { id: 'tab-copy-contents', label: 'Copy Contents', enabled: true },
    { id: 'tab-copy-path', label: 'Copy Path', enabled: onDisk },
    // Off for a lone tab, as a doc is never shown in two places (spec: Split on a lone tab).
    { id: 'tab-split-right', label: 'Split Right', enabled: !aloneInGroup },
    { id: 'tab-split-down', label: 'Split Down', enabled: !aloneInGroup },
    {
      id: 'tab-new-window',
      label: 'Open in New Window',
      enabled: !tooLarge,
      ...(tooLarge ? { tooltip: TOO_LARGE_TO_MOVE } : {}),
    },
    { id: 'tab-pin', label: doc.pinned ? 'Unpin Tab' : 'Pin Tab', enabled: true },
    { id: 'tab-reveal', label: REVEAL_LABEL[platform], enabled: onDisk },
  ];
}

const ACTIONS: Record<string, (tabs: TabActions, doc: DocState) => unknown> = {
  'tab-close': (tabs, doc) => tabs.closeDoc(doc.id),
  'tab-close-others': (tabs, doc) => tabs.closeOthers(doc.id),
  'tab-close-all': (tabs, doc) => tabs.closeAll(doc.id),
  // The live buffer, so unsaved edits are copied too.
  'tab-copy-contents': (_, doc) => writeText(doc.text),
  'tab-copy-path': (_, doc) => doc.path !== null && writeText(doc.path),
  'tab-split-right': (tabs, doc) => tabs.split(doc.id, 'right'),
  'tab-split-down': (tabs, doc) => tabs.split(doc.id, 'below'),
  'tab-new-window': (_, doc) => openDocInNewWindow(doc.id),
  'tab-pin': (tabs, doc) => tabs.setPinned(doc.id, !doc.pinned),
  'tab-reveal': (_, doc) => doc.path !== null && revealItemInDir(doc.path),
};

// As in the TabMenu artboard.
const SEPARATOR_AFTER = new Set(['tab-close-all', 'tab-copy-path', 'tab-new-window']);
// Hints only for shortcuts that are really bound (Ruling 164).
const ACCELERATOR: Record<string, string> = {
  'tab-close': 'CmdOrCtrl+W',
  'tab-split-right': 'CmdOrCtrl+\\',
};

interface SharedMenu {
  menu: Menu;
  items: Map<string, MenuItem>;
}

// One menu for every tab of this window. Tauri keys clicks by id across the app, so ids are
// stable within a window and carry its label (Rulings 56, 57, 164, 188).
let shared: Promise<SharedMenu> | null = null;
let tabs: TabActions | null = null;
let targetId: string | null = null;
// True from a right-click until its menu closes; a second right-click meanwhile would
// relabel the first menu and retarget its actions (Ruling 175).
let showing = false;

/** Replaces the webview's right-click menu on the tabs inside `el` with the tab menu. */
export function attachTabMenu(el: HTMLElement, workspace: TabActions): () => void {
  tabs = workspace;
  const onContextMenu = (event: MouseEvent) => {
    const id = tabDocId(event.target);
    if (!id) return;
    event.preventDefault();
    showTabMenu(id, event.clientX, event.clientY).catch((err) =>
      message(`The tab menu could not open: ${err}`, { title: 'Lintel', kind: 'error' }),
    );
  };
  el.addEventListener('contextmenu', onContextMenu);
  return () => {
    el.removeEventListener('contextmenu', onContextMenu);
    if (tabs === workspace) tabs = null;
  };
}

/**
 * Shows the tab menu for `docId` at a point in the window's CSS pixels. Resolves once the
 * menu has closed; does nothing while another tab menu is opening or open.
 */
export async function showTabMenu(docId: string, x: number, y: number): Promise<void> {
  const doc = docs.get(docId);
  if (!doc || showing) return;
  showing = true;
  try {
    targetId = docId;
    const wanted = tabMenuItems(doc, currentPlatform(), tabs?.isAloneInGroup(docId) ?? true);
    const { menu, items } = await sharedMenu(wanted);
    await Promise.all(
      wanted.map(async ({ id, label, enabled }) => {
        const item = items.get(id);
        await item?.setText(label);
        await item?.setEnabled(enabled);
      }),
    );
    // Tauri answers popup only after the menu closes (macOS and Windows run it modally).
    await menu.popup(new LogicalPosition(x, y));
  } finally {
    showing = false;
  }
}

/** The doc id of the tab that `target` is in, if any. */
export function tabDocId(target: EventTarget | null): string | undefined {
  const tab = target instanceof Element ? target.closest('.dv-tab') : null;
  return tab?.querySelector<HTMLElement>('.lintel-tab')?.dataset.docId;
}

function sharedMenu(first: TabMenuItem[]): Promise<SharedMenu> {
  shared ??= buildMenu(first).catch((err) => {
    shared = null; // let the next right-click try again
    throw err;
  });
  return shared;
}

async function buildMenu(first: TabMenuItem[]): Promise<SharedMenu> {
  const items = new Map<string, MenuItem>();
  const entries: (MenuItem | PredefinedMenuItem)[] = [];
  const window = getCurrentWindow().label;
  for (const { id, label, enabled } of first) {
    const item = await MenuItem.new({
      id: `${id}@${window}`,
      text: label,
      enabled,
      accelerator: ACCELERATOR[id],
      action: () => runAction(id),
    });
    items.set(id, item);
    entries.push(item);
    if (SEPARATOR_AFTER.has(id)) entries.push(await PredefinedMenuItem.new({ item: 'Separator' }));
  }
  return { menu: await Menu.new({ items: entries }), items };
}

function runAction(id: string): void {
  const doc = targetId === null ? undefined : docs.get(targetId);
  const action = ACTIONS[id];
  if (!doc || !tabs || !action) return;
  const target = tabs;
  Promise.resolve()
    .then(() => action(target, doc))
    .catch((err) => message(String(err), { title: 'Lintel', kind: 'error' }));
}
