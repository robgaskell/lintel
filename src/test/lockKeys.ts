import { redoSelection, undoSelection } from '@codemirror/commands';
import { keymap, type EditorView } from '@codemirror/view';

const SELECTION_HISTORY = new Set<unknown>([undoSelection, redoSelection]);

/** Every key name the editor's keymaps bind to selection undo or redo, on any platform. */
export function selectionHistoryKeys(view: EditorView): string[] {
  const names = new Set<string>();
  for (const binding of view.state.facet(keymap).flat()) {
    const keys = [binding.key, binding.mac, binding.win, binding.linux].filter((k): k is string => !!k);
    if (SELECTION_HISTORY.has(binding.run)) for (const k of keys) names.add(k);
    if (SELECTION_HISTORY.has(binding.shift)) for (const k of keys) names.add(`Shift-${k}`);
  }
  return [...names];
}

/** A keydown for a one-letter CodeMirror key name such as "Mod-Shift-u". */
export function eventFor(name: string, mac: boolean): KeyboardEventInit {
  const parts = name.split('-');
  const letter = parts.pop() ?? '';
  if (!/^[a-z]$/i.test(letter)) throw new Error(`eventFor takes letter keys only, not ${name}`);
  const has = (modifier: string) => parts.includes(modifier);
  const shiftKey = has('Shift');
  return {
    key: shiftKey ? letter.toUpperCase() : letter.toLowerCase(),
    keyCode: letter.toUpperCase().charCodeAt(0),
    shiftKey,
    altKey: has('Alt'),
    ctrlKey: has('Ctrl') || (has('Mod') && !mac),
    metaKey: has('Meta') || has('Cmd') || (has('Mod') && mac),
  };
}
