/** A source line and the preview offset (px from the scroller's top) where it starts. */
export interface Anchor {
  line: number;
  top: number;
}

/**
 * The preview offset for a source line, which may be fractional. Lines outside the anchors
 * clamp to the first or last one. `anchors` must come from `cleanAnchors`.
 */
export function lineToOffset(anchors: Anchor[], line: number): number {
  const [a, b] = bracket(anchors, (anchor) => anchor.line, line);
  if (!a) return 0;
  if (!b || b.line === a.line) return a.top;
  return a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top);
}

/** The inverse of `lineToOffset`: the source line, maybe fractional, shown at `top`. */
export function offsetToLine(anchors: Anchor[], top: number): number {
  const [a, b] = bracket(anchors, (anchor) => anchor.top, top);
  if (!a) return 1;
  if (!b || b.top === a.top) return a.line;
  return a.line + ((top - a.top) / (b.top - a.top)) * (b.line - a.line);
}

/**
 * Anchors in line order with no repeated line, whose tops never run backwards.
 * Raw HTML in a document can forge line numbers, so anchors are untrusted (Ruling 85):
 * the longest run that agrees with page order is kept and the rest are dropped.
 */
export function cleanAnchors(raw: Anchor[]): Anchor[] {
  const firstTop = new Map<number, number>();
  for (const { line, top } of raw) {
    if (line < 1 || !Number.isFinite(line) || !Number.isFinite(top)) continue;
    const seen = firstTop.get(line);
    if (seen === undefined || top < seen) firstTop.set(line, top);
  }
  const byTop = [...firstTop].map(([line, top]) => ({ line, top }));
  byTop.sort((x, y) => x.top - y.top || x.line - y.line);
  return longestRisingByLine(byTop);
}

/** Spec: preview re-render waits 150 ms, plus 50 ms per MB (1 MB = 1,000,000 bytes). */
export function renderDelayMs(byteLength: number): number {
  return 150 + (50 * byteLength) / 1_000_000;
}

/**
 * Marks the next scroll event on one side as the echo of a programmatic scroll, so it
 * is not synced back. If no event comes (the side was already there), the mark lapses
 * after `fallbackMs`, so a later user scroll is not swallowed (Ruling 97).
 */
export function createScrollLock(fallbackMs: number): { hold(): void; skip(): boolean } {
  let until = 0;
  return {
    hold: () => {
      until = Date.now() + fallbackMs;
    },
    skip: () => {
      const echo = Date.now() < until;
      until = 0;
      return echo;
    },
  };
}

/**
 * The last anchor at or before `value` and the one after it, by `key`. Clamps to the
 * first anchor below the range and to the last one above it. Binary search: a long
 * document has thousands of anchors and this runs on every scroll event.
 */
function bracket(
  anchors: Anchor[],
  key: (a: Anchor) => number,
  value: number,
): [Anchor | undefined, Anchor | undefined] {
  const first = anchors[0];
  if (!first || value <= key(first)) return [first, undefined];
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (key(anchors[mid]!) <= value) lo = mid;
    else hi = mid - 1;
  }
  // Exactly on a run of equal keys: start from the first of them.
  while (lo > 0 && key(anchors[lo - 1]!) === value) lo -= 1;
  return [anchors[lo], anchors[lo + 1]];
}

// Patience sorting: O(n log n) longest subsequence with strictly rising lines.
function longestRisingByLine(anchors: Anchor[]): Anchor[] {
  const tails: number[] = []; // index into anchors of the smallest tail for each length
  const previous: number[] = [];
  anchors.forEach((anchor, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[tails[mid]!]!.line < anchor.line) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  });
  const kept: Anchor[] = [];
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = previous[i]!) kept.push(anchors[i]!);
  return kept.reverse();
}
