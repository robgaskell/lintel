import { SvelteMap } from 'svelte/reactivity';
import { message, save } from '@tauri-apps/plugin-dialog';
import { normalizePath, writeTextFile } from '../ipc';
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
  docs.delete(id);
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
  await writeTo(doc, path);
  doc.path = await normalizedOrAsGiven(path);
  doc.title = baseName(doc.path);
  // Every Save As route passes here: the menu, Cmd+S on untitled, the close prompt (Ruling 49).
  await recordRecent(doc.path);
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

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
