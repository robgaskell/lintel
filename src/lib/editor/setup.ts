import { minimalSetup } from 'codemirror';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
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

/** Makes the editor read-only while an update installs (Ruling 349). */
export const lockCompartment = new Compartment();
const lock = { on: false };

export function lockExtension(locked: boolean): Extension {
  return locked ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
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
