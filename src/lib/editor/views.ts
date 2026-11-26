import type { EditorView } from '@codemirror/view';

const views = new Map<string, EditorView>();
let activeSource: { activeDocId(): string | null } | null = null;

/** Records the editor of `docId`; the returned function forgets it. */
export function registerView(docId: string, view: EditorView): () => void {
  views.set(docId, view);
  return () => {
    // A remount may already have registered a newer view for the same doc.
    if (views.get(docId) === view) views.delete(docId);
  };
}

export function viewFor(docId: string): EditorView | null {
  return views.get(docId) ?? null;
}

export function setActiveDocSource(source: { activeDocId(): string | null } | null): void {
  activeSource = source;
}

export function activeDocId(): string | null {
  return activeSource?.activeDocId() ?? null;
}

/** The editor of the active tab, for menu items that act on "the current document". */
export function activeView(): EditorView | null {
  const id = activeDocId();
  return id ? viewFor(id) : null;
}
