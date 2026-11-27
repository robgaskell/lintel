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

/** Applies every fix in one transaction, so one undo reverts them all. */
export function fixAll(view: EditorView, issues: LintIssue[]): void {
  applyRaw(view, issues.filter((issue) => issue.fixable));
}

function applyRaw(view: EditorView, issues: LintIssue[]): void {
  const text = view.state.doc.toString();
  if (issues.length === 0 || issues.some((issue) => lintedText.get(issue) !== text)) return;
  // One call, so markdownlint can drop fixes that overlap (Ruling 267).
  const fixed = applyFixes(text, issues.map((issue) => issue.raw as LintError));
  if (fixed === text) return;
  view.dispatch({
    changes: changedSpan(text, fixed),
    // Else a fix made just after typing joins the typing's undo step.
    annotations: isolateHistory.of('full'),
  });
}

// The smallest single replacement that turns `before` into `after`.
function changedSpan(before: string, after: string): { from: number; to: number; insert: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
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
