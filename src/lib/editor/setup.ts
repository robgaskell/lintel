import { minimalSetup } from 'codemirror';
import { Prec, type Extension } from '@codemirror/state';
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
import { editorTheme } from '../theme/editorTheme';
import { formattingKeymap } from './commands';

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
  ];
}
