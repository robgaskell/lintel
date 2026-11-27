import { getCurrentWindow } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';
import { confirmCloseAll, handoffsSettled } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import { forgetWindowSession, saveWindowSession } from './session';
import { docWindowLabels } from './windows';

/**
 * The window's close-requested handler. Prompts once per dirty doc, each shown first;
 * Cancel or an error keeps the window open. Tauri destroys it unless preventDefault is called.
 */
export async function handleCloseRequested(
  event: { preventDefault(): void },
  workspace: Pick<Workspace, 'docIdsInOrder' | 'activate'>,
  label: string = getCurrentWindow().label,
): Promise<void> {
  try {
    // A doc on its way to another window may come back, and must then be asked about.
    await handoffsSettled();
    const ids = workspace.docIdsInOrder();
    if (!(await confirmCloseAll(ids, (id) => workspace.activate(id)))) {
      event.preventDefault();
      return;
    }
  } catch (err) {
    event.preventDefault();
    await message(String(err), { title: 'Lintel', kind: 'error' });
    return;
  }
  await endWindowSession(label);
}

/** Cmd+W: closes the active tab, or the window when no tab is open (macOS convention). */
export async function closeTabOrWindow(
  workspace: Pick<Workspace, 'activeDocId' | 'closeDoc'>,
  win: { destroy(): Promise<void> },
  label: string = getCurrentWindow().label,
): Promise<void> {
  const id = workspace.activeDocId();
  if (id) {
    await workspace.closeDoc(id);
    return;
  }
  // destroy raises no close-requested event, so the session is settled here (Ruling 209).
  await endWindowSession(label);
  // destroy, not close: there is nothing to prompt for, and close needs another capability.
  await win.destroy();
}

/**
 * Spec, Session lifetime: a window closed while other document windows stay open drops
 * its session; the last one keeps it for the next launch. Never rejects: the close goes on.
 */
async function endWindowSession(label: string): Promise<void> {
  try {
    const others = (await docWindowLabels()).filter((other) => other !== label);
    if (others.length > 0) await forgetWindowSession(label);
    else await saveWindowSession(label);
  } catch (err) {
    console.error('Could not update the session:', err);
  }
}
