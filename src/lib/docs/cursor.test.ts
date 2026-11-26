import { afterEach, describe, expect, it } from 'vitest';
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cursors, trackCursor } from './cursor.svelte';

const theme = new Compartment();
let view: EditorView;

function editor(doc: string) {
  const state = EditorState.create({ doc, extensions: [theme.of([])] });
  view = new EditorView({ parent: document.body, state });
  return view;
}

afterEach(() => view.destroy());

describe('trackCursor', () => {
  it('keeps reporting when other extensions are added or a compartment is reconfigured', () => {
    const v = editor('ab\ncd');
    const stop = trackCursor('d1', v);

    v.dispatch({ effects: StateEffect.appendConfig.of(EditorView.lineWrapping) });
    v.dispatch({ effects: theme.reconfigure(EditorView.editable.of(true)) });
    v.dispatch({ selection: { anchor: 4 } });

    expect(cursors.get('d1')).toEqual({ line: 2, col: 2 });
    stop();
  });

  // The trap named in cursor.svelte.ts: a later reload must call trackCursor again.
  it('stops reporting after setState, which drops appended extensions', () => {
    const v = editor('ab\ncd');
    const stop = trackCursor('d2', v);

    v.setState(EditorState.create({ doc: 'xy\nzw' }));
    v.dispatch({ selection: { anchor: 4 } });

    expect(cursors.get('d2')).toEqual({ line: 1, col: 1 });
    stop();
  });
});
