import { SvelteMap } from 'svelte/reactivity';
import { message, save } from '@tauri-apps/plugin-dialog';
import { claimPath, normalizePath, releasePath, writeTextFile } from '../ipc';
import { recordRecent } from '../os/recent';
import { detectLineEnding, toBuffer, toDisk, type LineEnding } from './text';

export type ViewMode = 'edit' | 'split' | 'read';

/** One open document, keyed by id in `docs`. */
export interface DocState {
  id: string;
  path: string | null;
  title: string;
  text: string;
  savedText: string;
  lineEnding: LineEnding;
  diskHash: string;
  pinned: boolean;
  mode: ViewMode;
  external: 'none' | 'updated' | 'conflict' | 'deleted';
  diskText: string | null;
  lintConfigPath: string | null;
}

// $state does not track Map.set/delete, so the map itself is a SvelteMap.
export const docs: Map<string, DocState> = $state(new SvelteMap());

export const untitledCounter = $state({ n: 0 });

export function createDoc(init: {
  path: string | null;
  raw: string;
  hash: string;
  mode: ViewMode;
}): DocState {
  const text = toBuffer(init.raw);
  const doc = $state<DocState>({
    id: crypto.randomUUID(),
    path: init.path,
    title: init.path === null ? `Untitled-${++untitledCounter.n}` : baseName(init.path),
    text,
    savedText: text,
    lineEnding: detectLineEnding(init.raw),
    diskHash: init.hash,
    pinned: false,
    mode: init.mode,
    external: 'none',
    diskText: null,
    lintConfigPath: null,
  });
  docs.set(doc.id, doc);
  return doc;
}

/** Inserts a doc handed over from another window as it is, unsaved edits included (Ruling 186). */
export function adoptDoc(state: DocState): DocState {
  const doc = $state<DocState>({ ...state });
  docs.set(doc.id, doc);
  return doc;
}

/**
 * Every way a doc leaves this window ends here, so its path is released for other windows
 * (Ruling 185). It does not prompt.
 */
export function removeDoc(id: string): void {
  const path = docs.get(id)?.path ?? null;
  docs.delete(id);
  if (path !== null) void release(path);
}

export function isDirty(doc: DocState): boolean {
  return doc.text !== doc.savedText;
}

/**
 * Resolves to false only if the user cancels the Save As dialog.
 * Rejects for an unknown id. A second call while a save is running gets the first call's promise.
 */
export function saveDoc(id: string): Promise<boolean> {
  return onceAtATime(id, async () => runSave(getDoc(id)));
}

/** As saveDoc, but always asks for a path. */
export function saveDocAs(id: string): Promise<boolean> {
  return onceAtATime(id, async () => runSaveAs(getDoc(id)));
}

/**
 * Asks Save / Don't Save / Cancel when the doc is dirty, then removes it from `docs`.
 * False means the doc stays open: Cancel, a cancelled Save As, or a failed save.
 */
export async function closeDocWithPrompt(id: string): Promise<boolean> {
  if (!(await mayClose(getDoc(id)))) return false;
  removeDoc(id);
  return true;
}

/**
 * Prompts for each dirty doc in `ids`, in order, without closing any of them.
 * False at the first Cancel. `beforeAsk` lets the caller show the doc being asked about.
 */
export async function confirmCloseAll(
  ids: string[],
  beforeAsk?: (id: string) => void,
): Promise<boolean> {
  for (const id of ids) {
    const doc = docs.get(id);
    if (!doc || !isDirty(doc)) continue;
    beforeAsk?.(id);
    if (!(await mayClose(doc))) return false;
  }
  return true;
}

/** Resolves once every save running now has finished, whatever its outcome. */
export async function savesSettled(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}

export function findByPath(path: string): DocState | undefined {
  for (const doc of docs.values()) {
    if (doc.path === path) return doc;
  }
  return undefined;
}

const inFlight = new Map<string, Promise<boolean>>();

// A double Cmd+S must not start two writes of the same doc (Ruling 11).
function onceAtATime(id: string, run: () => Promise<boolean>): Promise<boolean> {
  const running = inFlight.get(id);
  if (running) return running;
  const promise = run().finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

function getDoc(id: string): DocState {
  const doc = docs.get(id);
  if (!doc) throw new Error(`No open document has id ${id}`);
  return doc;
}

async function runSave(doc: DocState): Promise<boolean> {
  // Untitled docs always ask for a path, even when empty (Ruling 14).
  if (doc.path === null) return runSaveAs(doc);
  // A clean save must not touch the file, so its bytes stay identical.
  if (!isDirty(doc) && doc.external !== 'deleted') return true;
  await writeTo(doc, doc.path);
  return true;
}

async function runSaveAs(doc: DocState): Promise<boolean> {
  const path = await save({
    defaultPath: doc.path ?? `${doc.title}.md`,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (path === null) return false;
  const oldPath = doc.path;
  // A file that does not exist yet keeps the spelling chosen until it is written.
  const chosen = await normalizedOrAsGiven(path);
  if (chosen !== oldPath && (await claimPath(chosen)) !== null) {
    // A file is never open in two places (spec), so Save As must not write over it.
    const text =
      `${baseName(chosen)} is open in another window. ` +
      'Close it there first, or choose another name.';
    await message(text, { title: 'Lintel', kind: 'error' });
    return false;
  }
  try {
    await writeTo(doc, path);
  } catch (err) {
    if (chosen !== oldPath) void release(chosen);
    throw err;
  }
  doc.path = await normalizedOrAsGiven(path);
  doc.title = baseName(doc.path);
  if (doc.path !== chosen) {
    void claimPath(doc.path).catch((err) => console.error('Could not claim the saved file:', err));
    void release(chosen);
  }
  if (oldPath !== null && oldPath !== doc.path) void release(oldPath);
  // Every Save As route passes here (Ruling 49). Not awaited: a slow store must not delay a save.
  void recordRecent(doc.path);
  return true;
}

async function writeTo(doc: DocState, path: string): Promise<void> {
  // Snapshot first: edits typed while the write is in flight stay unsaved.
  const text = doc.text;
  const hash = await writeTextFile(path, toDisk(text, doc.lineEnding));
  doc.savedText = text;
  doc.diskHash = hash;
  doc.external = 'none';
  doc.diskText = null;
}

const SAVE = 'Save';
const DONT_SAVE = "Don't Save";
const CANCEL = 'Cancel';

async function mayClose(doc: DocState): Promise<boolean> {
  if (!isDirty(doc)) return true;
  const answer = await message(`Do you want to save the changes you made to "${doc.title}"?`, {
    title: 'Lintel',
    kind: 'warning',
    buttons: { yes: SAVE, no: DONT_SAVE, cancel: CANCEL },
  });
  // The dialog returns the clicked label; anything unexpected (Esc, a dismissed sheet) is Cancel.
  if (answer === DONT_SAVE) return true;
  if (answer !== SAVE) return false;
  try {
    if (!(await saveDoc(doc.id))) return false;
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
    return false;
  }
  // A save already running when Save was chosen wrote an older snapshot (Ruling 42).
  return !isDirty(doc);
}

// The file is already written, so failing here would lose track of it; the chosen
// spelling only weakens duplicate detection in openPaths.
async function normalizedOrAsGiven(path: string): Promise<string> {
  try {
    return await normalizePath(path);
  } catch {
    return path;
  }
}

// A failed release only leaves the file claimed by this window until it closes.
async function release(path: string): Promise<void> {
  // Another tab of this window may still show the file.
  if (findByPath(path)) return;
  try {
    await releasePath(path);
  } catch (err) {
    console.error(`Could not release ${path}:`, err);
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
