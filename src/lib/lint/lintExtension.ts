import {
  forEachDiagnostic,
  forceLinting,
  linter,
  setDiagnosticsEffect,
  type Diagnostic,
} from '@codemirror/lint';
import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from '@codemirror/state';
import { EditorView, GutterMarker, gutterLineClass, hoverTooltip, type Tooltip } from '@codemirror/view';
import { message } from '@tauri-apps/plugin-dialog';
import type { LintIssue } from './lint';
import { disableRule } from './ruleSettings';

export const LINT_DELAY_MS = 400;
/** Larger documents are not linted, so typing in them stays quick (Ruling 268). */
export const MAX_LINT_BYTES = 1_000_000;

type LintModule = typeof import('./lint');

// markdownlint is loaded on the first lint, so startup and Settings never parse it.
let loading: Promise<LintModule> | null = null;
let loaded: LintModule | null = null;

function loadLint(): Promise<LintModule> {
  loading ??= import('./lint').then(
    (module) => (loaded = module),
    (err) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

// The issue behind each diagnostic, for the hover card.
const issueOf = new WeakMap<Diagnostic, LintIssue>();
// The config file each issue's rules came from; null for Settings.
const sourceOf = new WeakMap<LintIssue, string | null>();

/**
 * Lints the editor's text with the config `getConfig` returns, or not at all when it
 * returns null (linting off). `onIssues` hears each result; null means "not linted".
 * `getSource` names the config file in force, or null for the rules in Settings.
 */
export function lintSource(
  getConfig: () => object | null,
  onIssues: (issues: LintIssue[] | null) => void,
  getSource: () => string | null = () => null,
): (view: EditorView) => Promise<Diagnostic[]> {
  return async (view) => {
    const doc = view.state.doc;
    const config = getConfig();
    const source = getSource();
    if (!config || tooBig(doc)) {
      onIssues(null);
      return [];
    }
    const { lintText } = await loadLint();
    // The linter drops a result for old text anyway; this keeps it from the status bar too.
    if (view.state.doc !== doc) return [];
    let issues: LintIssue[];
    try {
      issues = lintText(doc.toString(), config);
    } catch (err) {
      console.error('Could not lint this document:', err);
      onIssues(null);
      return [];
    }
    onIssues(issues);
    return issues.map((issue) => {
      sourceOf.set(issue, source);
      const diagnostic: Diagnostic = { from: issue.from, to: issue.to, severity: 'warning', message: issue.message };
      issueOf.set(diagnostic, issue);
      return diagnostic;
    });
  };
}

function tooBig(doc: Text): boolean {
  // Each character is one to three bytes, so most documents need no encoding.
  if (doc.length > MAX_LINT_BYTES) return true;
  if (doc.length * 3 <= MAX_LINT_BYTES) return false;
  return new TextEncoder().encode(doc.toString()).length > MAX_LINT_BYTES;
}

const refreshLint = StateEffect.define<null>();

/** Lints `view` again now, as after a settings change; the linter itself only reacts to edits. */
export function relint(view: EditorView): void {
  view.dispatch({ effects: refreshLint.of(null) });
  forceLinting(view);
}

/**
 * Lints 400 ms after each edit: a wavy underline under each problem, its line number
 * marked, and a hover card with Fix and Turn off this rule.
 */
export function lintExtension(
  getConfig: () => object | null,
  onIssues: (issues: LintIssue[] | null) => void,
  getSource?: () => string | null,
): Extension {
  return [
    linter(lintSource(getConfig, onIssues, getSource), {
      delay: LINT_DELAY_MS,
      needsRefresh: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLint))),
      // null, not [], drops the linter's own tooltip; the card below replaces it.
      tooltipFilter: () => null as unknown as Diagnostic[],
    }),
    lintLines,
    // The card goes once the text or the problems change, so it never offers a stale fix.
    hoverTooltip((view, pos, side) => lintCard(view, pos, side), {
      hideOnChange: true,
      hideOn: (tr) => tr.effects.some((e) => e.is(setDiagnosticsEffect)),
    }),
  ];
}

const lintLineMarker = new (class extends GutterMarker {
  elementClass = 'cm-lintLine';
})();

// The line numbers of lines with a problem, as in the Main artboard.
const lintLines = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(lines, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiagnosticsEffect)) return markLines(tr.state, effect.value);
    }
    return tr.docChanged ? lines.map(tr.changes) : lines;
  },
  provide: (field) => gutterLineClass.from(field),
});

function markLines(state: EditorState, diagnostics: readonly Diagnostic[]): RangeSet<GutterMarker> {
  const starts = new Set(diagnostics.map((d) => state.doc.lineAt(Math.min(d.from, state.doc.length)).from));
  return RangeSet.of([...starts].sort((a, b) => a - b).map((start) => lintLineMarker.range(start)));
}

/** The issues under `pos` and the range they cover together, or null. */
export function issuesAt(
  state: EditorState,
  pos: number,
  side: -1 | 1,
): { from: number; to: number; issues: LintIssue[] } | null {
  const issues: LintIssue[] = [];
  let start = Infinity;
  let end = -Infinity;
  forEachDiagnostic(state, (diagnostic, from, to) => {
    // As the linter's own tooltip decides: an edge counts only on the side being hovered.
    const covers =
      pos >= from && pos <= to && (from === to || ((pos > from || side > 0) && (pos < to || side < 0)));
    const issue = issueOf.get(diagnostic);
    if (!covers || !issue) return;
    issues.push(issue);
    start = Math.min(start, from);
    end = Math.max(end, to);
  });
  return issues.length ? { from: start, to: end, issues } : null;
}

function lintCard(view: EditorView, pos: number, side: -1 | 1): Tooltip | null {
  const found = issuesAt(view.state, pos, side);
  if (!found) return null;
  return {
    pos: found.from,
    end: found.to,
    above: false,
    create: () => ({ dom: renderLintCard(found.issues, cardActions(view), sourceOf.get(found.issues[0]) ?? null) }),
  };
}

export interface CardActions {
  fix(issue: LintIssue): void;
  turnOff(issue: LintIssue): void;
}

/** What the card's buttons do in `view`. */
export function cardActions(view: EditorView): CardActions {
  return {
    // An issue exists only once markdownlint has loaded.
    fix: (issue) => loaded?.fixOne(view, issue),
    turnOff: (issue) => {
      disableRule(issue.alias).catch((err) =>
        message(`Could not turn off ${issue.rule}: ${err instanceof Error ? err.message : err}`, {
          title: 'Lintel',
          kind: 'error',
        }),
      );
    },
  };
}

/**
 * The hover card: for each issue, its rule, message, where the rule came from, Fix (when
 * fixable) and Turn off this rule. Turn off writes to Settings, so it is left out while a
 * config file sets the rules (`source`, Ruling 287).
 */
export function renderLintCard(issues: LintIssue[], actions: CardActions, source: string | null = null): HTMLElement {
  const card = element('div', 'cm-lintCard');
  for (const issue of issues) {
    const row = element('div', 'cm-lintCard-issue');
    row.append(
      element('strong', 'cm-lintCard-rule', `${issue.rule} ${issue.alias}`),
      element('p', 'cm-lintCard-message', issue.message),
      element('p', 'cm-lintCard-source', source === null ? 'Rule from Lintel settings' : `Rule set by ${source}`),
    );
    const buttons = element('div', 'cm-lintCard-actions');
    if (issue.fixable) buttons.append(button('Fix', 'cm-lintCard-fix', () => actions.fix(issue)));
    if (source === null) buttons.append(button('Turn off this rule', 'cm-lintCard-off', () => actions.turnOff(issue)));
    if (buttons.childElementCount > 0) row.append(buttons);
    card.append(row);
  }
  return card;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const el = element('button', className, label) as HTMLButtonElement;
  el.type = 'button';
  el.addEventListener('click', onClick);
  return el;
}
