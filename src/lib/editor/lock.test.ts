import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, type KeyBinding } from '@codemirror/view';
import { defaultKeymap, historyKeymap, redo, redoSelection, undo, undoSelection } from '@codemirror/commands';
import { markdownKeymap } from '@codemirror/lang-markdown';
import {
  openSearchPanel,
  replaceAll,
  replaceNext,
  searchKeymap,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import * as commands from './commands';
import { editorExtensions, lockCompartment, lockExempt, lockExtension } from './setup';
import { registerView, setEditorsLocked } from './views';
import { fixAll, fixOne, lintText } from '../lint/lint';

// Every editing path a 922-path probe found (verifier, Ruling 353), on a locked editor.

type Selection = { anchor: number; head?: number };

const DOCS: [string, string, Selection][] = [
  ['sel-all', 'hello', { anchor: 0, head: 5 }],
  ['list-end', '- item', { anchor: 6 }],
  ['empty-item', '- ', { anchor: 2 }],
  ['quote-end', '> quote', { anchor: 7 }],
  ['mid', 'ab\ncd', { anchor: 1 }],
  ['url-sel', 'see site here', { anchor: 4, head: 8 }],
];

// keyCode too: CodeMirror reads it to name a shifted or Alt letter.
const KEYS: [string, KeyboardEventInit][] = [
  ['Ctrl+B', { key: 'b', keyCode: 66, ctrlKey: true }],
  ['Meta+B', { key: 'b', keyCode: 66, metaKey: true }],
  ['Ctrl+I', { key: 'i', keyCode: 73, ctrlKey: true }],
  ['Ctrl+K', { key: 'k', keyCode: 75, ctrlKey: true }],
  ['Ctrl+Shift+H', { key: 'H', keyCode: 72, ctrlKey: true, shiftKey: true }],
  ['Ctrl+Shift+8', { key: '*', keyCode: 56, ctrlKey: true, shiftKey: true }],
  ['Ctrl+Shift+9', { key: '(', keyCode: 57, ctrlKey: true, shiftKey: true }],
  ['Ctrl+Shift+T', { key: 'T', keyCode: 84, ctrlKey: true, shiftKey: true }],
  ['Ctrl+Shift+C', { key: 'C', keyCode: 67, ctrlKey: true, shiftKey: true }],
  ['Enter', { key: 'Enter', keyCode: 13 }],
  ['Backspace', { key: 'Backspace', keyCode: 8 }],
  ['Delete', { key: 'Delete', keyCode: 46 }],
  ['Tab', { key: 'Tab', keyCode: 9 }],
  ['Ctrl+Z', { key: 'z', keyCode: 90, ctrlKey: true }],
  ['Ctrl+Shift+Z', { key: 'Z', keyCode: 90, ctrlKey: true, shiftKey: true }],
  ['Ctrl+Y', { key: 'y', keyCode: 89, ctrlKey: true }],
  ['Meta+Z', { key: 'z', keyCode: 90, metaKey: true }],
  ['Alt+ArrowUp', { key: 'ArrowUp', keyCode: 38, altKey: true }],
  ['Shift+Alt+ArrowDown', { key: 'ArrowDown', keyCode: 40, altKey: true, shiftKey: true }],
  ['Ctrl+]', { key: ']', keyCode: 221, ctrlKey: true }],
  ['Ctrl+/', { key: '/', keyCode: 191, ctrlKey: true }],
  ['Ctrl+Shift+K', { key: 'K', keyCode: 75, ctrlKey: true, shiftKey: true }],
  ['Ctrl+Enter', { key: 'Enter', keyCode: 13, ctrlKey: true }],
  ['Ctrl+T', { key: 't', keyCode: 84, ctrlKey: true }],
  ['Ctrl+O', { key: 'o', keyCode: 79, ctrlKey: true }],
  ['Ctrl+D', { key: 'd', keyCode: 68, ctrlKey: true }],
  ['Ctrl+U', { key: 'u', keyCode: 85, ctrlKey: true }],
  ['Meta+U', { key: 'u', keyCode: 85, metaKey: true }],
  ['Alt+U', { key: 'u', keyCode: 85, altKey: true }],
  ['Meta+Shift+U', { key: 'U', keyCode: 85, metaKey: true, shiftKey: true }],
];

const open: (() => void)[] = [];

afterEach(() => {
  setEditorsLocked(false);
  for (const done of open.splice(0)) done();
});

/** A live, focused editor, registered so setEditorsLocked reaches it. */
function editor(doc: string, selection: Selection): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: editorExtensions(() => {}), selection }),
  });
  const forget = registerView(`lock-${open.length}`, view);
  open.push(() => {
    forget();
    view.destroy();
  });
  view.focus();
  return view;
}

/**
 * `doc` with history to undo and redo: an "X" typed, and with `undone` that typing undone.
 * Locked through the same compartment setEditorsLocked uses, unless `locked` is false.
 */
// States are immutable, so each is made once and shared by every path.
const made = new Map<string, EditorState>();

function prepared(doc: string, selection: Selection, undone: boolean, locked: boolean): EditorState {
  const id = JSON.stringify([doc, selection, undone, locked]);
  let ready = made.get(id);
  if (!ready) made.set(id, (ready = make(doc, selection, undone, locked)));
  return ready;
}

function make(doc: string, selection: Selection, undone: boolean, locked: boolean): EditorState {
  let state = EditorState.create({ doc, extensions: editorExtensions(() => {}), selection });
  state = state.update({ changes: { from: 0, insert: 'X' }, userEvent: 'input' }).state;
  if (undone) undo({ state, dispatch: (tr) => (state = tr.state) });
  if (locked) state = state.update({ effects: lockCompartment.reconfigure(lockExtension(true)) }).state;
  return state;
}

const key = (view: EditorView, init: KeyboardEventInit) =>
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

function paste(view: EditorView, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : ''), files: [], types: ['text/plain'] },
  });
  view.contentDOM.dispatchEvent(event);
}

/** Runs `act` on each doc, both history variants, and returns the paths that edited. */
function edits(name: string, act: (view: EditorView) => void, locked = true): string[] {
  // One editor, given each state in turn: thousands of editors would slow jsdom down.
  const view = editor('', { anchor: 0 });
  const edited: string[] = [];
  for (const undone of [false, true]) {
    for (const [docName, doc, selection] of DOCS) {
      view.setState(prepared(doc, selection, undone, locked));
      const before = view.state.doc.toString();
      act(view);
      if (view.state.doc.toString() !== before) edited.push(`${name} [${docName}${undone ? ', undone' : ''}]`);
    }
  }
  open.pop()?.();
  return edited;
}

describe('the editor lock (Rulings 349, 353)', () => {
  it('stops the four paths that got past it before: Enter, Backspace, Mod-U and Alt-U, URL paste', () => {
    const paths: [string, (view: EditorView) => void][] = [
      ['Enter continuing list markup', (v) => key(v, { key: 'Enter', keyCode: 13 })],
      ['Backspace on an empty item', (v) => key(v, { key: 'Backspace', keyCode: 8 })],
      ['Ctrl+U', (v) => key(v, { key: 'u', keyCode: 85, ctrlKey: true })],
      ['Alt+U', (v) => key(v, { key: 'u', keyCode: 85, altKey: true })],
      ['URL paste', (v) => paste(v, 'https://example.com')],
    ];
    for (const [name, act] of paths) {
      expect(edits(name, act, false), `${name} edits when unlocked`).not.toEqual([]);
      expect(edits(name, act)).toEqual([]);
    }
  });

  it('refuses every command, keymap binding and key the probe found', () => {
    const edited: string[] = [];
    for (const [name, command] of Object.entries(commands)) {
      if (typeof command === 'function') edited.push(...edits(`commands.${name}`, (v) => command(v)));
    }
    const maps: [string, readonly KeyBinding[]][] = [
      ['formatting', commands.formattingKeymap],
      ['default', defaultKeymap],
      ['history', historyKeymap],
      ['search', searchKeymap],
      ['markdown', markdownKeymap],
    ];
    for (const [mapName, bindings] of maps) {
      for (const binding of bindings) {
        for (const run of [binding.run, binding.shift]) {
          // CodeMirror's selection undo ignores read-only and filters when called directly;
          // Lintel runs it only from Mod-U and Alt-U, which the lock swallows (tested above).
          if (!run || run === undoSelection || run === redoSelection) continue;
          edited.push(...edits(`${mapName} ${binding.key ?? binding.mac}`, (v) => run(v)));
        }
      }
    }
    for (const [name, init] of KEYS) edited.push(...edits(`key ${name}`, (v) => key(v, init)));
    expect(edited).toEqual([]);
    // About 1,500 paths: 1.5 s here, longer on CI's Windows runner.
  }, 60_000);

  it('refuses paste, cut, drop, typed input, undo, redo, find and replace, and lint fixes', () => {
    const edited: string[] = [];
    for (const text of ['PASTED', 'https://example.com']) edited.push(...edits(`paste ${text}`, (v) => paste(v, text)));
    const fire = (type: string, prop: string, value: unknown) => (v: EditorView) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, prop, { value });
      v.contentDOM.dispatchEvent(event);
    };
    edited.push(...edits('cut', fire('cut', 'clipboardData', { setData() {}, clearData() {}, getData: () => '' })));
    edited.push(...edits('drop', fire('drop', 'dataTransfer', { getData: () => 'DROPPED', files: [], types: ['text/plain'] })));
    edited.push(...edits('beforeinput', fire('beforeinput', 'inputType', 'insertText')));
    edited.push(...edits('undo', (v) => undo(v)));
    edited.push(...edits('redo', (v) => redo(v)));
    edited.push(
      ...edits('find and replace', (v) => {
        openSearchPanel(v);
        v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'e', replace: 'Q' })) });
        replaceNext(v);
        replaceAll(v);
      }),
    );
    const text = '# T\n\n- a\n* b\n+ c\n';
    const view = editor(text, { anchor: 0 });
    setEditorsLocked(true);
    const issues = lintText(view.state.doc.toString(), { default: true });
    fixAll(view, issues);
    for (const issue of issues) fixOne(view, issue);
    if (view.state.doc.toString() !== text) edited.push('lint fixes');
    expect(edited).toEqual([]);
  });

  it('lets no other handler see a key, paste, drop or typed input, but moving and copying', () => {
    const heard: string[] = [];
    const spy = (event: Event) => {
      heard.push(event instanceof KeyboardEvent ? event.key : event.type);
      return false;
    };
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: '- item',
        selection: { anchor: 6 },
        extensions: [
          editorExtensions(() => {}),
          Prec.high(EditorView.domEventHandlers({ keydown: spy, paste: spy, drop: spy, beforeinput: spy })),
        ],
      }),
    });
    const forget = registerView('lock-spy', view);
    open.push(() => {
      forget();
      view.destroy();
    });
    view.focus();
    setEditorsLocked(true);

    for (const [, init] of KEYS) key(view, init);
    paste(view, 'https://example.com');
    for (const type of ['drop', 'beforeinput']) view.contentDOM.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    expect(heard).toEqual([]);

    key(view, { key: 'ArrowLeft', keyCode: 37 });
    key(view, { key: 'c', keyCode: 67, ctrlKey: true });
    expect(heard).toEqual(['ArrowLeft', 'c']);
  });

  it('still moves the cursor, and takes the file’s own text from disk', () => {
    const view = editor('ab\ncd', { anchor: 1 });
    setEditorsLocked(true);
    key(view, { key: 'ArrowDown', keyCode: 40 });
    expect(view.state.selection.main.head).toBeGreaterThan(3);

    view.dispatch({ changes: { from: 0, insert: 'disk ' }, annotations: lockExempt.of(true) });
    expect(view.state.doc.toString()).toBe('disk ab\ncd');
  });
});
