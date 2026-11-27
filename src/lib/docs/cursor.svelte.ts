import { StateEffect, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { SvelteMap } from 'svelte/reactivity';

/** 1-based line and column of the main cursor. */
export interface Cursor {
  line: number;
  col: number;
}

/** The cursor of each open doc's editor, by doc id, for the status bar. */
export const cursors: ReadonlyMap<string, Cursor> = new SvelteMap<string, Cursor>();

/**
 * Keeps `cursors` up to date for `docId` from `view` (Ruling 109). Returns the undo.
 * Trap: `view.setState` or a full `StateEffect.reconfigure` drops the appended listener,
 * and the status bar then freezes. Whatever replaces the state must call this again.
 */
export function trackCursor(docId: string, view: EditorView): () => void {
  const map = cursors as SvelteMap<string, Cursor>;
  let stopped = false;
  let last: Cursor | null = null;
  const record = (state: EditorState) => {
    if (stopped) return;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    last = { line: line.number, col: head - line.from + 1 };
    map.set(docId, last);
  };

  record(view.state);
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) record(update.state);
      }),
    ),
  });
  return () => {
    stopped = true;
    // A remounted pane may already track the same doc.
    if (cursors.get(docId) === last) map.delete(docId);
  };
}

// Where to put the cursor when a doc's editor first mounts, for docs moved from another window.
const startCursors = new Map<string, Cursor>();

/** Puts the cursor of the next editor for `docId` at `cursor` (Rulings 186, 201). */
export function setStartCursor(docId: string, cursor: Cursor): void {
  startCursors.set(docId, cursor);
}

/** The cursor set for `docId`, once; later editors for it start at the top as usual. */
export function takeStartCursor(docId: string): Cursor | undefined {
  const cursor = startCursors.get(docId);
  startCursors.delete(docId);
  return cursor;
}

const topLines = new Map<string, number>();

/** The first visible source line of each doc's pane, 1-based, for the session (Ruling 208). */
export function setTopLine(docId: string, line: number): void {
  topLines.set(docId, Math.max(1, Math.floor(line)));
}

export function topLineOf(docId: string): number {
  return topLines.get(docId) ?? 1;
}

// Lines restored from the session, scrolled to the top when each doc's pane first mounts.
const startTopLines = new Map<string, number>();

export function setStartTopLine(docId: string, line: number): void {
  startTopLines.set(docId, line);
  setTopLine(docId, line);
}

/** The line set for `docId`, once. */
export function takeStartTopLine(docId: string): number | undefined {
  const line = startTopLines.get(docId);
  startTopLines.delete(docId);
  return line;
}
