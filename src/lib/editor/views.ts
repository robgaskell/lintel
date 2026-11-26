import type { EditorView } from '@codemirror/view';
import { onSettingsChanged, settings, type Settings } from '../settings/settings.svelte';

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

/**
 * Re-measures every editor after a font or size change in any window. CodeMirror keeps
 * line heights it measured, so wrapped rows and the gutter drift apart until it does
 * (Ruling 161). Returns a stop function.
 */
export function remeasureOnFontChange(): () => void {
  let last = fontKey(settings);
  return onSettingsChanged((next) => {
    const key = fontKey(next);
    if (key === last) return;
    last = key;
    for (const view of views.values()) view.requestMeasure();
  });
}

function fontKey(s: Settings): string {
  return JSON.stringify([s.readingFont, s.editorFont, s.fontSize]);
}
