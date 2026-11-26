import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import type { EditorView } from '@codemirror/view';
import Editor from './Editor.svelte';
import { createDoc } from '../docs/store.svelte';


describe('Editor', () => {
  it('shows the doc text and reports edits', () => {
    const doc = createDoc({ path: '/notes/a.md', raw: '# Hi\r\n', hash: 'h0', mode: 'edit' });
    const onChange = vi.fn();
    let view: EditorView | undefined;

    render(Editor, { doc, onChange, onReady: (v: EditorView) => (view = v) });

    expect(view!.state.doc.toString()).toBe('# Hi\n');
    view!.dispatch({ changes: { from: 4, insert: '!' } });
    expect(onChange).toHaveBeenCalledWith('# Hi!\n');
  });
});
