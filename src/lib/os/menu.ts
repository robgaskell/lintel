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
import { isMac } from './platform';

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

/** Builds the native menu bar and replaces the current one; call again to rebuild. */
export function buildAppMenu(h: MenuHandlers, recent: string[]): Promise<void> {
  // One at a time, so a slow build cannot overwrite a newer one.
  const run = installing.then(() => install(h, recent));
  installing = run.catch(() => {});
  return run;
}

async function install(h: MenuHandlers, recent: string[]): Promise<void> {
  const menu = await Menu.new({ items: menuEntries(h, recent, isMac()) });
  const previous = await menu.setAsAppMenu();
  // Each menu holds native resources and action channels until closed (Ruling 37).
  await previous?.close();
}

/**
 * The menu bar's contents. Items for features that land in later steps are disabled.
 * There is no predefined Close Window: its Cmd+W would bypass Close Tab (Ruling 37).
 */
export function menuEntries(h: MenuHandlers, recent: string[], mac: boolean): MenuEntry[] {
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
      openRecentMenu(h, recent, separator),
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

  return [...(mac ? [app] : []), file, edit, view, window, help];
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
      ...recent.map((path) => ({ text: path, action: () => h.openRecent(path) })),
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
