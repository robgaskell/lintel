import { message } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { confirmCloseAll, docs, handoffsSettled, savesSettled } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';

let quitting: Promise<void> | null = null;

/**
 * Asks about each dirty doc (tab order when `workspace` is given), then exits.
 * Cancel at any prompt stops the quit and closes nothing (Ruling 32).
 */
export function quitApp(workspace?: Pick<Workspace, 'docIdsInOrder' | 'activate'>): Promise<void> {
  // A second Cmd+Q while a prompt is open must not stack another round of prompts.
  quitting ??= runQuit(workspace).finally(() => (quitting = null));
  return quitting;
}

async function runQuit(workspace?: Pick<Workspace, 'docIdsInOrder' | 'activate'>): Promise<void> {
  try {
    // A doc mid-save is still dirty: asking now would offer to exit mid-write.
    await savesSettled();
    // A doc on its way to another window may come back, and must then be asked about.
    await handoffsSettled();
    const ordered = workspace?.docIdsInOrder() ?? [];
    const rest = [...docs.keys()].filter((id) => !ordered.includes(id));
    if (!(await confirmCloseAll([...ordered, ...rest], (id) => workspace?.activate(id)))) return;
    // exit() raises no close-requested event, so the window prompt does not run again.
    await exit(0);
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
  }
}
