import { message, open } from '@tauri-apps/plugin-dialog';
import { focusedSettingsWindow, openSettingsWindow } from '../../settings/settingsWindow';
import { docs, saveDoc, saveDocAs, type ViewMode } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import type { MenuHandlers } from './menu';
import { newUntitled, openPaths } from './open';
import { isMac, type Platform } from './platform';
import { quitApp } from './quit';
import { clearRecent, recentMayHaveChanged } from './recent';
import { closeTabOrWindow } from './window';

export interface MenuHandlerDeps {
  workspace: Pick<
    Workspace,
    'activeDocId' | 'closeDoc' | 'refreshTab' | 'docIdsInOrder' | 'activate' | 'nextTab' | 'previousTab'
  >;
  currentWindow(): {
    destroy(): Promise<void>;
    unminimize(): Promise<void>;
    show(): Promise<void>;
    setFocus(): Promise<void>;
  };
  outline: { visible: boolean };
  setOutlineChecked(checked: boolean): Promise<void>;
}

/** What each menu item does. Every handler shows its own errors in a dialog. */
export function makeMenuHandlers({
  workspace,
  currentWindow,
  outline,
  setOutlineChecked,
}: MenuHandlerDeps): MenuHandlers {
  async function saveActive(as: boolean) {
    const id = workspace.activeDocId();
    if (!id) return;
    const saved = as ? await saveDocAs(id) : await saveDoc(id);
    if (saved) workspace.refreshTab(id);
  }

  function setMode(mode: ViewMode) {
    const id = workspace.activeDocId();
    const doc = id ? docs.get(id) : undefined;
    if (doc) doc.mode = mode;
  }

  // The menu bar is shared with the Settings window (Ruling 142). Document commands do
  // nothing there, since they would act on a hidden tab.
  function forDoc(action: () => void | Promise<void>): () => void {
    return guarded(async () => {
      if (!(await focusedSettingsWindow())) await action();
    });
  }

  // Opening files from Settings acts in the main window, brought forward first. macOS
  // ignores focus for a minimised window, so it is unminimised and shown too (Ruling 156).
  function inMain(action: () => void | Promise<void>): () => void {
    return guarded(async () => {
      if (await focusedSettingsWindow()) {
        const main = currentWindow();
        await main.unminimize();
        await main.show();
        await main.setFocus();
      }
      await action();
    });
  }

  // The native item flips its own tick on click; setting it keeps the two in step.
  async function toggleOutline() {
    // From Settings the outline stays as it is, so the flipped tick is put back (Ruling 157).
    if (!(await focusedSettingsWindow())) outline.visible = !outline.visible;
    await setOutlineChecked(outline.visible);
  }

  async function closeTab() {
    const settingsWindow = await focusedSettingsWindow();
    if (settingsWindow) return settingsWindow.destroy();
    return closeTabOrWindow(workspace, currentWindow());
  }

  return {
    quit: guarded(() => quitApp(workspace)),
    newDoc: inMain(newUntitled),
    open: inMain(chooseFiles),
    openRecent: (path) => inMain(() => openRecent(path))(),
    clearRecent: guarded(clearRecent),
    save: forDoc(() => saveActive(false)),
    saveAs: forDoc(() => saveActive(true)),
    closeTab: guarded(closeTab),
    setMode: (mode) => forDoc(() => setMode(mode))(),
    toggleOutline: guarded(toggleOutline),
    print: forDoc(notYet),
    exportPdf: forDoc(notYet),
    exportHtml: forDoc(notYet),
    exportDocx: forDoc(notYet),
    openSettings: (section) => guarded(() => openSettingsWindow(section))(),
    nextTab: forDoc(() => workspace.nextTab()),
    previousTab: forDoc(() => workspace.previousTab()),
  };
}

/**
 * The second chord for switching tabs: Ctrl+Tab and Ctrl+Shift+Tab on macOS, Ctrl+PageDown
 * and Ctrl+PageUp elsewhere. The first is the Window menu's accelerator (Ruling 167).
 */
export function tabSwitchKey(e: KeyboardEvent, platform: Platform): 'next' | 'previous' | null {
  if (!e.ctrlKey || e.metaKey || e.altKey) return null;
  if (platform === 'macos') {
    if (e.key !== 'Tab') return null;
    return e.shiftKey ? 'previous' : 'next';
  }
  if (e.shiftKey) return null;
  if (e.key === 'PageDown') return 'next';
  if (e.key === 'PageUp') return 'previous';
  return null;
}

/** Listens on the whole window, in the capture phase, so the editor never sees the chord. */
export function listenTabSwitchKeys(
  h: Pick<MenuHandlers, 'nextTab' | 'previousTab'>,
  platform: Platform,
): () => void {
  const onKeydown = (e: KeyboardEvent) => {
    const direction = tabSwitchKey(e, platform);
    if (!direction) return;
    e.preventDefault();
    e.stopPropagation();
    if (direction === 'next') h.nextTab();
    else h.previousTab();
  };
  window.addEventListener('keydown', onKeydown, true);
  return () => window.removeEventListener('keydown', onKeydown, true);
}

// The step that enables an item replaces this; until then a stray click says so.
function notYet(): never {
  throw new Error('Not implemented yet');
}

// openPaths reports its own errors; reading the list again drops the entry if the file is gone.
async function openRecent(path: string) {
  try {
    await openPaths([path]);
  } finally {
    recentMayHaveChanged();
  }
}

async function chooseFiles() {
  const markdown = { name: 'Markdown', extensions: ['md', 'markdown'] };
  // macOS merges all filters into one list with no picker, so "All files" would undo the first (Ruling 38).
  const filters = isMac() ? [markdown] : [markdown, { name: 'All files', extensions: ['*'] }];
  const paths = await open({ multiple: true, directory: false, filters });
  if (paths) await openPaths(paths);
}

// Menu actions are fire-and-forget, so errors are shown here.
function guarded(action: () => void | Promise<void>): () => void {
  return () => {
    Promise.resolve()
      .then(action)
      .catch((err) => message(String(err), { title: 'Lintel', kind: 'error' }));
  };
}
