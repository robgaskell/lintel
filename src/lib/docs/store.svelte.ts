import { SvelteMap } from 'svelte/reactivity';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '../ipc';
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
  doc.path = path;
  doc.title = baseName(path);
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

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
