import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorExtensions } from '../editor/setup';
import { lintExtension, renderLintCard } from '../lint/lintExtension';
import type { LintIssue } from '../lint/lint';
import { DEFAULT_SETTINGS, settings } from '../settings/settings.svelte';

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
  '--lint-warning': '#0e0e0e',
  '--lint-active': '#0f0f0f',
  '--lint-card-shadow': '0px 1px 2px #111111',
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

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));

function mount(doc: string, extra: Extension = []): EditorView {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [editorExtensions(() => {}), extra] }),
    parent: document.body,
  });
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

  it('takes the editor font and size from the settings, not from CSS variables (Ruling 170)', () => {
    settings.fontSize = 21;
    settings.editorFont = "'JetBrains Mono', monospace";
    try {
      const v = mount('text');
      root.style.setProperty('--size-edit', '9px');
      expect(getComputedStyle(v.scrollDOM).fontSize).toBe('19px');
      expect(getComputedStyle(v.scrollDOM).fontFamily).toMatch(/^'?JetBrains Mono'?, monospace/);
    } finally {
      settings.fontSize = DEFAULT_SETTINGS.fontSize;
      settings.editorFont = DEFAULT_SETTINGS.editorFont;
    }
  });
});

describe('lint surfaces (Rulings 152, 272)', () => {
  // With the linter's own base theme mounted, which hard-codes light colours, and its dark
  // variants switched on, so the tokens must win over both.
  const withLint = [lintExtension(() => null, () => {}), EditorView.darkTheme.of(true)];

  it('underlines a problem with a wavy line in the warning colour, not the base image', () => {
    const v = mount('text', withLint);
    const range = inside(v, 'span', 'cm-lintRange cm-lintRange-warning', v.contentDOM);

    const style = getComputedStyle(range);
    expect(style.backgroundImage).toBe('none');
    expect(style.textDecorationLine).toBe('underline');
    expect(style.textDecorationStyle).toBe('wavy');
    expect(style.textDecorationColor).toBe(rgb(TOKENS['--lint-warning']));
  });

  it('tints the hovered range and marks the line number from tokens', () => {
    const v = mount('text', withLint);
    const active = inside(v, 'span', 'cm-lintRange cm-lintRange-warning cm-lintRange-active', v.contentDOM);
    const gutter = v.dom.querySelector('.cm-gutters')!;
    const line = inside(v, 'div', 'cm-gutterElement cm-activeLineGutter cm-lintLine', gutter);

    expect(getComputedStyle(active).backgroundColor).toBe(rgb(TOKENS['--lint-active']));
    expect(getComputedStyle(line).color).toBe(rgb(TOKENS['--lint-warning']));
    expect(getComputedStyle(line).fontWeight).toBe('700');
  });

  it('styles the hover card, its rule name and both buttons from tokens', () => {
    const v = mount('text', withLint);
    const tooltip = inside(v, 'div', 'cm-tooltip cm-tooltip-hover');
    const issue = { rule: 'MD004', alias: 'ul-style', message: 'm', fixable: true } as LintIssue;
    const card = renderLintCard([issue], { fix: () => {}, turnOff: () => {} });
    tooltip.append(card);
    const fix = card.querySelector('.cm-lintCard-fix')!;
    const off = card.querySelector('.cm-lintCard-off')!;

    expect(getComputedStyle(tooltip).boxShadow).toBe('rgb(17, 17, 17) 0px 1px 2px');
    expect(getComputedStyle(card).color).toBe(rgb(TOKENS['--text']));
    expect(getComputedStyle(card.querySelector('.cm-lintCard-rule')!).color).toBe(rgb(TOKENS['--lint-warning']));
    expect(getComputedStyle(fix).backgroundColor).toBe(rgb(TOKENS['--accent']));
    expect(getComputedStyle(fix).color).toBe(rgb(TOKENS['--bg']));
    expect(getComputedStyle(off).backgroundColor).toBe(rgb(TOKENS['--bg']));
    expect(getComputedStyle(off).color).toBe(rgb(TOKENS['--text']));
    expect(getComputedStyle(off).borderTopColor).toBe(rgb(TOKENS['--border']));
  });

  it('marks a problem with no width in the warning colour', () => {
    const v = mount('text', withLint);
    const point = inside(v, 'span', 'cm-lintPoint cm-lintPoint-warning', v.contentDOM);

    expect(getComputedStyle(point, '::after').borderBottomColor).toBe(rgb(TOKENS['--lint-warning']));
  });
});
