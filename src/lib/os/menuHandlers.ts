import { message, open } from '@tauri-apps/plugin-dialog';
import { docs, saveDoc, saveDocAs, type ViewMode } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import type { MenuHandlers } from './menu';
import { newUntitled, openPaths } from './open';
import { isMac } from './platform';
import { quitApp } from './quit';
import { clearRecent, recentMayHaveChanged } from './recent';
import { closeTabOrWindow } from './window';

export interface MenuHandlerDeps {
  workspace: Pick<
    Workspace,
    'activeDocId' | 'closeDoc' | 'refreshTab' | 'docIdsInOrder' | 'activate'
  >;
  currentWindow(): { destroy(): Promise<void> };
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

  return {
    quit: guarded(() => quitApp(workspace)),
    newDoc: guarded(newUntitled),
    open: guarded(chooseFiles),
    openRecent: (path) => guarded(() => openRecent(path))(),
    clearRecent: guarded(clearRecent),
    save: guarded(() => saveActive(false)),
    saveAs: guarded(() => saveActive(true)),
    closeTab: guarded(() => closeTabOrWindow(workspace, currentWindow())),
    setMode: (mode) => guarded(() => setMode(mode))(),
    toggleOutline: guarded(() => {
      outline.visible = !outline.visible;
      // The native item flips its own tick on click; setting it keeps the two in step.
      return setOutlineChecked(outline.visible);
    }),
    print: notYet,
    exportPdf: notYet,
    exportHtml: notYet,
    exportDocx: notYet,
    openSettings: notYet,
  };
}

// The step that enables an item replaces this; until then a stray click says so.
const notYet = guarded(() => {
  throw new Error('Not implemented yet');
});

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
