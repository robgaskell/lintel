import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import {
  FILE_CHANGED,
  FILE_REMOVED,
  pathsExist,
  readTextFile,
  type FileChangedEvent,
  type FileRemovedEvent,
} from '../ipc';
import { activeDocId, viewFor } from '../editor/views';
import type { Workspace } from '../layout/workspace';
import { docs, findByPath, isDirty, type DocState } from './store.svelte';
import { detectLineEnding, toBuffer, type LineEnding } from './text';

let showNotice: (text: string) => void = () => {};
let reloadOffShown = false;

/** Each window sets its shower once, so the "Live reload is off" notice starts unshown. */
export function setReloadNoticeShower(show: (text: string) => void): void {
  showNotice = show;
  reloadOffShown = false;
}

/** Says once per window that files no longer reload, with the first reason. */
export function reportLiveReloadOff(err: unknown): void {
  console.error('Live reload is off:', err);
  if (reloadOffShown) return;
  reloadOffShown = true;
  showNotice(`Live reload is off: ${err instanceof Error ? err.message : String(err)}`);
}

// Until a workspace is followed, only the active tab counts as shown.
let isShown: (id: string) => boolean = (id) => activeDocId() === id;

/**
 * A clean doc takes the disk version: quietly where a group shows it, marked "Updated"
 * where none does. A dirty doc keeps the user's text and holds the disk version for the
 * banner.
 */
export async function handleFileChanged(e: FileChangedEvent): Promise<void> {
  // A save or an edit during the read makes it stale; the event is then looked at again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const doc = findByPath(e.path);
    if (!doc || (e.hash === doc.diskHash && doc.external !== 'deleted')) return;
    if ((await reloadFromDisk(doc, e.path)) !== 'stale') return;
  }
}

async function reloadFromDisk(doc: DocState, path: string): Promise<'done' | 'stale'> {
  const before = { diskHash: doc.diskHash, savedText: doc.savedText, dirty: isDirty(doc) };
  let read;
  try {
    read = await readTextFile(path);
  } catch (err) {
    console.error(`Could not reload ${path}:`, err);
    return 'done';
  }
  if (docs.get(doc.id) !== doc || doc.path !== path) return 'done';
  const changed =
    doc.diskHash !== before.diskHash || doc.savedText !== before.savedText || isDirty(doc) !== before.dirty;
  if (changed) return 'stale';
  if (read.hash === doc.diskHash) {
    if (doc.external === 'deleted') doc.external = 'none';
    return 'done';
  }
  if (isDirty(doc)) {
    doc.external = 'conflict';
    doc.diskText = toBuffer(read.text);
    // Kept by keepMine, so this disk version is not reported again.
    doc.diskHash = read.hash;
    return 'done';
  }
  showDiskVersion(doc, toBuffer(read.text), detectLineEnding(read.text), read.hash);
  doc.external = isShown(doc.id) ? 'none' : 'updated';
  showNotice(`${doc.title} reloaded from disk`);
  return 'done';
}

/**
 * The tab keeps its text, marked "Deleted on disk"; a save writes the file again. A save
 * that put the file back since the event leaves the doc alone.
 */
export async function handleFileRemoved(e: FileRemovedEvent): Promise<void> {
  if (!findByPath(e.path)) return;
  let exists;
  try {
    [exists] = await pathsExist([e.path]);
  } catch (err) {
    console.error(`Could not check ${e.path}:`, err);
    return;
  }
  const doc = findByPath(e.path);
  if (!doc || exists) return;
  doc.external = 'deleted';
  doc.diskText = null;
}

/** Keeps the user's text; it stays unsaved against the newer file on disk. */
export function keepMine(id: string): void {
  const doc = docs.get(id);
  if (!doc || doc.external !== 'conflict') return;
  if (doc.diskText !== null) doc.savedText = doc.diskText;
  doc.diskText = null;
  doc.external = 'none';
}

/**
 * Replaces the user's text with the file as it is now, as one undoable edit (Ruling 258).
 * The file is read again, so its line ending and hash are current. A failed read keeps the
 * banner.
 */
export async function loadDisk(id: string): Promise<void> {
  const doc = docs.get(id);
  if (!doc || doc.external !== 'conflict' || doc.path === null) return;
  let read;
  try {
    read = await readTextFile(doc.path);
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
    return;
  }
  if (docs.get(id) !== doc || doc.external !== 'conflict') return;
  showDiskVersion(doc, toBuffer(read.text), detectLineEnding(read.text), read.hash);
  doc.external = 'none';
}

/** A tab the user opens has shown its update. */
export function markSeen(id: string | null): void {
  const doc = id === null ? undefined : docs.get(id);
  if (doc?.external === 'updated') doc.external = 'none';
}

/** Clears "Updated" on the tab that becomes active, and asks `ws` which docs a group shows. */
export function followWorkspace(ws: Pick<Workspace, 'onActiveChange' | 'isVisible'>): () => void {
  isShown = (id) => ws.isVisible(id);
  const stop = ws.onActiveChange(markSeen);
  return () => {
    stop();
    isShown = (id) => activeDocId() === id;
  };
}

/** Rust sends each change to the window that watches the file only. */
export function listenForFileEvents(label: string): { ready: Promise<void>; stop: () => void } {
  const options = { target: { kind: 'WebviewWindow' as const, label } };
  const listening = Promise.all([
    listen<FileChangedEvent>(FILE_CHANGED, ({ payload }) => void handleFileChanged(payload), options),
    listen<FileRemovedEvent>(FILE_REMOVED, ({ payload }) => void handleFileRemoved(payload), options),
  ]);
  return {
    // Settles either way: without the listeners, docs still open but never reload.
    ready: listening.then(() => {}, reportLiveReloadOff),
    stop: () => void listening.then((stops) => stops.forEach((stop) => stop())).catch(() => {}),
  };
}

function showDiskVersion(doc: DocState, text: string, lineEnding: LineEnding, hash: string): void {
  const view = viewFor(doc.id);
  if (view) replaceKeepingCursorLine(view, text);
  doc.text = text;
  doc.savedText = text;
  doc.lineEnding = lineEnding;
  doc.diskHash = hash;
  doc.diskText = null;
}

/**
 * One transaction, kept apart from the edits around it in the undo history. Only the
 * differing middle is replaced, so the editor does not jump; the cursor stays on its line.
 */
function replaceKeepingCursorLine(view: EditorView, text: string): void {
  const { state } = view;
  const old = state.doc.toString();
  if (old === text) return;
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < text.length - start &&
    old[old.length - 1 - end] === text[text.length - 1 - end]
  ) {
    end++;
  }
  const head = state.doc.lineAt(state.selection.main.head);
  const column = state.selection.main.head - head.from;
  const next = state.toText(text);
  const line = next.line(Math.min(head.number, next.lines));
  view.dispatch({
    changes: { from: start, to: old.length - end, insert: text.slice(start, text.length - end) },
    selection: { anchor: line.from + Math.min(column, line.length) },
    annotations: isolateHistory.of('full'),
  });
}
