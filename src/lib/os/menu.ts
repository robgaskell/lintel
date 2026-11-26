import {
  Menu,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
  type SubmenuOptions,
} from '@tauri-apps/api/menu';
import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import type { ViewMode } from '../docs/store.svelte';
import { openFindReplace } from '../editor/commands';
import { activeView } from '../editor/views';
import { onSettingsChanged, settings } from '../settings/settings.svelte';
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
  openSettings(): void;
}

type MenuEntry = MenuItemOptions | PredefinedMenuItemOptions | SubmenuOptions;

let installing: Promise<void> = Promise.resolve();
let generation = 0;

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
  const entries = menuEntries(h, recent, currentPlatform());
  stampBuildIds(entries, ++generation);
  const menu = await Menu.new({ items: entries });
  const previous = await menu.setAsAppMenu();
  // Each menu holds native resources and action channels until closed (Ruling 37).
  await previous?.close();
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
    enabled: false,
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
      { id: 'undo', text: 'Undo', accelerator: 'CmdOrCtrl+Z', action: () => editHistory('undo') },
      {
        id: 'redo',
        text: 'Redo',
        accelerator: 'Shift+CmdOrCtrl+Z',
        action: () => editHistory('redo'),
      },
      separator,
      { item: 'Cut' },
      { item: 'Copy' },
      { item: 'Paste' },
      { item: 'SelectAll' },
      separator,
      { id: 'find', text: 'Find…', accelerator: 'CmdOrCtrl+F', action: () => onActive(openSearchPanel) },
      {
        id: 'find-replace',
        text: 'Find and Replace…',
        accelerator: 'CmdOrCtrl+Alt+F',
        action: () => onActive(openFindReplace),
      },
    ],
  };

  const mode = (id: ViewMode, text: string, key: string): MenuItemOptions => ({
    id: `mode-${id}`,
    text,
    accelerator: `CmdOrCtrl+${key}`,
    enabled: false,
    action: () => h.setMode(id),
  });
  const view: SubmenuOptions = {
    text: 'View',
    items: [
      mode('edit', 'Edit', '1'),
      mode('split', 'Split', '2'),
      mode('read', 'Read', '3'),
      separator,
      { id: 'toggle-outline', text: 'Show Outline', enabled: false, action: () => h.toggleOutline() },
    ],
  };

  // Tauri registers submenus with these ids as the macOS Window and Help menus.
  const window: SubmenuOptions = {
    id: '__tauri_window_menu__',
    text: 'Window',
    items: [
      { item: 'Minimize' },
      { item: 'Maximize' },
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
    // GTK supports neither predefined item, so Linux gets no Window menu.
    ...(platform === 'linux' ? [] : [window]),
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

function onActive(command: (view: EditorView) => boolean): void {
  const view = activeView();
  if (view) command(view);
}

function editHistory(kind: 'undo' | 'redo'): void {
  const focused = document.activeElement;
  // A text field outside the editor, such as the find field, keeps its own undo stack.
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    document.execCommand(kind);
    return;
  }
  onActive(kind === 'undo' ? undo : redo);
}
