import { getVersion } from '@tauri-apps/api/app';
import {
  type AboutMetadata,
  CheckMenuItem,
  Menu,
  MenuItem,
  type CheckMenuItemOptions,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
  type SubmenuOptions,
} from '@tauri-apps/api/menu';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
  toggleToolbar(): void;
  print(): void;
  exportPdf(): void;
  exportHtml(): void;
  exportDocx(): void;
  openSettings(section?: SettingsSection): void;
  nextTab(): void;
  previousTab(): void;
  split(direction: 'right' | 'below'): void;
  openNotices(): void;
  openGithub(): void;
}

export const REPO_URL = 'https://github.com/robgaskell/lintel';

type MenuEntry =
  | MenuItemOptions
  | CheckMenuItemOptions
  | PredefinedMenuItemOptions
  | SubmenuOptions
  | CheckMenuItem
  | MenuItem;

let installing: Promise<void> = Promise.resolve();
let generation = 0;
// View > Show Outline in the current menu bar, kept so its tick can change without a rebuild.
let outlineItem: CheckMenuItem | null = null;

/** Ticks or clears View > Show Outline (Ruling 110). */
export async function setOutlineChecked(checked: boolean): Promise<void> {
  await outlineItem?.setChecked(checked);
}

// Like the outline item, but it follows `settings.showToolbar`, which every window shares.
let toolbarItem: CheckMenuItem | null = null;

export async function setToolbarChecked(checked: boolean): Promise<void> {
  await toolbarItem?.setChecked(checked);
}

const SPLIT_IDS = ['split-right', 'split-down'];
// Like the outline item: View > Split Right and Split Down, greyed out without a rebuild.
let splitItems: MenuItem[] = [];
let splitEnabled = true;

/** Enables View > Split Right and Split Down, or greys them out for a lone tab (Ruling 192). */
export async function setSplitEnabled(enabled: boolean): Promise<void> {
  splitEnabled = enabled;
  await Promise.all(splitItems.map((item) => item.setEnabled(enabled)));
}

// One rebuild per burst, such as opening several files at once.
const COALESCE_MS = 100;

/**
 * Sent with its label by the window that has just installed the app menu. The menu bar is
 * shared, so the last document window focused owns it, and only that one rebuilds it (Ruling 188).
 */
const MENU_OWNER = 'lintel://menu-owner';
/** Sent by Rust to the document window that takes the menu once its owner closes (Ruling 198). */
const MENU_CLAIM = 'lintel://menu-claim';
let holdsMenu = true;
let rebuildOwned: (() => void) | null = null;

/** Makes this window's menu the app menu, if another window's is shown. Call on focus. */
export function takeAppMenu(): void {
  if (holdsMenu) return;
  holdsMenu = true;
  rebuildOwned?.();
}

/**
 * Builds the menu bar now, and again whenever the recent list or `recentLimit` changes.
 * Each build shows the stored list at once, then the checked list if it differs, so a slow
 * disk never holds up the menu (Ruling 71). Returns a function that stops the rebuilds.
 */
export function syncAppMenu(h: MenuHandlers, onError: (err: unknown) => void): () => void {
  let latest = 0;
  let limit = settings.recentLimit;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // `force` installs the menu even while this window is not focused.
  const rebuildNow = (force = false) => {
    if (!holdsMenu) return;
    const request = ++latest;
    void rebuild(h, () => request === latest && holdsMenu, force).catch(onError);
  };
  const rebuildSoon = () => {
    timer ??= setTimeout(() => {
      timer = null;
      rebuildNow();
    }, COALESCE_MS);
  };

  const stopRecent = onRecentChanged(rebuildSoon);
  const stopSettings = onSettingsChanged((next) => {
    setToolbarChecked(next.showToolbar).catch(onError);
    if (next.recentLimit === limit) return;
    limit = next.recentLimit;
    rebuildSoon();
  }, onError);
  const label = getCurrentWindow().label;
  const unlisteners: (() => void)[] = [];
  let stopped = false;
  const keep = (unlisten: () => void) => (stopped ? unlisten() : unlisteners.push(unlisten));
  listen<string>(MENU_OWNER, ({ payload }) => {
    if (payload !== label) holdsMenu = false;
  })
    .then(keep)
    .catch(onError);
  // Settings, or no window, may have focus now, so this one builds without waiting for it.
  const claimed = () => {
    holdsMenu = true;
    rebuildNow(true);
  };
  listen(MENU_CLAIM, claimed, { target: { kind: 'WebviewWindow', label } })
    .then(keep)
    .catch(onError);
  rebuildOwned = () => rebuildNow();
  // The main window is still hidden, so unfocused, when it builds its first menu at launch.
  rebuildNow(label === 'main');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stopRecent();
    stopSettings();
    for (const unlisten of unlisteners) unlisten();
    rebuildOwned = null;
  };
}

/** `isLatest` turns false once a newer rebuild starts; this one then stops. */
async function rebuild(h: MenuHandlers, isLatest: () => boolean, force: boolean): Promise<void> {
  const limit = settings.recentLimit;
  // Null hides Open Recent.
  if (limit <= 0) return buildAppMenu(h, null, { force });
  const known = await knownRecent(limit).catch((err) => {
    console.error('Could not read the Open Recent list:', err);
    return [];
  });
  if (!isLatest()) return;
  await buildAppMenu(h, known, { force });

  let checked: string[];
  try {
    checked = await getRecent(limit);
  } catch (err) {
    console.error('Could not check the Open Recent list:', err);
    return;
  }
  if (!isLatest() || sameList(known, checked)) return;
  await buildAppMenu(h, checked, { force });
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

/**
 * Builds the native menu bar and replaces the current one; call again to rebuild.
 * `recent` null leaves Open Recent out; an empty list shows it disabled. Unless `force`,
 * a window that is no longer focused gives up and leaves the shown menu (Ruling 198).
 */
export function buildAppMenu(
  h: MenuHandlers,
  recent: string[] | null,
  { force = false } = {},
): Promise<void> {
  // One at a time, so a slow build cannot overwrite a newer one.
  const run = installing.then(() => install(h, recent, force));
  installing = run.catch(() => {});
  return run;
}

async function install(h: MenuHandlers, recent: string[] | null, force: boolean): Promise<void> {
  const checked = outline.visible;
  const toolbarShown = settings.showToolbar;
  const splittable = splitEnabled;
  const label = getCurrentWindow().label;
  const entries = menuEntries(h, recent, currentPlatform(), await appVersion());
  stampBuildIds(entries, `${label}#${++generation}`);
  const check = await liveCheckItem(entries, 'toggle-outline');
  const toolbarCheck = await liveCheckItem(entries, 'show-toolbar');
  const splits: MenuItem[] = [];
  for (const base of SPLIT_IDS) {
    const item = await liveMenuItem(entries, base);
    if (item) splits.push(item);
  }
  const menu = await Menu.new({ items: entries });
  // Focus can move while the menu is built; the window that has it then builds its own.
  if (!force && !(await getCurrentWindow().isFocused())) {
    holdsMenu = false;
    await Promise.all([menu, check, toolbarCheck, ...splits].map((unused) => unused?.close()));
    return;
  }
  const previous = await menu.setAsAppMenu();
  holdsMenu = true;
  emit(MENU_OWNER, label).catch((err) => console.error('Could not announce the menu owner:', err));
  const previousCheck = outlineItem;
  const previousToolbarCheck = toolbarItem;
  const previousSplits = splitItems;
  outlineItem = check;
  toolbarItem = toolbarCheck;
  splitItems = splits;
  // Each menu holds native resources and action channels until closed (Ruling 37).
  await previous?.close();
  await previousCheck?.close();
  await previousToolbarCheck?.close();
  await Promise.all(previousSplits.map((item) => item.close()));
  // The outline, the toolbar setting or the active tab may have changed during the build.
  if (outline.visible !== checked) await check?.setChecked(outline.visible);
  if (settings.showToolbar !== toolbarShown) await toolbarCheck?.setChecked(settings.showToolbar);
  if (splitEnabled !== splittable) await setSplitEnabled(splitEnabled);
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

/** As liveCheckItem, for a plain item that only greys out. */
async function liveMenuItem(entries: MenuEntry[], base: string): Promise<MenuItem | null> {
  for (const entry of entries) {
    if (!('items' in entry) || !entry.items) continue;
    const items = entry.items as MenuEntry[];
    const i = items.findIndex(
      (item) => 'id' in item && !('items' in item) && baseId(item.id ?? '') === base,
    );
    if (i === -1) continue;
    const item = await MenuItem.new(items[i] as MenuItemOptions);
    items[i] = item;
    return item;
  }
  return null;
}

let version: Promise<string | undefined> | null = null;

// Without a version the menu still builds; About then shows none (or the plist's, on macOS).
function appVersion(): Promise<string | undefined> {
  version ??= getVersion().catch((err) => {
    console.error('Could not read the app version for About:', err);
    return undefined;
  });
  return version;
}

/**
 * The About panel's contents (Ruling 4). On macOS `shortVersion` is the bracketed build
 * part, so '' hides it; Windows and Linux append any `shortVersion` in brackets. Only
 * macOS reads `credits`, and only Windows and Linux read `website`.
 */
function aboutMetadata(mac: boolean, version: string | undefined): AboutMetadata {
  return mac
    ? { name: 'Lintel', version, shortVersion: '', credits: REPO_URL }
    : { name: 'Lintel', version, website: REPO_URL };
}

/**
 * The menu bar's contents.
 * There is no predefined Close Window: its Cmd+W would bypass Close Tab (Ruling 37).
 */
export function menuEntries(
  h: MenuHandlers,
  recent: string[] | null,
  platform: Platform,
  version?: string,
): MenuEntry[] {
  const mac = platform === 'macos';
  const about: PredefinedMenuItemOptions = { item: { About: aboutMetadata(mac, version) } };
  const separator: PredefinedMenuItemOptions = { item: 'Separator' };
  const settingsItem: MenuItemOptions = {
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
      about,
      separator,
      settingsItem,
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
        action: () => h.print(),
      },
      { id: 'export-pdf', text: 'Export as PDF…', action: () => h.exportPdf() },
      { id: 'export-html', text: 'Export as HTML…', action: () => h.exportHtml() },
      { id: 'export-docx', text: 'Export as Word…', action: () => h.exportDocx() },
      ...(mac ? [] : [separator, settingsItem, separator, quit]),
    ],
  };

  const edit: SubmenuOptions = {
    text: 'Edit',
    items: [
      // Custom, because the predefined pair drives WKWebView's undo stack, not the editor's (Ruling 39).
      { id: 'undo', text: 'Undo', accelerator: 'CmdOrCtrl+Z', action: () => void runHistory('undo') },
      {
        id: 'redo',
        text: 'Redo',
        accelerator: 'Shift+CmdOrCtrl+Z',
        action: () => void runHistory('redo'),
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
      {
        id: 'show-toolbar',
        text: 'Show Toolbar',
        checked: settings.showToolbar,
        action: () => h.toggleToolbar(),
      },
      separator,
      {
        id: 'split-right',
        text: 'Split Right',
        accelerator: 'CmdOrCtrl+\\',
        enabled: splitEnabled,
        action: () => h.split('right'),
      },
      { id: 'split-down', text: 'Split Down', enabled: splitEnabled, action: () => h.split('below') },
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
  const notices: MenuItemOptions = {
    id: 'third-party-notices',
    text: 'Third-Party Notices',
    action: () => h.openNotices(),
  };
  const github: MenuItemOptions = {
    id: 'lintel-github',
    text: 'Lintel on GitHub',
    action: () => h.openGithub(),
  };
  const help: SubmenuOptions = {
    id: '__tauri_help_menu__',
    text: 'Help',
    // macOS adds a search field to its Help menu; elsewhere About lives here.
    items: mac ? [github, notices] : [about, separator, github, notices],
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

/** The item id without the window and build suffix that `buildAppMenu` adds. */
function baseId(id: string): string {
  return id.split('#')[0];
}

/**
 * Tauri keys click handlers by item id across the whole app, and closing a menu removes
 * its ids. Ids unique to each window and build stop one menu from unhooking another.
 */
function stampBuildIds(entries: MenuEntry[], build: string): void {
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

/** Edit > Undo and Redo, which the window toolbar's buttons share. */
export async function runHistory(kind: 'undo' | 'redo'): Promise<void> {
  if (await focusedSettingsWindow()) return;
  const focused = document.activeElement;
  // A text field outside the editor, such as the find field, keeps its own undo stack.
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    document.execCommand(kind);
    return;
  }
  onActiveNow(kind === 'undo' ? undo : redo);
}
