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
