import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { listen } from '@tauri-apps/api/event';
import {
  FILE_CHANGED,
  FILE_REMOVED,
  readTextFile,
  type FileChangedEvent,
  type FileRemovedEvent,
} from '../ipc';
import { activeDocId, viewFor } from '../editor/views';
import type { Workspace } from '../layout/workspace';
import { docs, findByPath, isDirty, type DocState } from './store.svelte';
import { detectLineEnding, toBuffer, type LineEnding } from './text';

let showNotice: (text: string) => void = () => {};

export function setReloadNoticeShower(show: (text: string) => void): void {
  showNotice = show;
}

// The line ending of a conflict's disk version, which `diskText` holds as an LF buffer.
const diskEndings = new Map<string, LineEnding>();

/**
 * A clean doc takes the disk version: quietly in the active tab, marked "Updated" in
 * another. A dirty doc keeps the user's text and holds the disk version for the banner.
 */
export async function handleFileChanged(e: FileChangedEvent): Promise<void> {
  const doc = findByPath(e.path);
  if (!doc || (e.hash === doc.diskHash && doc.external !== 'deleted')) return;
  let read;
  try {
    read = await readTextFile(e.path);
  } catch (err) {
    console.error(`Could not reload ${e.path}:`, err);
    return;
  }
  // Closed, moved or saved elsewhere while the file was read.
  if (docs.get(doc.id) !== doc || doc.path !== e.path) return;
  if (read.hash === doc.diskHash) {
    if (doc.external === 'deleted') doc.external = 'none';
    return;
  }
  if (isDirty(doc)) {
    doc.external = 'conflict';
    doc.diskText = toBuffer(read.text);
    // Kept by keepMine, so this disk version is not reported again.
    doc.diskHash = read.hash;
    diskEndings.set(doc.id, detectLineEnding(read.text));
    return;
  }
  showDiskVersion(doc, toBuffer(read.text), detectLineEnding(read.text), read.hash);
  doc.external = activeDocId() === doc.id ? 'none' : 'updated';
  showNotice(`${doc.title} reloaded from disk`);
}

/** The tab keeps its text, marked "Deleted on disk"; a save writes the file again. */
export function handleFileRemoved(e: FileRemovedEvent): void {
  const doc = findByPath(e.path);
  if (!doc) return;
  doc.external = 'deleted';
  doc.diskText = null;
  diskEndings.delete(doc.id);
}

/** Keeps the user's text; it stays unsaved against the newer file on disk. */
export function keepMine(id: string): void {
  const doc = docs.get(id);
  if (!doc || doc.external !== 'conflict') return;
  if (doc.diskText !== null) doc.savedText = doc.diskText;
  doc.diskText = null;
  doc.external = 'none';
  diskEndings.delete(id);
}

/** Replaces the user's text with the disk version, as one undoable edit (Ruling 258). */
export function loadDisk(id: string): void {
  const doc = docs.get(id);
  if (!doc || doc.external !== 'conflict' || doc.diskText === null) return;
  showDiskVersion(doc, doc.diskText, diskEndings.get(id) ?? doc.lineEnding, doc.diskHash);
  doc.external = 'none';
  diskEndings.delete(id);
}

/** A tab the user opens has shown its update. */
export function markSeen(id: string | null): void {
  const doc = id === null ? undefined : docs.get(id);
  if (doc?.external === 'updated') doc.external = 'none';
}

export function clearUpdatesOnActivation(ws: Pick<Workspace, 'onActiveChange'>): () => void {
  return ws.onActiveChange(markSeen);
}

/** Rust sends each change to the window that watches the file only. */
export function listenForFileEvents(label: string): { ready: Promise<void>; stop: () => void } {
  const options = { target: { kind: 'WebviewWindow' as const, label } };
  const listening = Promise.all([
    listen<FileChangedEvent>(FILE_CHANGED, ({ payload }) => void handleFileChanged(payload), options),
    listen<FileRemovedEvent>(FILE_REMOVED, ({ payload }) => handleFileRemoved(payload), options),
  ]);
  return {
    // Settles either way: without the listeners, docs still open but never reload.
    ready: listening.then(
      () => {},
      (err) => console.error('Could not listen for file changes:', err),
    ),
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
