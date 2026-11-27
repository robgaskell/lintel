// markdownlint is large, so only lintExtension.ts loads this module, on the first lint.
import { applyFixes, type Configuration, type LintError } from 'markdownlint';
import { lint } from 'markdownlint/sync';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';

/** One markdownlint problem, as the editor uses it. */
export interface LintIssue {
  rule: string; // "MD004"
  alias: string; // "ul-style"
  line: number; // 1-based
  from: number; // document offset where the underline starts
  to: number; // document offset where it ends
  message: string; // rule description plus detail
  fixable: boolean; // markdownlint supplied fixInfo
  raw: unknown; // the original markdownlint result, passed back to applyFixes
}

// The text each issue was found in; its fix is only right for that text.
const lintedText = new WeakMap<LintIssue, string>();

/** Lints `text` with a markdownlint config such as `{ default: true, MD013: false }`. */
export function lintText(text: string, config: object): LintIssue[] {
  const results = lint({ strings: { doc: text }, config: config as Configuration }).doc ?? [];
  const starts = lineStarts(text);
  // In markdownlint's order: applyFixes keeps a different set of overlapping fixes otherwise.
  const issues = results.map((result) => toIssue(result, text, starts));
  for (const issue of issues) lintedText.set(issue, text);
  return issues;
}

/** Applies one issue's fix as its own undo step. */
export function fixOne(view: EditorView, issue: LintIssue): void {
  applyRaw(view, [issue]);
}

/**
 * Applies every fix in one transaction, so one undo reverts them all. If `issues` came
 * from text since edited, and `config` is given, lints the text now and fixes that instead.
 */
export function fixAll(view: EditorView, issues: LintIssue[], config?: object | null): void {
  const text = view.state.doc.toString();
  const current = issues.every((issue) => lintedText.get(issue) === text);
  const fresh = current || !config ? issues : lintText(text, config);
  applyRaw(view, fresh.filter((issue) => issue.fixable));
}

function applyRaw(view: EditorView, issues: LintIssue[]): void {
  const text = view.state.doc.toString();
  if (issues.length === 0 || issues.some((issue) => lintedText.get(issue) !== text)) return;
  // One call, so markdownlint can drop fixes that overlap (Ruling 267).
  const fixed = applyFixes(text, issues.map((issue) => issue.raw as LintError));
  if (fixed === text) return;
  view.dispatch({
    // One change per fixed region, so text between fixes, and a cursor in it, stay put (Ruling 279).
    changes: changesBetween(text, fixed),
    // Else a fix made just after typing joins the typing's undo step.
    annotations: isolateHistory.of('full'),
  });
}

type Change = { from: number; to: number; insert: string };

/** Changes that turn `before` into `after`: one per differing region, in order, none overlapping. */
export function changesBetween(before: string, after: string): Change[] {
  const a = lines(before);
  const b = lines(after);
  const aStarts = starts(a);
  const bStarts = starts(b);
  return lineHunks(a, b)
    .flatMap(byLine)
    .map(([a0, a1, b0, b1]) => trimmed(before, aStarts[a0], aStarts[a1], after.slice(bStarts[b0], bStarts[b1])))
    .filter((change) => change.from < change.to || change.insert !== '');
}

// Changed lines next to each other are still separate fixes.
function byLine([a0, a1, b0, b1]: Hunk): Hunk[] {
  if (a1 - a0 !== b1 - b0) return [[a0, a1, b0, b1]];
  return Array.from({ length: a1 - a0 }, (_, i): Hunk => [a0 + i, a0 + i + 1, b0 + i, b0 + i + 1]);
}

// Each line with its line break, so joining them gives the text back.
function lines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

function starts(pieces: string[]): number[] {
  const out = [0];
  for (const piece of pieces) out.push(out[out.length - 1] + piece.length);
  return out;
}

// The replacement of before[from, to) by `insert`, less the text both ends share.
function trimmed(before: string, from: number, to: number, insert: string): Change {
  let head = 0;
  while (from + head < to && head < insert.length && before[from + head] === insert[head]) head++;
  let tail = 0;
  while (
    to - tail > from + head &&
    insert.length - tail > head &&
    before[to - 1 - tail] === insert[insert.length - 1 - tail]
  ) {
    tail++;
  }
  return { from: from + head, to: to - tail, insert: insert.slice(head, insert.length - tail) };
}

type Hunk = [a0: number, a1: number, b0: number, b1: number];

// Myers' diff stores O(D²) state, so past this many edits a rougher split is used.
const MAX_EDITS = 500;

// Line ranges that differ, as [a0, a1) in `a` replaced by [b0, b1) in `b`.
function lineHunks(a: string[], b: string[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  const matched = matchingRuns(a, start, endA, b, start, endB);
  if (matched) return gapsBetween(matched, start, endA, start, endB);
  // Too many edits for that: one span, which byLine splits if no lines were added or removed.
  return [[start, endA, start, endB]];
}

function gapsBetween(runs: [number, number, number][], a0: number, a1: number, b0: number, b1: number): Hunk[] {
  const hunks: Hunk[] = [];
  let x = a0;
  let y = b0;
  for (const [rx, ry, length] of [...runs, [a1, b1, 0] as [number, number, number]]) {
    if (rx > x || ry > y) hunks.push([x, rx, y, ry]);
    x = rx + length;
    y = ry + length;
  }
  return hunks;
}

// Runs of equal lines [x, y, length] in order (Myers), or null past MAX_EDITS.
function matchingRuns(
  a: string[],
  a0: number,
  a1: number,
  b: string[],
  b0: number,
  b1: number,
): [number, number, number][] | null {
  const n = a1 - a0;
  const m = b1 - b0;
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // trace[d] holds v for diagonals -d-1..d+1 before step d.
  const trace: Int32Array[] = [];
  let edits = -1;
  search: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        edits = d;
        break search;
      }
    }
  }
  if (edits < 0) return null;
  const runs: [number, number, number][] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const before = trace[d];
    const at = (k: number) => before[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const runX = down ? prevX : prevX + 1;
    if (x > runX) runs.push([a0 + runX, b0 + runX - k, x - runX]);
    x = prevX;
    y = prevX - prevK;
  }
  if (x > 0) runs.push([a0, b0, x]);
  return runs.reverse();
}

function toIssue(result: LintError, text: string, starts: number[]): LintIssue {
  const lineStart = starts[result.lineNumber - 1] ?? text.length;
  const lineEnd = lineEndAt(text, lineStart);
  const [column, length] = result.errorRange ?? [1, lineEnd - lineStart];
  const from = Math.min(lineStart + column - 1, lineEnd);
  const to = Math.min(from + length, lineEnd);
  return {
    rule: result.ruleNames[0],
    alias: result.ruleNames[1] ?? result.ruleNames[0],
    line: result.lineNumber,
    from,
    to,
    message: result.errorDetail ? `${result.ruleDescription} [${result.errorDetail}]` : result.ruleDescription,
    fixable: result.fixInfo != null,
    raw: result,
  };
}

// markdownlint splits lines at CRLF, CR and LF.
function lineStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}

function lineEndAt(text: string, lineStart: number): number {
  const end = text.slice(lineStart).search(/\r|\n/);
  return end < 0 ? text.length : lineStart + end;
}
