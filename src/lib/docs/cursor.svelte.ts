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

// Lines to put the cursor on when a doc's editor first mounts, for docs moved from another window.
const startLines = new Map<string, number>();

/** Puts the cursor of the next editor for `docId` on `line` (Ruling 186). */
export function setStartLine(docId: string, line: number): void {
  startLines.set(docId, line);
}

/** The line set for `docId`, once; later editors for it start at the top as usual. */
export function takeStartLine(docId: string): number | undefined {
  const line = startLines.get(docId);
  startLines.delete(docId);
  return line;
}
