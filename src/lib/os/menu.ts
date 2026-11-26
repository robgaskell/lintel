import {
  CheckMenuItem,
  Menu,
  type CheckMenuItemOptions,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
  type SubmenuOptions,
} from '@tauri-apps/api/menu';
import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import type { ViewMode } from '../docs/store.svelte';
import { openFindReplace } from '../editor/commands';
import { docs } from '../docs/store.svelte';
import { activeDocId, activeView } from '../editor/views';
import { outline } from '../layout/outline.svelte';
import { onSettingsChanged, settings } from '../settings/settings.svelte';
import { focusedSettingsWindow, type SettingsSection } from '../../settings/settingsWindow';
import { currentPlatform, type Platform } from './platform';
import { getRecent, knownRecent, onRecentChanged } from './recent';

export interface MenuHandlers {
  quit(): void;
  newDoc(): void;
  open(): void;
  openRecent(path: string): void;
  clearRecent(): void;
  save(): void;
  saveAs(): void;
  closeTab(): void;
  setMode(mode: ViewMode): void;
  toggleOutline(): void;
  print(): void;
  exportPdf(): void;
  exportHtml(): void;
  exportDocx(): void;
  openSettings(section?: SettingsSection): void;
  nextTab(): void;
  previousTab(): void;
}

type MenuEntry =
  | MenuItemOptions
  | CheckMenuItemOptions
  | PredefinedMenuItemOptions
  | SubmenuOptions
  | CheckMenuItem;

let installing: Promise<void> = Promise.resolve();
let generation = 0;
// View > Show Outline in the current menu bar, kept so its tick can change without a rebuild.
let outlineItem: CheckMenuItem | null = null;

/** Ticks or clears View > Show Outline (Ruling 110). */
export async function setOutlineChecked(checked: boolean): Promise<void> {
  await outlineItem?.setChecked(checked);
}

// One rebuild per burst, such as opening several files at once.
const COALESCE_MS = 100;

/**
 * Builds the menu bar now, and again whenever the recent list or `recentLimit` changes.
 * Each build shows the stored list at once, then the checked list if it differs, so a slow
 * disk never holds up the menu (Ruling 71). Returns a function that stops the rebuilds.
 */
export function syncAppMenu(h: MenuHandlers, onError: (err: unknown) => void): () => void {
  let latest = 0;
  let limit = settings.recentLimit;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const rebuildNow = () => {
    const request = ++latest;
    void rebuild(h, () => request === latest).catch(onError);
  };
  const rebuildSoon = () => {
    timer ??= setTimeout(() => {
      timer = null;
      rebuildNow();
    }, COALESCE_MS);
  };

  const stopRecent = onRecentChanged(rebuildSoon);
  const stopSettings = onSettingsChanged((next) => {
    if (next.recentLimit === limit) return;
    limit = next.recentLimit;
    rebuildSoon();
  }, onError);
  rebuildNow();
  return () => {
    if (timer) clearTimeout(timer);
    stopRecent();
    stopSettings();
  };
}

/** `isLatest` turns false once a newer rebuild starts; this one then stops. */
async function rebuild(h: MenuHandlers, isLatest: () => boolean): Promise<void> {
  const limit = settings.recentLimit;
  // Null hides Open Recent.
  if (limit <= 0) return buildAppMenu(h, null);
  const known = await knownRecent(limit).catch((err) => {
    console.error('Could not read the Open Recent list:', err);
    return [];
  });
  if (!isLatest()) return;
  await buildAppMenu(h, known);

  let checked: string[];
  try {
    checked = await getRecent(limit);
  } catch (err) {
    console.error('Could not check the Open Recent list:', err);
    return;
  }
  if (!isLatest() || sameList(known, checked)) return;
  await buildAppMenu(h, checked);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

/**
 * Builds the native menu bar and replaces the current one; call again to rebuild.
 * `recent` null leaves Open Recent out; an empty list shows it disabled.
 */
export function buildAppMenu(h: MenuHandlers, recent: string[] | null): Promise<void> {
  // One at a time, so a slow build cannot overwrite a newer one.
  const run = installing.then(() => install(h, recent));
  installing = run.catch(() => {});
  return run;
}

async function install(h: MenuHandlers, recent: string[] | null): Promise<void> {
  const checked = outline.visible;
  const entries = menuEntries(h, recent, currentPlatform());
  stampBuildIds(entries, ++generation);
  const check = await liveCheckItem(entries, 'toggle-outline');
  const menu = await Menu.new({ items: entries });
  const previous = await menu.setAsAppMenu();
  const previousCheck = outlineItem;
  outlineItem = check;
  // Each menu holds native resources and action channels until closed (Ruling 37).
  await previous?.close();
  await previousCheck?.close();
  // The outline may have been toggled while this menu was being built.
  if (outline.visible !== checked) await check?.setChecked(outline.visible);
}

/**
 * Replaces a submenu's check item options with a live item and returns it. Keeping the
 * item is the only way to tick it later: Menu.get finds top-level items only.
 */
async function liveCheckItem(entries: MenuEntry[], base: string): Promise<CheckMenuItem | null> {
  for (const entry of entries) {
    if (!('items' in entry) || !entry.items) continue;
    const items = entry.items as MenuEntry[];
    const i = items.findIndex((item) => 'checked' in item && baseId(item.id ?? '') === base);
    if (i === -1) continue;
    const item = await CheckMenuItem.new(items[i] as CheckMenuItemOptions);
    items[i] = item;
    return item;
  }
  return null;
}

/**
 * The menu bar's contents. Items for features that land in later steps are disabled.
 * There is no predefined Close Window: its Cmd+W would bypass Close Tab (Ruling 37).
 */
export function menuEntries(
  h: MenuHandlers,
  recent: string[] | null,
  platform: Platform,
): MenuEntry[] {
  const mac = platform === 'macos';
  const separator: PredefinedMenuItemOptions = { item: 'Separator' };
  const settings: MenuItemOptions = {
    id: 'settings',
    text: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    action: () => h.openSettings(),
  };
  // A custom item, not the predefined Quit, so unsaved docs are asked about (Ruling 32).
  const quit: MenuItemOptions = {
    id: 'quit',
    text: mac ? 'Quit Lintel' : 'Exit',
    accelerator: 'CmdOrCtrl+Q',
    action: () => h.quit(),
  };

  const app: SubmenuOptions = {
    text: 'Lintel',
    items: [
      { item: { About: null } },
      separator,
      settings,
      separator,
      { item: 'Services' },
      separator,
      { item: 'Hide' },
      { item: 'HideOthers' },
      { item: 'ShowAll' },
      separator,
      quit,
    ],
  };

  const file: SubmenuOptions = {
    text: 'File',
    items: [
      { id: 'new', text: 'New', accelerator: 'CmdOrCtrl+N', action: () => h.newDoc() },
      { id: 'open', text: 'Open…', accelerator: 'CmdOrCtrl+O', action: () => h.open() },
      ...(recent === null ? [] : [openRecentMenu(h, recent, separator)]),
      { id: 'save', text: 'Save', accelerator: 'CmdOrCtrl+S', action: () => h.save() },
      {
        id: 'save-as',
        text: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        action: () => h.saveAs(),
      },
      { id: 'close-tab', text: 'Close Tab', accelerator: 'CmdOrCtrl+W', action: () => h.closeTab() },
      separator,
      {
        id: 'print',
        text: 'Print…',
        accelerator: 'CmdOrCtrl+P',
        enabled: false,
        action: () => h.print(),
      },
      { id: 'export-pdf', text: 'Export as PDF…', enabled: false, action: () => h.exportPdf() },
      { id: 'export-html', text: 'Export as HTML…', enabled: false, action: () => h.exportHtml() },
      { id: 'export-docx', text: 'Export as Word…', enabled: false, action: () => h.exportDocx() },
      ...(mac ? [] : [separator, settings, separator, quit]),
    ],
  };

  const edit: SubmenuOptions = {
    text: 'Edit',
    items: [
      // Custom, because the predefined pair drives WKWebView's undo stack, not the editor's (Ruling 39).
      { id: 'undo', text: 'Undo', accelerator: 'CmdOrCtrl+Z', action: () => void editHistory('undo') },
      {
        id: 'redo',
        text: 'Redo',
        accelerator: 'Shift+CmdOrCtrl+Z',
        action: () => void editHistory('redo'),
      },
      separator,
      { item: 'Cut' },
      { item: 'Copy' },
      { item: 'Paste' },
      { item: 'SelectAll' },
      separator,
      { id: 'find', text: 'Find…', accelerator: 'CmdOrCtrl+F', action: () => void onActive(openSearchPanel) },
      {
        id: 'find-replace',
        text: 'Find and Replace…',
        accelerator: 'CmdOrCtrl+Alt+F',
        action: () => void onActive(openFindReplace),
      },
    ],
  };

  const mode = (id: ViewMode, text: string, key: string): MenuItemOptions => ({
    id: `mode-${id}`,
    text,
    accelerator: `CmdOrCtrl+${key}`,
    action: () => h.setMode(id),
  });
  const view: SubmenuOptions = {
    text: 'View',
    items: [
      mode('edit', 'Edit', '1'),
      mode('split', 'Split', '2'),
      mode('read', 'Read', '3'),
      separator,
      {
        id: 'toggle-outline',
        text: 'Show Outline',
        checked: outline.visible,
        action: () => h.toggleOutline(),
      },
    ],
  };

  // The second chord for each direction is a key handler: an item takes one accelerator (Ruling 167).
  const tabSwitching: MenuItemOptions[] = [
    {
      id: 'next-tab',
      text: 'Show Next Tab',
      accelerator: mac ? 'CmdOrCtrl+Shift+]' : 'Ctrl+Tab',
      action: () => h.nextTab(),
    },
    {
      id: 'previous-tab',
      text: 'Show Previous Tab',
      accelerator: mac ? 'CmdOrCtrl+Shift+[' : 'Ctrl+Shift+Tab',
      action: () => h.previousTab(),
    },
  ];
  // Tauri registers submenus with these ids as the macOS Window and Help menus.
  const window: SubmenuOptions = {
    id: '__tauri_window_menu__',
    text: 'Window',
    // GTK supports neither Minimize nor Maximize, so Linux gets the tab items only.
    items:
      platform === 'linux'
        ? tabSwitching
        : [
            { item: 'Minimize' },
            { item: 'Maximize' },
            separator,
            ...tabSwitching,
            ...(mac ? [separator, { item: 'BringAllToFront' } as const] : []),
          ],
  };
  const help: SubmenuOptions = {
    id: '__tauri_help_menu__',
    text: 'Help',
    // macOS fills its Help menu with a search field; elsewhere About lives here.
    items: mac ? [] : [{ item: { About: null } }],
  };

  return [
    ...(mac ? [app] : []),
    file,
    edit,
    view,
    window,
    help,
  ];
}

/** The item id without the per-build suffix that `buildAppMenu` adds. */
function baseId(id: string): string {
  return id.split('#')[0];
}

/**
 * Tauri keys click handlers by item id across the whole app, and closing a menu removes
 * its ids. Unique ids per build stop closing the old menu from unhooking the new one.
 */
function stampBuildIds(entries: MenuEntry[], build: number): void {
  for (const entry of entries) {
    if ('action' in entry && entry.id) entry.id = `${baseId(entry.id)}#${build}`;
    if ('items' in entry && entry.items) stampBuildIds(entry.items as MenuEntry[], build);
  }
}

function openRecentMenu(
  h: MenuHandlers,
  recent: string[],
  separator: PredefinedMenuItemOptions,
): SubmenuOptions {
  return {
    id: 'open-recent',
    text: 'Open Recent',
    enabled: recent.length > 0,
    items: [
      // Menus read a single & as a mnemonic marker and hide it.
      ...recent.map((path) => ({
        text: path.replaceAll('&', '&&'),
        action: () => h.openRecent(path),
      })),
      ...(recent.length > 0 ? [separator] : []),
      { id: 'clear-recent', text: 'Clear Menu', action: () => h.clearRecent() },
    ],
  };
}

async function onActive(command: (view: EditorView) => boolean): Promise<void> {
  // The menu bar is shared with Settings; its window has no editor to act on (Ruling 142).
  if (await focusedSettingsWindow()) return;
  onActiveNow(command);
}

function onActiveNow(command: (view: EditorView) => boolean): void {
  const id = activeDocId();
  // Read hides the editor, so an undo or a find panel there would be unseen (Ruling 97).
  if (id && docs.get(id)?.mode === 'read') return;
  const view = activeView();
  if (view) command(view);
}

async function editHistory(kind: 'undo' | 'redo'): Promise<void> {
  if (await focusedSettingsWindow()) return;
  const focused = document.activeElement;
  // A text field outside the editor, such as the find field, keeps its own undo stack.
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    document.execCommand(kind);
    return;
  }
  onActiveNow(kind === 'undo' ? undo : redo);
}
