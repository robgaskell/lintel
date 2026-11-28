import { SvelteMap } from 'svelte/reactivity';
import type { Heading } from '../render/markdown';

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 210;

/**
 * This window's outline column. Each window has its own webview, so module state is per
 * window. Persisted as WindowSession.outlineVisible, outlineCollapsed and outlineWidth.
 */
export const outline = $state({ visible: true, collapsed: false, width: DEFAULT_WIDTH });

/** The width a drag of the edge asks for, clamped to 160-480 px and rounded. */
export function setOutlineWidth(px: number): void {
  if (!Number.isFinite(px)) return;
  outline.width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)));
}

export function resetOutlineWidth(): void {
  outline.width = DEFAULT_WIDTH;
}

// The tab groups keep at least this much of the window.
const MIN_DOCK_WIDTH = 320;

/** The width to show: the saved one, narrowed to leave the tabs 320 px, but never below 160. */
export function shownOutlineWidth(saved: number, windowWidth: number): number {
  return Math.max(MIN_WIDTH, Math.min(saved, windowWidth - MIN_DOCK_WIDTH));
}

/** A saved width is kept only as a whole number of px in range; a v0.1.0 session has none. */
export function restoreOutlineWidth(saved: unknown): number {
  return typeof saved === 'number' && Number.isInteger(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH
    ? saved
    : DEFAULT_WIDTH;
}

/** What the window's one outline panel shows for a doc; its pane keeps it current. */
export interface OutlineSource {
  readonly headings: Heading[];
  readonly activeLine: number;
  pick(heading: Heading): void;
}

/** Keyed by doc id. The outline shows the active doc's entry (Ruling 181). */
export const outlineSources: Map<string, OutlineSource> = new SvelteMap();
