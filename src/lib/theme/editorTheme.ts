import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

// Every colour is a CSS variable, so a theme change restyles open editors with no
// reconfigure. The view keeps CodeMirror's light base styles, so each rule the base sets
// per light/dark (selection, panels, buttons, fields, tooltips, matches) is set here.
const view = EditorView.theme({
  '&': { height: '100%', color: 'var(--editor-text)', backgroundColor: 'var(--editor-bg)' },
  '&.cm-focused': { outline: 'none' },
  // Font and size come from the font compartment in setup.ts.
  '.cm-scroller': {
    lineHeight: '1.7',
    colorScheme: 'var(--scheme)',
  },
  '.cm-content': { padding: '18px 0', caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { backgroundColor: 'var(--selection-unfocused)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--selection)' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '30px', padding: '0 14px 0 8px' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--editor-text)' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-current)' },
  '.cm-panels': { backgroundColor: 'var(--chrome)', color: 'var(--text)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-textfield': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
  },
  '.cm-textfield:focus': { outline: '2px solid var(--accent)', outlineOffset: '-1px' },
  '.cm-button': {
    backgroundColor: 'var(--bg)',
    backgroundImage: 'none',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
  },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--toolbar-hover)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
  '.cm-tooltip-section:not(:first-child)': { borderTop: '1px solid var(--border)' },
});

// Markdown marks are muted and headings bold, as in the Main artboard; code inside fences
// uses the preview's code colours.
const highlight = HighlightStyle.define([
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--muted)' },
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--link)' },
  { tag: t.monospace, color: 'var(--editor-code)' },
  { tag: t.quote, color: 'var(--preview-quote-text)' },
  {
    tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.modifier, t.bool, t.null, t.atom, t.typeName],
    color: 'var(--preview-code-keyword)',
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: 'var(--preview-code-string)' },
  {
    tag: [t.number, t.className, t.function(t.variableName), t.definition(t.variableName), t.propertyName, t.attributeName, t.labelName],
    color: 'var(--preview-code-title)',
  },
  { tag: t.comment, color: 'var(--preview-code-comment)' },
  { tag: [t.invalid, t.deleted], color: 'var(--lint-warning)' },
]);

/** The editor's look, from the theme variables (Ruling 130). */
export const editorTheme: Extension = [view, syntaxHighlighting(highlight)];
