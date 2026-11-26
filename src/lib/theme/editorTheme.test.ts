import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorExtensions } from '../editor/setup';

let view: EditorView | null = null;
const root = document.documentElement;

// Distinct values, so each computed colour names the token that produced it.
const TOKENS: Record<string, string> = {
  '--bg': '#010101',
  '--text': '#020202',
  '--accent': '#030303',
  '--link': '#040404',
  '--border': '#050505',
  '--chrome': '#060606',
  '--muted': '#070707',
  '--selection': '#080808',
  '--selection-unfocused': '#090909',
  '--search-match': '#0a0a0a',
  '--search-match-current': '#0b0b0b',
  '--preview-code-comment': '#0c0c0c',
  '--active-line': '#0d0d0d',
  '--editor-bg': 'var(--bg)',
  '--editor-text': 'var(--text)',
};

function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

beforeEach(() => {
  for (const [name, value] of Object.entries(TOKENS)) root.style.setProperty(name, value);
});

afterEach(() => {
  view?.destroy();
  view = null;
  root.removeAttribute('style');
});

function mount(doc: string): EditorView {
  view = new EditorView({ state: EditorState.create({ doc, extensions: editorExtensions(() => {}) }), parent: document.body });
  return view;
}

/** An element with these classes inside the editor, as CodeMirror's panels and widgets make them. */
function inside(v: EditorView, tag: string, className: string, parent: Element = v.dom): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  parent.append(el);
  return el;
}

function spanWithText(v: EditorView, text: string): HTMLElement {
  const span = [...v.contentDOM.querySelectorAll('span')].find((s) => s.textContent === text);
  if (!span) throw new Error(`no span "${text}"`);
  return span;
}

// jsdom cascades sheets and resolves var(), so these show which rule wins over
// CodeMirror's own light base theme.
describe('editorTheme (Rulings 92, 130)', () => {
  it('colours markdown marks, links and comments from tokens', () => {
    const v = mount('# Title\n\n[a link](https://x.y)\n\n<!-- note -->\n');

    expect(getComputedStyle(spanWithText(v, '#')).color).toBe(rgb(TOKENS['--muted']));
    expect(getComputedStyle(spanWithText(v, 'https://x.y')).color).toBe(rgb(TOKENS['--link']));
    expect(getComputedStyle(spanWithText(v, '<!-- note -->')).color).toBe(rgb(TOKENS['--preview-code-comment']));
  });

  it('styles the search panel, its fields, buttons and close button from tokens', () => {
    const v = mount('text');
    const panels = inside(v, 'div', 'cm-panels cm-panels-top');
    const panel = inside(v, 'div', 'cm-panel cm-search', panels);
    const field = inside(v, 'input', 'cm-textfield', panel);
    const button = inside(v, 'button', 'cm-button', panel);
    const close = inside(v, 'button', '', panel);
    close.setAttribute('name', 'close');

    expect(getComputedStyle(panels).backgroundColor).toBe(rgb(TOKENS['--chrome']));
    expect(getComputedStyle(panels).borderBottomColor).toBe(rgb(TOKENS['--border']));
    expect(getComputedStyle(field).backgroundColor).toBe(rgb(TOKENS['--bg']));
    expect(getComputedStyle(field).borderTopColor).toBe(rgb(TOKENS['--border']));
    expect(getComputedStyle(button).backgroundImage).toBe('none');
    expect(getComputedStyle(button).backgroundColor).toBe(rgb(TOKENS['--bg']));
    expect(getComputedStyle(close).color).toBe(rgb(TOKENS['--muted']));
  });

  it('styles selection, matches, cursor, tooltips and the active line from tokens', () => {
    const v = mount('text');
    const unfocused = inside(v, 'div', 'cm-selectionBackground');
    const match = inside(v, 'span', 'cm-searchMatch', v.contentDOM);
    const current = inside(v, 'span', 'cm-searchMatch cm-searchMatch-selected', v.contentDOM);
    const cursor = inside(v, 'div', 'cm-cursor');
    const tooltip = inside(v, 'div', 'cm-tooltip');

    expect(getComputedStyle(unfocused).backgroundColor).toBe(rgb(TOKENS['--selection-unfocused']));
    expect(getComputedStyle(match).backgroundColor).toBe(rgb(TOKENS['--search-match']));
    expect(getComputedStyle(current).backgroundColor).toBe(rgb(TOKENS['--search-match-current']));
    expect(getComputedStyle(cursor).borderLeftColor).toBe(rgb(TOKENS['--accent']));
    expect(getComputedStyle(tooltip).backgroundColor).toBe(rgb(TOKENS['--bg']));
    expect(getComputedStyle(tooltip).borderTopColor).toBe(rgb(TOKENS['--border']));
    expect(getComputedStyle(v.contentDOM.querySelector('.cm-activeLine')!).backgroundColor).toBe(rgb(TOKENS['--active-line']));
  });

  it('uses the focused selection colour while the editor has focus', () => {
    const v = mount('text');
    v.dom.classList.add('cm-focused');
    const layer = v.dom.querySelector('.cm-selectionLayer')!;
    const selection = inside(v, 'div', 'cm-selectionBackground', layer);

    expect(getComputedStyle(selection).backgroundColor).toBe(rgb(TOKENS['--selection']));
  });

  it('sets the editor font size from --size-edit', () => {
    const v = mount('text');
    root.style.setProperty('--size-edit', '19px');
    expect(getComputedStyle(v.scrollDOM).fontSize).toBe('19px');
  });
});
