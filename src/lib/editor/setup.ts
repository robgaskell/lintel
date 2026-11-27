import { minimalSetup } from 'codemirror';
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { search, searchKeymap } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { settings, type Settings } from '../settings/settings.svelte';
import { editorFont } from '../theme/theme';
import { editorTheme } from '../theme/editorTheme';
import { formattingKeymap } from './commands';

/**
 * Holds the editor font and size. Reconfiguring it makes CodeMirror re-measure every line;
 * a CSS variable change alone left the gutter out of step with wrapped rows (Ruling 170).
 */
export const fontCompartment = new Compartment();

export function fontTheme(s: Pick<Settings, 'editorFont' | 'fontSize'>): Extension {
  const { family, size } = editorFont(s);
  return EditorView.theme({ '.cm-scroller': { fontFamily: family, fontSize: size } });
}

/** Locks the editor while an update installs (Rulings 349, 353). */
export const lockCompartment = new Compartment();
const lock = { on: false };

/** Marks a change a locked editor still takes: the file's own text, read from disk. */
export const lockExempt = Annotation.define<boolean>();

/**
 * While locked, keys (except moving and copying), typed input, paste, cut and drop are
 * swallowed before any other handler, and the change filter drops changes not marked
 * lockExempt. History changes skip that filter, so history is blocked at its keys; selection
 * undo and redo, which ignore read-only, have their keys bound to nothing here.
 */
export function lockExtension(locked: boolean): Extension {
  if (!locked) return [];
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event) => swallow(event, movesOrCopies(event)),
        paste: (event) => swallow(event),
        cut: (event) => swallow(event),
        drop: (event) => swallow(event),
        beforeinput: (event) => swallow(event),
      }),
    ),
    Prec.highest(keymap.of(SELECTION_HISTORY_KEYS.map((key) => ({ key, run: () => true })))),
    EditorState.transactionFilter.of((tr) => (tr.docChanged && !tr.annotation(lockExempt) ? [] : tr)),
  ];
}

// historyKeymap's undoSelection and redoSelection keys, on every platform.
const SELECTION_HISTORY_KEYS = ['Mod-u', 'Alt-u', 'Mod-Shift-u'];

const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const LONE_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'Escape']);
// With Cmd or Ctrl: copy, select all, find, find next; with Shift too, find previous.
const COPY_KEYS = new Set(['c', 'a', 'f', 'g', 'G']);

// Alt with an arrow moves or copies lines, so it is not a plain move.
function movesOrCopies(event: KeyboardEvent): boolean {
  if (LONE_MODIFIERS.has(event.key)) return true;
  if (MOVE_KEYS.has(event.key)) return !event.altKey;
  const mod = event.metaKey || event.ctrlKey;
  return mod && !event.altKey && COPY_KEYS.has(event.key) && copyKeyIsWhatItSays(event);
}

// CodeMirror also looks a key up by its keyCode, so a 'c' with U's keyCode runs Mod-u.
// Shift is for find previous only: Caps Lock turns Mod-Shift-c (code block) into 'c'.
function copyKeyIsWhatItSays(event: KeyboardEvent): boolean {
  const letter = event.key.toLowerCase();
  if (event.keyCode !== letter.toUpperCase().charCodeAt(0)) return false;
  return !event.shiftKey || letter === 'g';
}

function swallow(event: Event, allowed = false): boolean {
  if (allowed) return false;
  event.preventDefault();
  return true;
}

/** Whether editors made from now on start read-only. views.ts locks the open ones. */
export function setNewEditorsLocked(locked: boolean): void {
  lock.on = locked;
}

/** Extensions for one markdown editor; `onChange` gets the full text after each edit. */
export function editorExtensions(onChange: (text: string) => void): Extension[] {
  return [
    // History, its keymap and the default keymap; editorTheme replaces its highlighting.
    minimalSetup,
    // Above minimalSetup, whose Mod-i (select parent syntax) would otherwise beat italic.
    Prec.high(keymap.of(formattingKeymap)),
    search(),
    keymap.of(searchKeymap),
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
    editorTheme,
    fontCompartment.of(fontTheme(settings)),
    lockCompartment.of(lockExtension(lock.on)),
  ];
}
