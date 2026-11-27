import { afterEach, describe, expect, it } from 'vitest';
import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { fixAll, fixOne, lintText, type LintIssue } from './lint';

const TEXT = '# T\n\n- a\n* b\n';

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function editor(doc: string): EditorView {
  view = new EditorView({ state: EditorState.create({ doc, extensions: [history()] }), parent: document.body });
  return view;
}

function md004(issues: LintIssue[]): LintIssue {
  const issue = issues.find((i) => i.rule === 'MD004');
  if (!issue) throw new Error('no MD004');
  return issue;
}

describe('lintText', () => {
  it('reports MD004 on line 4 as fixable (success criterion)', () => {
    expect(lintText(TEXT, { default: true })).toContainEqual(
      expect.objectContaining({ rule: 'MD004', alias: 'ul-style', line: 4, fixable: true }),
    );
  });

  it("maps markdownlint's line and column range to document offsets", () => {
    const issue = md004(lintText(TEXT, { default: true }));

    expect([issue.from, issue.to]).toEqual([9, 10]);
    expect(TEXT.slice(issue.from, issue.to)).toBe('*');
  });

  it('covers the whole line when markdownlint gives no column range', () => {
    const md032 = lintText(TEXT, { default: true }).filter((i) => i.rule === 'MD032');

    expect(md032.map((i) => TEXT.slice(i.from, i.to))).toEqual(['- a', '* b']);
  });

  it('puts an issue on an empty line at its start, with no width', () => {
    const text = 'a\n\n\n\nb\n';
    const issue = lintText(text, { default: true }).find((i) => i.rule === 'MD012');

    expect(issue).toMatchObject({ line: 3, from: 3, to: 3 });
  });

  it('counts lines split by CRLF as markdownlint does', () => {
    const issue = md004(lintText(TEXT.replaceAll('\n', '\r\n'), { default: true }));

    expect([issue.line, issue.from, issue.to]).toEqual([4, 12, 13]);
  });

  it("gives the rule's description plus markdownlint's detail as the message", () => {
    expect(md004(lintText(TEXT, { default: true })).message).toBe(
      'Unordered list style [Expected: dash; Actual: asterisk]',
    );
  });

  it('leaves out a rule turned off by ID or alias (success criterion)', () => {
    expect(lintText(TEXT, { default: true, MD004: false }).some((i) => i.rule === 'MD004')).toBe(false);
    expect(lintText(TEXT, { default: true, 'ul-style': false }).some((i) => i.rule === 'MD004')).toBe(false);
  });
});

describe('fixAll', () => {
  it('fixes every fixable issue, and one undo restores the original (success criterion)', () => {
    const v = editor(TEXT);

    fixAll(v, lintText(TEXT, { default: true }));

    expect(v.state.doc.toString()).toBe('# T\n\n- a\n- b\n');
    undo(v);
    expect(v.state.doc.toString()).toBe(TEXT);
  });

  it('is its own undo step, even straight after typing (Ruling 267)', () => {
    // Typing the "*" that the fix then replaces: history would join the two.
    const v = editor('# T\n\n- a\n b\n');
    v.dispatch({ changes: { from: 9, insert: '*' }, userEvent: 'input.type' });
    const text = v.state.doc.toString();
    expect(text).toBe(TEXT);

    fixAll(v, lintText(text, { default: true }));
    undo(v);

    expect(v.state.doc.toString()).toBe(text);
  });

  it('changes only the text that differs, so the cursor stays put', () => {
    const v = editor(TEXT);
    v.dispatch({ selection: { anchor: 2 } });

    fixAll(v, lintText(TEXT, { default: true }));

    expect(v.state.selection.main.head).toBe(2);
  });

  it('does nothing once the document has changed since it was linted', () => {
    const v = editor(TEXT);
    const issues = lintText(TEXT, { default: true });
    v.dispatch({ changes: { from: 0, insert: 'x' } });

    fixAll(v, issues);

    expect(v.state.doc.toString()).toBe(`x${TEXT}`);
  });
});

describe('fixOne', () => {
  it('fixes only the issue it is given, as one undo step', () => {
    const text = '# T\n\n- a\n* b\n+ c\n';
    const v = editor(text);
    const issues = lintText(text, { default: true }).filter((i) => i.rule === 'MD004');
    expect(issues).toHaveLength(2);

    fixOne(v, issues[0]);

    expect(v.state.doc.toString()).toBe('# T\n\n- a\n- b\n+ c\n');
    undo(v);
    expect(v.state.doc.toString()).toBe(text);
  });
});
