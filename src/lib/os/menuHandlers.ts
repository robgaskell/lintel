import { resolveResource } from '@tauri-apps/api/path';
import { message, open } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { focusedSettingsWindow, openSettingsWindow } from '../../settings/settingsWindow';
import { docs, saveDoc, saveDocAs, type ViewMode } from '../docs/store.svelte';
import { exportDocx } from '../export/docx';
import { exportHtml } from '../export/html';
import { printDoc } from '../export/print';
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
    | 'activeDocId'
    | 'closeDoc'
    | 'refreshTab'
    | 'docIdsInOrder'
    | 'activate'
    | 'nextTab'
    | 'previousTab'
    | 'split'
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

  function activeDoc() {
    const id = workspace.activeDocId();
    return id ? docs.get(id) : undefined;
  }

  function setMode(mode: ViewMode) {
    const doc = activeDoc();
    if (doc) doc.mode = mode;
  }

  async function printActive(pdfHint: boolean) {
    const doc = activeDoc();
    if (doc) await printDoc(doc, { pdfHint });
  }

  async function exportActiveAsHtml() {
    const doc = activeDoc();
    if (doc) await exportHtml(doc);
  }

  async function exportActiveAsDocx() {
    const doc = activeDoc();
    if (doc) await exportDocx(doc);
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
    print: forDoc(() => printActive(false)),
    exportPdf: forDoc(() => printActive(true)),
    exportHtml: forDoc(exportActiveAsHtml),
    exportDocx: forDoc(exportActiveAsDocx),
    openSettings: (section) => guarded(() => openSettingsWindow(section))(),
    nextTab: forDoc(() => workspace.nextTab()),
    previousTab: forDoc(() => workspace.previousTab()),
    openNotices: guarded(openNotices),
    split: (direction) =>
      forDoc(() => {
        const id = workspace.activeDocId();
        if (id) workspace.split(id, direction);
      })(),
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

/** The file bundled as a Tauri resource; the capability lets the opener open only this one. */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';

// Shown in the system's viewer for .md files, so Lintel needs no read-only tab (Ruling 328).
async function openNotices() {
  await openPath(await resolveResource(NOTICES_FILE));
}

// Menu actions are fire-and-forget, so errors are shown here.
function guarded(action: () => void | Promise<void>): () => void {
  return () => {
    Promise.resolve()
      .then(action)
      .catch((err) => message(String(err), { title: 'Lintel', kind: 'error' }));
  };
}
