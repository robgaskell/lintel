import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { history } from '@codemirror/commands';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState, type RangeSet } from '@codemirror/state';
import { EditorView, gutterLineClass, type GutterMarker } from '@codemirror/view';
import { disableRule } from './ruleSettings';
import type { LintIssue } from './lint';
import {
  issuesAt,
  lintExtension,
  lintSource,
  MAX_LINT_BYTES,
  relint,
  renderLintCard,
  cardActions,
} from './lintExtension';

vi.mock('./ruleSettings', () => ({ disableRule: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));

const TEXT = '# T\n\n- a\n* b\n';
const CONFIG = { default: true };

let view: EditorView | null = null;

beforeEach(() => vi.mocked(disableRule).mockClear());

afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

function editor(doc: string, extensions = lintExtension(() => CONFIG, () => {})): EditorView {
  view = new EditorView({ state: EditorState.create({ doc, extensions: [history(), extensions] }), parent: document.body });
  return view;
}

// Runs the lint source once and puts its diagnostics in the editor, as the linter does.
async function lintNow(v: EditorView, onIssues = vi.fn()): Promise<Diagnostic[]> {
  const diagnostics = await lintSource(() => CONFIG, onIssues)(v);
  v.dispatch(setDiagnostics(v.state, diagnostics));
  return diagnostics;
}

function issue(overrides: Partial<LintIssue> = {}): LintIssue {
  return {
    rule: 'MD004',
    alias: 'ul-style',
    line: 4,
    from: 9,
    to: 10,
    message: 'Unordered list style [Expected: dash; Actual: asterisk]',
    fixable: true,
    raw: {},
    ...overrides,
  };
}

describe('lintSource', () => {
  it('reports no problems while linting is off, and tells the status bar (success criterion)', async () => {
    const onIssues = vi.fn();

    expect(await lintSource(() => null, onIssues)(editor(TEXT))).toEqual([]);
    expect(onIssues).toHaveBeenCalledWith(null);
  });

  it('marks every problem as a warning over its range, and reports the issues (Ruling 272)', async () => {
    const onIssues = vi.fn();
    const diagnostics = await lintSource(() => CONFIG, onIssues)(editor(TEXT));

    expect(diagnostics.length).toBe(3);
    expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({ from: 9, to: 10 }));
    expect(onIssues.mock.calls[0][0].map((i: LintIssue) => i.rule).sort()).toEqual(['MD004', 'MD032', 'MD032']);
  });

  it('uses the config it is given each time', async () => {
    const diagnostics = await lintSource(() => ({ default: true, 'ul-style': false, MD032: false }), vi.fn())(editor(TEXT));

    expect(diagnostics).toEqual([]);
  });

  it('skips a document over 1,000,000 bytes (Ruling 268)', async () => {
    const onIssues = vi.fn();
    // Two bytes per character, so the size is in bytes, not characters.
    const big = `${'é'.repeat(MAX_LINT_BYTES / 2)}\n`;

    expect(await lintSource(() => CONFIG, onIssues)(editor(big))).toEqual([]);
    expect(onIssues).toHaveBeenCalledWith(null);
  });

  it('lints a document just under the limit', async () => {
    const onIssues = vi.fn();
    const text = `${'a'.repeat(MAX_LINT_BYTES - 10)}\n`;

    await lintSource(() => ({ default: false, MD047: true }), onIssues)(editor(text));

    expect(onIssues).toHaveBeenCalledWith([]);
  });

  it('drops a result for text that changed while it was linted', async () => {
    const onIssues = vi.fn();
    const v = editor(TEXT);
    const pending = lintSource(() => CONFIG, onIssues)(v);
    v.dispatch({ changes: { from: 0, insert: 'x' } });

    expect(await pending).toEqual([]);
    expect(onIssues).not.toHaveBeenCalled();
  });

  it('reports a config markdownlint rejects as no lint, not as a crash', async () => {
    const onIssues = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await lintSource(() => ({ default: true, MD043: { headings: 5 } }), onIssues)(editor(TEXT))).toEqual([]);

    expect(onIssues).toHaveBeenCalledWith(null);
    error.mockRestore();
  });
});

describe('relint', () => {
  it('lints at once after a settings change, though the editor is idle (Ruling 268)', async () => {
    vi.useFakeTimers();
    const getConfig = vi.fn(() => CONFIG);
    const v = editor(TEXT, lintExtension(getConfig, () => {}));
    await vi.advanceTimersByTimeAsync(400);
    expect(getConfig).toHaveBeenCalledTimes(1);

    relint(v);

    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('waits 400 ms after an edit before linting again', async () => {
    vi.useFakeTimers();
    const getConfig = vi.fn(() => CONFIG);
    const v = editor(TEXT, lintExtension(getConfig, () => {}));
    await vi.advanceTimersByTimeAsync(400);

    v.dispatch({ changes: { from: 0, insert: 'x' } });
    await vi.advanceTimersByTimeAsync(399);
    expect(getConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getConfig).toHaveBeenCalledTimes(2);
  });
});

describe('hover card (Ruling 273)', () => {
  it('shows the rule, the message, Fix and Turn off this rule', () => {
    const card = renderLintCard([issue()], { fix: vi.fn(), turnOff: vi.fn() });

    expect(card.querySelector('.cm-lintCard-rule')!.textContent).toBe('MD004 ul-style');
    expect(card.querySelector('.cm-lintCard-message')!.textContent).toBe(
      'Unordered list style [Expected: dash; Actual: asterisk]',
    );
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Fix', 'Turn off this rule']);
  });

  it('has no Fix button for an issue markdownlint cannot fix', () => {
    const card = renderLintCard([issue({ fixable: false })], { fix: vi.fn(), turnOff: vi.fn() });

    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Turn off this rule']);
  });

  it('runs the action for the issue whose button was pressed', () => {
    const first = issue();
    const second = issue({ rule: 'MD032', alias: 'blanks-around-lists' });
    const actions = { fix: vi.fn(), turnOff: vi.fn() };
    const card = renderLintCard([first, second], actions);
    const buttons = card.querySelectorAll('button');

    buttons[0].click();
    buttons[3].click();

    expect(actions.fix).toHaveBeenCalledWith(first);
    expect(actions.turnOff).toHaveBeenCalledWith(second);
  });

  it('treats markdownlint text as text, not markup', () => {
    const card = renderLintCard([issue({ message: '<img src=x onerror=alert(1)>' })], { fix: vi.fn(), turnOff: vi.fn() });

    expect(card.querySelector('img')).toBeNull();
  });

  it('lists every issue at a position with several', async () => {
    const v = editor(TEXT);
    await lintNow(v);

    const found = issuesAt(v.state, 9, 1);

    expect(found?.issues.map((i) => i.rule).sort()).toEqual(['MD004', 'MD032']);
    expect([found?.from, found?.to]).toEqual([9, 12]);
    expect(issuesAt(v.state, 1, 1)).toBeNull();
  });

  it('Fix corrects the issue in the editor', async () => {
    const v = editor(TEXT);
    await lintNow(v);
    const md004 = issuesAt(v.state, 9, 1)!.issues.find((i) => i.rule === 'MD004')!;

    cardActions(v).fix(md004);

    expect(v.state.doc.toString()).toBe('# T\n\n- a\n- b\n');
  });

  it('Turn off this rule writes its alias to the settings', async () => {
    const v = editor(TEXT);

    cardActions(v).turnOff(issue());

    expect(disableRule).toHaveBeenCalledWith('ul-style');
  });
});

describe('gutter marker', () => {
  function markedLines(state: EditorState): number[] {
    const lines: number[] = [];
    for (const set of state.facet(gutterLineClass) as readonly RangeSet<GutterMarker>[]) {
      set.between(0, state.doc.length, (from, _to, marker) => {
        if (marker.elementClass.includes('cm-lintLine')) lines.push(state.doc.lineAt(from).number);
      });
    }
    return lines;
  }

  it('marks the line number of each line with a problem', async () => {
    const v = editor(TEXT);

    await lintNow(v);

    expect(markedLines(v.state)).toEqual([3, 4]);
  });

  it('moves the marks with edits and clears them with the problems', async () => {
    const v = editor(TEXT);
    await lintNow(v);

    v.dispatch({ changes: { from: 0, insert: '\n' } });
    expect(markedLines(v.state)).toEqual([4, 5]);

    v.dispatch(setDiagnostics(v.state, []));
    expect(markedLines(v.state)).toEqual([]);
  });
});
