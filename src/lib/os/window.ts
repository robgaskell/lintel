import { message } from '@tauri-apps/plugin-dialog';
import { confirmCloseAll, handoffsSettled } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';

/**
 * The window's close-requested handler. Prompts once per dirty doc, each shown first;
 * Cancel or an error keeps the window open. Tauri destroys it unless preventDefault is called.
 */
export async function handleCloseRequested(
  event: { preventDefault(): void },
  workspace: Pick<Workspace, 'docIdsInOrder' | 'activate'>,
): Promise<void> {
  try {
    // A doc on its way to another window may come back, and must then be asked about.
    await handoffsSettled();
    const ids = workspace.docIdsInOrder();
    if (await confirmCloseAll(ids, (id) => workspace.activate(id))) return;
    event.preventDefault();
  } catch (err) {
    event.preventDefault();
    await message(String(err), { title: 'Lintel', kind: 'error' });
  }
}

/** Cmd+W: closes the active tab, or the window when no tab is open (macOS convention). */
export async function closeTabOrWindow(
  workspace: Pick<Workspace, 'activeDocId' | 'closeDoc'>,
  win: { destroy(): Promise<void> },
): Promise<void> {
  const id = workspace.activeDocId();
  // destroy, not close: there is nothing to prompt for, and close needs another capability.
  if (id) await workspace.closeDoc(id);
  else await win.destroy();
}
