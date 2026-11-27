import type { EditorView } from '@codemirror/view';
import { fontCompartment, fontTheme } from './setup';
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

/** Every open editor in this window. */
export function allViews(): EditorView[] {
  return [...views.values()];
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
 * Puts the editor font and size into every editor now, then after each change to either
 * in any window (Ruling 170). Returns a stop function.
 */
export function followEditorFont(): () => void {
  let last = fontKey(settings);
  for (const view of views.values()) setFont(view, settings);
  return onSettingsChanged((next) => {
    const key = fontKey(next);
    if (key === last) return;
    last = key;
    for (const view of views.values()) setFont(view, next);
  });
}

function setFont(view: EditorView, s: Settings): void {
  view.dispatch({ effects: fontCompartment.reconfigure(fontTheme(s)) });
}

function fontKey(s: Settings): string {
  return JSON.stringify([s.editorFont, s.fontSize]);
}
