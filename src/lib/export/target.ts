import { message } from '@tauri-apps/plugin-dialog';
import { findByPath, normalizedOrAsGiven, opening } from '../docs/store.svelte';
import { claimPath, releasePath } from '../ipc';

/**
 * Runs `write` while this window claims `path`, so no window opens it meanwhile. A file open
 * in Lintel is refused with a dialog: its tab would never hear of the export, and its next
 * save would undo it (Rulings 309, 314). Resolves null when refused.
 */
export async function writeUnlessOpen<T extends object>(path: string, write: () => Promise<T>): Promise<T | null> {
  const chosen = await normalizedOrAsGiven(path);
  const openHere = findByPath(chosen) !== undefined || opening.has(chosen);
  const result = openHere ? null : await whileClaimed(chosen, write);
  if (result === null) {
    await message('That file is open in Lintel. Choose another name.', { title: 'Lintel', kind: 'error' });
  }
  return result;
}

/** The default name for an export: the doc's path or title, with `.md` swapped for `extension`. */
export function exportName(doc: { path: string | null; title: string }, extension: string): string {
  return `${withoutMarkdownExtension(doc.path ?? doc.title)}.${extension}`;
}

export function withoutMarkdownExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '');
}

/** Null if another window has `path`. */
async function whileClaimed<T>(path: string, write: () => Promise<T>): Promise<T | null> {
  opening.add(path);
  try {
    return (await claimPath(path)) === null ? await write() : null;
  } finally {
    opening.delete(path);
    // Drops only this window's claim; another window's stays.
    if (!findByPath(path)) releasePath(path).catch((err) => console.error(`Could not release ${path}:`, err));
  }
}
