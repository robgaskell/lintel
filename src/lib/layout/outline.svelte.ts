import { SvelteMap } from 'svelte/reactivity';
import type { Heading } from '../render/markdown';

/**
 * Whether this window shows the outline panel. Each window has its own webview, so
 * module state is per window. M4.4 persists it as WindowSession.outlineVisible.
 */
export const outline = $state({ visible: true });

/** What the window's one outline panel shows for a doc; its pane keeps it current. */
export interface OutlineSource {
  readonly headings: Heading[];
  readonly activeLine: number;
  pick(heading: Heading): void;
}

/** Keyed by doc id. The outline shows the active doc's entry (Ruling 181). */
export const outlineSources: Map<string, OutlineSource> = new SvelteMap();

/**
 * Where the window's one outline goes: inside the pane of `anchorId`, the tab shown in the
 * top-left group, so it sits under a tab strip and toolbar as in the Main artboard
 * (Ruling 191). It lists the headings of `docId`, the active doc.
 */
export const outlinePlacement = $state<{ anchorId: string | null; docId: string | null }>({
  anchorId: null,
  docId: null,
});
