import { afterEach, describe, expect, it } from 'vitest';
import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { applyFixes, type LintError } from 'markdownlint';
import { changesBetween, fixAll, fixOne, lintText, type LintIssue } from './lint';

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

  it('leaves a cursor before the first fix where it was', () => {
    const v = editor(TEXT);
    v.dispatch({ selection: { anchor: 2 } });

    fixAll(v, lintText(TEXT, { default: true }));

    expect(v.state.selection.main.head).toBe(2);
  });

  it('keeps a cursor between two fixes on its text (Ruling 279)', () => {
    const text = '# T\n\n- a\n* b\n* c\n';
    const v = editor(text);
    v.dispatch({ selection: { anchor: 11 } });

    fixAll(v, lintText(text, { default: true }));

    expect(v.state.doc.toString()).toBe('# T\n\n- a\n- b\n- c\n');
    expect(v.state.doc.sliceString(v.state.selection.main.head, v.state.selection.main.head + 3)).toBe('b\n-');
    undo(v);
    expect(v.state.doc.toString()).toBe(text);
  });

  it("gives markdownlint's own result where fixes add and remove lines", () => {
    const text = '# T\nSome text  \n\n\n\n* a\n+ b\n## H\ntext';
    const issues = lintText(text, { default: true });
    const v = editor(text);

    fixAll(v, issues);

    expect(v.state.doc.toString()).toBe(applyFixes(text, issues.map((i) => i.raw as LintError)));
  });

  it('on a result from before an edit, lints the text now and fixes that (Ruling 281)', () => {
    const v = editor(TEXT);
    const issues = lintText(TEXT, { default: true });
    v.dispatch({ changes: { from: v.state.doc.length, insert: '* c\n' } });

    fixAll(v, issues, { default: true });

    expect(v.state.doc.toString()).toBe('# T\n\n- a\n- b\n- c\n');
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

describe('changesBetween', () => {
  // Seeded, so a failure repeats.
  function random(seed: number): () => number {
    return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  }

  it('turns one text into the other with a change per differing region, for any edits', () => {
    const next = random(7);
    const words = ['a', 'b', '- x', '* y', '', '  ', '# H'];
    for (let round = 0; round < 300; round++) {
      const lines = Array.from({ length: 1 + Math.floor(next() * 12) }, () => words[Math.floor(next() * words.length)]);
      const edited = lines.flatMap((line) => {
        const roll = next();
        if (roll < 0.1) return [];
        if (roll < 0.2) return [line, words[Math.floor(next() * words.length)]];
        if (roll < 0.3) return [`${line}z`];
        return [line];
      });
      const before = lines.join('\n');
      const after = edited.join('\n');

      const changes = changesBetween(before, after);

      let out = before;
      for (const change of [...changes].reverse()) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
      expect(out, JSON.stringify({ before, after })).toBe(after);
      for (let i = 1; i < changes.length; i++) expect(changes[i].from).toBeGreaterThan(changes[i - 1].to);
    }
  });

  it('past 500 line edits, still gives one change per changed line when no lines come or go', () => {
    const before = Array.from({ length: 600 }, (_, i) => `* ${i}`).join('\n');
    const after = before.replaceAll('* ', '- ');

    const changes = changesBetween(before, after);

    expect(changes).toHaveLength(600);
    expect(changes[1]).toEqual({ from: 4, to: 5, insert: '-' });
  });

  it('past 500 line edits with lines added, gives one correct change', () => {
    const before = Array.from({ length: 600 }, (_, i) => `* ${i}`).join('\n');
    const after = before.replaceAll('* ', '\n- ');

    const [change, ...rest] = changesBetween(before, after);

    expect(rest).toEqual([]);
    expect(before.slice(0, change.from) + change.insert + before.slice(change.to)).toBe(after);
  });

  it('keeps edits apart when a line is added between them', () => {
    expect(changesBetween('a\nb\nc\nd\ne', 'a\n\nb\nc\nd\nE')).toEqual([
      { from: 2, to: 2, insert: '\n' },
      { from: 8, to: 9, insert: 'E' },
    ]);
  });

  it('leaves text between two edits out of every change', () => {
    expect(changesBetween('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')).toEqual([
      { from: 0, to: 1, insert: 'A' },
      { from: 8, to: 9, insert: 'E' },
    ]);
  });
});
