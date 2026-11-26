import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import {
  cycleHeading,
  formattingKeymap,
  insertCodeBlock,
  insertLink,
  insertTable,
  openFindReplace,
  toggleBold,
  toggleBulletList,
  toggleItalic,
  toggleTaskList,
} from './commands';
import { editorExtensions } from './setup';

type Command = (view: EditorView) => boolean;

/** Runs `command` on `doc` with the selection from..to; returns text and selection after. */
function run(command: Command, doc: string, from = 0, to = doc.length) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
  const view = {
    get state() {
      return state;
    },
    dispatch: (...specs: Parameters<EditorView['dispatch']>) => {
      state = state.update(...(specs as [never])).state;
    },
  } as unknown as EditorView;
  const handled = command(view);
  const { from: selFrom, to: selTo } = state.selection.main;
  return { handled, text: state.doc.toString(), selected: state.sliceDoc(selFrom, selTo), state };
}

describe('toggleBold', () => {
  it('wraps the selection and unwraps it again', () => {
    expect(run(toggleBold, 'word').text).toBe('**word**');
    expect(run(toggleBold, '**word**').text).toBe('word');
  });

  it('unwraps when the markers sit just outside the selection', () => {
    expect(run(toggleBold, 'a **word** b', 4, 8).text).toBe('a word b');
  });

  it('puts the cursor between new markers when nothing is selected', () => {
    const { text, state } = run(toggleBold, 'ab', 1, 1);
    expect(text).toBe('a****b');
    expect(state.selection.main.head).toBe(3);
  });
});

describe('toggleItalic', () => {
  it('wraps and unwraps with one star', () => {
    expect(run(toggleItalic, 'word').text).toBe('*word*');
    expect(run(toggleItalic, '*word*').text).toBe('word');
  });

  it('adds italic to bold text instead of stripping the bold', () => {
    expect(run(toggleItalic, '**word**').text).toBe('***word***');
  });
});

describe('cycleHeading', () => {
  it('cycles none, #, ##, ### and back to none', () => {
    const seen = ['x'];
    for (let i = 0; i < 4; i++) seen.push(run(cycleHeading, seen[i], 1, 1).text);
    expect(seen).toEqual(['x', '# x', '## x', '### x', 'x']);
  });
});

describe('insertLink', () => {
  it('wraps the selection as link text and selects the url placeholder', () => {
    const { text, selected } = run(insertLink, 'docs');
    expect(text).toBe('[docs](url)');
    expect(selected).toBe('url');
  });
});

describe('list toggles', () => {
  it('turns each line into a task', () => {
    expect(run(toggleTaskList, 'a\nb').text).toBe('- [ ] a\n- [ ] b');
  });

  it('removes the task markers when every line has one', () => {
    expect(run(toggleTaskList, '- [ ] a\n- [x] b').text).toBe('a\nb');
  });

  it('bullets each line and removes the bullets again', () => {
    expect(run(toggleBulletList, 'a\nb').text).toBe('- a\n- b');
    expect(run(toggleBulletList, '- a\n- b').text).toBe('a\nb');
  });
});

describe('insertTable', () => {
  it('inserts a 2-column, 2-row table with the cursor in the first header cell', () => {
    const { text, state } = run(insertTable, '', 0, 0);
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toMatch(/^\|[^|]*\|[^|]*\|$/);
    expect(lines[1]).toMatch(/^\| -+ \| -+ \|$/);

    const { from, to } = state.selection.main;
    const firstPipe = text.indexOf('|');
    const secondPipe = text.indexOf('|', firstPipe + 1);
    expect(from).toBeGreaterThan(firstPipe);
    expect(to).toBeLessThan(secondPipe);
  });

  it('starts the table after a blank line when the cursor line has text', () => {
    const { text } = run(insertTable, 'intro', 5, 5);
    expect(text.startsWith('intro\n\n| ')).toBe(true);
  });
});

describe('insertCodeBlock', () => {
  it('fences the selected lines', () => {
    expect(run(insertCodeBlock, 'let a\nlet b').text).toBe('```\nlet a\nlet b\n```');
  });

  it('opens an empty block with the cursor inside', () => {
    const { text, state } = run(insertCodeBlock, '', 0, 0);
    expect(text).toBe('```\n\n```');
    expect(state.selection.main.head).toBe(4);
  });
});

describe('formattingKeymap', () => {
  it('binds exactly the nine keys, each to its command', () => {
    const bindings = Object.fromEntries(formattingKeymap.map((b) => [b.key, b.run]));
    expect(formattingKeymap).toHaveLength(9);
    expect(bindings).toEqual({
      'Mod-b': toggleBold,
      'Mod-i': toggleItalic,
      'Mod-k': insertLink,
      'Mod-Shift-h': cycleHeading,
      'Mod-Shift-8': toggleBulletList,
      'Mod-Shift-9': toggleTaskList,
      'Mod-Shift-t': insertTable,
      'Mod-Shift-c': insertCodeBlock,
      'Mod-Alt-f': openFindReplace,
    });
  });
});

describe('in a full editor', () => {
  let view: EditorView | undefined;

  function mountEditor(doc: string): EditorView {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, extensions: editorExtensions(() => {}) }),
    });
    return view;
  }

  afterEach(() => view?.destroy());

  // defaultKeymap binds Mod-i to selectParentSyntax; italic must win (Ruling 35).
  it('runs italic on Mod-i', () => {
    // Part of a paragraph, so selectParentSyntax would have something to select.
    const editor = mountEditor('say word now');
    editor.dispatch({ selection: { anchor: 4, head: 8 } });
    // jsdom is not a Mac, so Mod is Ctrl.
    const key = new KeyboardEvent('keydown', { key: 'i', keyCode: 73, ctrlKey: true });

    runScopeHandlers(editor, key, 'editor');

    expect(editor.state.doc.toString()).toBe('say *word* now');
  });

  it('opens find and replace with the replace field focused', () => {
    const editor = mountEditor('a b a');

    expect(openFindReplace(editor)).toBe(true);

    const replace = editor.dom.querySelector('.cm-search [name=replace]');
    expect(replace).not.toBeNull();
    expect(document.activeElement).toBe(replace);
  });
});
