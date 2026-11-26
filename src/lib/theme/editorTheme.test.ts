import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorExtensions } from '../editor/setup';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string): EditorView {
  view = new EditorView({ state: EditorState.create({ doc, extensions: editorExtensions(() => {}) }), parent: document.body });
  return view;
}

// Every rule CodeMirror mounts, as text, wherever StyleModule put it.
function mountedCss(): string {
  const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])];
  return sheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\n');
}

describe('editorTheme (Ruling 130)', () => {
  it('colours markdown marks and syntax from variables, not the default light style', () => {
    const v = mount('# Title\n\nSome `code` here.\n');
    const css = mountedCss();
    const mark = v.contentDOM.querySelector('.cm-line span')!;

    expect(mark.textContent).toBe('#');
    const markRule = [...mark.classList].map((c) => css.match(new RegExp(`\\.${c}\\s*\\{[^}]*\\}`))?.[0]).join(' ');
    expect(markRule).toContain('var(--muted)');
    // defaultHighlightStyle's fixed colours never reach the page.
    expect(css).not.toMatch(/#708|#a11|#219/);
  });

  it('styles selection, search panel and matches from tokens', () => {
    mount('text');
    const css = mountedCss();

    for (const token of ['--selection', '--search-match', '--search-match-current', '--chrome', '--border']) {
      expect(css).toContain(`var(${token})`);
    }
    expect(css).toMatch(/\.cm-scroller\s*\{[^}]*font-size:\s*var\(--size-edit\)/);
  });
});
