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

/** Resolves to false if the user cancels the Save As dialog. */
export async function saveDoc(id: string): Promise<boolean> {
  const doc = docs.get(id);
  if (!doc) return false;
  // A clean save must not touch the file, so its bytes stay identical.
  if (!isDirty(doc) && doc.external !== 'deleted') return true;
  if (doc.path === null) return saveDocAs(id);
  await writeTo(doc, doc.path);
  return true;
}

export async function saveDocAs(id: string): Promise<boolean> {
  const doc = docs.get(id);
  if (!doc) return false;
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

export function findByPath(path: string): DocState | undefined {
  for (const doc of docs.values()) {
    if (doc.path === path) return doc;
  }
  return undefined;
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
