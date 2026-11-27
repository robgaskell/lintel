import { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { SvelteMap } from 'svelte/reactivity';
import { allViews } from '../editor/views';
import { docs } from '../docs/store.svelte';
import { onSettingsChanged, settings, type Settings } from '../settings/settings.svelte';
import { configSource, currentConfig } from './config';
import type { LintIssue } from './lint';
import { lintExtension, relint } from './lintExtension';

export { settingsLintConfig } from './config';

/** Each open doc's latest lint issues, by doc id, for the status bar; null when not linted. */
export const lintIssues: ReadonlyMap<string, LintIssue[] | null> = new SvelteMap<string, LintIssue[] | null>();

/**
 * Lints `view`, the editor of `docId`, and keeps `lintIssues` up to date. Returns the undo.
 * Same trap as trackCursor: replacing the editor's state drops the appended extension.
 */
export function attachLint(docId: string, view: EditorView): () => void {
  const map = lintIssues as SvelteMap<string, LintIssue[] | null>;
  const token = {};
  let stopped = false;
  const report = (issues: LintIssue[] | null) => {
    if (stopped) return;
    reporters.set(docId, token);
    map.set(docId, issues);
  };
  const extension = lintExtension(
    () => currentConfig(docs.get(docId)),
    report,
    () => configSource(docs.get(docId)),
  );
  view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
  return () => {
    stopped = true;
    // A remounted pane may already lint the same doc.
    if (reporters.get(docId) !== token) return;
    reporters.delete(docId);
    map.delete(docId);
  };
}

// Which attachLint last reported for each doc.
const reporters = new Map<string, object>();

/**
 * Lints every editor again now, then after each change to the lint settings in any
 * window, as the linter itself only reacts to edits (Ruling 268). Returns a stop function.
 */
export function followLintSettings(): () => void {
  let last = lintKey(settings);
  for (const view of allViews()) relint(view);
  return onSettingsChanged((next) => {
    const key = lintKey(next);
    if (key === last) return;
    last = key;
    for (const view of allViews()) relint(view);
  });
}

function lintKey(s: Settings): string {
  return JSON.stringify(s.lint);
}
