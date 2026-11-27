import { afterEach, describe, expect, it } from 'vitest';

// CodeMirror reads the platform when it loads, so fake a Mac before importing it.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
const { EditorState, Prec } = await import('@codemirror/state');
const { EditorView, runScopeHandlers } = await import('@codemirror/view');
const { undo } = await import('@codemirror/commands');
const { editorExtensions, lockCompartment, lockExtension } = await import('./setup');
const { eventFor, selectionHistoryKeys } = await import('../../test/lockKeys');

type View = InstanceType<typeof EditorView>;
type State = import('@codemirror/state').EditorState;
type Selection = { anchor: number; head?: number };

const DOCS: [string, Selection][] = [
  ['hello', { anchor: 0, head: 5 }],
  ['- item', { anchor: 6 }],
  ['ab\ncd', { anchor: 1 }],
];

let heard: string[] = [];
const spy = Prec.high(EditorView.domEventHandlers({ keydown: (event) => (heard.push(event.key), false) }));

const views: View[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

/** `doc` with an "X" typed, that typing undone if `undone`, and locked if `locked`. */
function prepared(doc: string, selection: Selection, undone: boolean, locked: boolean): State {
  let state = EditorState.create({ doc, selection, extensions: [editorExtensions(() => {}), spy] });
  state = state.update({ changes: { from: 0, insert: 'X' }, userEvent: 'input' }).state;
  if (undone) undo({ state, dispatch: (tr) => (state = tr.state) });
  if (locked) state = state.update({ effects: lockCompartment.reconfigure(lockExtension(true)) }).state;
  return state;
}

/** Runs `act` on each doc, both history variants, and returns the paths that edited. */
function edits(name: string, act: (view: View) => void, locked = true): string[] {
  const view = new EditorView({ parent: document.body });
  views.push(view);
  const edited: string[] = [];
  for (const undone of [false, true]) {
    for (const [doc, selection] of DOCS) {
      view.setState(prepared(doc, selection, undone, locked));
      view.focus();
      const before = view.state.doc.toString();
      act(view);
      if (view.state.doc.toString() !== before) edited.push(`${name} [${doc}${undone ? ', undone' : ''}]`);
    }
  }
  return edited;
}

const key = (init: KeyboardEventInit) => (view: View) =>
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

describe('the editor lock on a Mac (Ruling 354)', () => {
  // Through CodeMirror's keyCode fallback these ran selection undo and redo, and insert
  // code block, before the lock checked the keyCode and Shift.
  it('swallows Cmd+c and Cmd+Shift+G whose keyCode is U, and Caps Lock Cmd+Shift+c', () => {
    const odd: [string, KeyboardEventInit][] = [
      ['Cmd+c with the keyCode of U', { key: 'c', keyCode: 85, metaKey: true }],
      ['Cmd+Shift+G with the keyCode of U', { key: 'G', keyCode: 85, metaKey: true, shiftKey: true }],
      ['Caps Lock Cmd+Shift+c', { key: 'c', keyCode: 67, metaKey: true, shiftKey: true }],
    ];
    heard = [];
    const edited = odd.flatMap(([name, init]) => edits(name, key(init)));
    expect(heard).toEqual([]);
    expect(edited).toEqual([]);
  });

  it('binds every selection undo and redo key to nothing', () => {
    const run = (name: string) => (v: View) =>
      runScopeHandlers(v, new KeyboardEvent('keydown', eventFor(name, true)), 'editor');
    const names = selectionHistoryKeys(new EditorView({ state: prepared('', { anchor: 0 }, false, false) }));
    expect(names.flatMap((name) => edits(name, run(name), false))).not.toEqual([]);
    expect(names.flatMap((name) => edits(name, run(name)))).toEqual([]);
  });
});
