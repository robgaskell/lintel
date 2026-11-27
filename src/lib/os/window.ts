import { getCurrentWindow } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';
import { arrivalKey, confirmCloseAll, docs, handoffsSettled } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import { readyForOpenFilesAgain } from './open';
import { forgetWindowSessionLater, saveWindowSession } from './session';
import { docWindowLabels } from './windows';

/**
 * The window's close-requested handler. Prompts once per dirty doc, each shown first;
 * Cancel or an error keeps the window open, and it takes opened files again (Ruling 242).
 * Tauri destroys it unless preventDefault is called.
 */
export async function handleCloseRequested(
  event: { preventDefault(): void },
  workspace: Pick<Workspace, 'docIdsInOrder' | 'activate'>,
  label: string = getCurrentWindow().label,
): Promise<void> {
  try {
    // A doc on its way to another window is asked about only if it comes back, and then
    // once, even when it comes back while another prompt is open (Ruling 217).
    const asked = new Set<string>();
    for (;;) {
      await handoffsSettled();
      const ids = workspace.docIdsInOrder().filter((id) => !asked.has(arrivalKey(id)));
      if (ids.length === 0) break;
      for (const id of ids) asked.add(arrivalKey(id));
      if (!(await confirmCloseAll(ids, (id) => workspace.activate(id)))) {
        event.preventDefault();
        readyForOpenFilesAgain();
        return;
      }
    }
  } catch (err) {
    event.preventDefault();
    readyForOpenFilesAgain();
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
    // A tab on its way to another window is never asked about (Ruling 217).
    await handoffsSettled();
    if (docs.has(id)) {
      await workspace.closeDoc(id);
      return;
    }
    // It moved away. If that left this window empty, the key press closes the window.
    if (workspace.activeDocId() !== null) return;
  }
  // destroy raises no close-requested event, so the session is settled here (Ruling 209).
  await endWindowSession(label);
  // destroy, not close: there is nothing to prompt for, and close needs another capability.
  await win.destroy();
}

/**
 * Spec, Session lifetime: a window closed while other document windows stay open drops
 * its session, 2 s later and only if one of them is still open then (Ruling 220). The
 * session is saved first, so closing every window at once keeps it. Never rejects.
 */
async function endWindowSession(label: string): Promise<void> {
  try {
    await saveWindowSession(label);
    const others = (await docWindowLabels()).filter((other) => other !== label);
    if (others.length > 0) await forgetWindowSessionLater(label);
  } catch (err) {
    console.error('Could not update the session:', err);
  }
}
