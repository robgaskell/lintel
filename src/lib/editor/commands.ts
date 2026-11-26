import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
} from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';

export function toggleBold(view: EditorView): boolean {
  return toggleMarker(view, '**');
}

export function toggleItalic(view: EditorView): boolean {
  return toggleMarker(view, '*');
}

/** Each line in the selection steps: none, #, ##, ###, then none again. */
export function cycleHeading(view: EditorView): boolean {
  return editLines(view, (line) => {
    const heading = /^(#{1,6}) /.exec(line.text);
    const level = heading ? heading[1].length : 0;
    const next = level >= 3 ? 0 : level + 1;
    return {
      from: line.from,
      to: line.from + (heading ? heading[0].length : 0),
      insert: next ? '#'.repeat(next) + ' ' : '',
    };
  });
}

/** Wraps the selection as link text and selects the `url` placeholder for typing over. */
export function insertLink(view: EditorView): boolean {
  return replaceRanges(view, (range, state) => {
    const text = state.sliceDoc(range.from, range.to);
    const urlFrom = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](url)` },
      range: text
        ? EditorSelection.range(urlFrom, urlFrom + 3)
        : EditorSelection.cursor(range.from + 1),
    };
  });
}

export function toggleBulletList(view: EditorView): boolean {
  return toggleListMarker(view, BULLET, '- ');
}

export function toggleTaskList(view: EditorView): boolean {
  return toggleListMarker(view, TASK, '- [ ] ');
}

/** Inserts a 2-column, 2-row table on its own lines and selects the first header. */
export function insertTable(view: EditorView): boolean {
  return replaceRanges(view, (range, state) => {
    const line = state.doc.lineAt(range.to);
    const blank = isBlank(line.text);
    const at = blank ? line.from : line.to;
    const before = blank ? '' : '\n\n';
    // A text line straight after a table would join it as a row.
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
    const after = next && !isBlank(next.text) ? '\n' : '';
    const headerFrom = at + before.length + 2;
    return {
      changes: { from: at, to: blank ? line.to : at, insert: before + TABLE + after },
      range: EditorSelection.range(headerFrom, headerFrom + 'Column 1'.length),
    };
  });
}

/** Fences the selected lines, or opens an empty fenced block below the cursor line. */
export function insertCodeBlock(view: EditorView): boolean {
  return replaceRanges(view, (range, state) => {
    if (range.empty) {
      const line = state.doc.lineAt(range.head);
      const blank = isBlank(line.text);
      const at = blank ? line.from : line.to;
      const insert = (blank ? '' : '\n') + FENCE + '\n\n' + FENCE;
      return {
        changes: { from: at, to: blank ? line.to : at, insert },
        range: EditorSelection.cursor(at + insert.length - FENCE.length - 1),
      };
    }
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(range.to);
    return {
      changes: [
        { from: first.from, insert: FENCE + '\n' },
        { from: last.to, insert: '\n' + FENCE },
      ],
      range: EditorSelection.range(range.from + 4, range.to + 4),
    };
  });
}

/** Opens the search panel with the replace field focused. */
export function openFindReplace(view: EditorView): boolean {
  openSearchPanel(view);
  // @codemirror/search has no API for this; the field name is private (pinned at 6.7.3).
  const replace = view.dom.querySelector<HTMLInputElement>('.cm-search [name=replace]');
  replace?.focus();
  replace?.select();
  return true;
}

export const formattingKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-Shift-h', run: cycleHeading },
  { key: 'Mod-Shift-8', run: toggleBulletList },
  { key: 'Mod-Shift-9', run: toggleTaskList },
  { key: 'Mod-Shift-t', run: insertTable },
  { key: 'Mod-Shift-c', run: insertCodeBlock },
  { key: 'Mod-Alt-f', run: openFindReplace },
];

const FENCE = '```';
const TABLE = [
  '| Column 1 | Column 2 |',
  '| -------- | -------- |',
  '|          |          |',
  '|          |          |',
].join('\n');
const BULLET = /^(\s*)[-*+] (?!\[[ xX]\] )/;
const TASK = /^(\s*)[-*+] \[[ xX]\] /;
const ANY_LIST = /^(\s*)[-*+] (\[[ xX]\] )?/;

type RangeEdit = { changes: ChangeSpec; range: SelectionRange };

function replaceRanges(
  view: EditorView,
  edit: (range: SelectionRange, state: EditorState) => RangeEdit,
): boolean {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => edit(range, state)), {
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

/**
 * Wraps or unwraps each range in `marker`. A run of three stars counts as both bold and
 * italic, so toggling italic on bold text adds italic rather than stripping a star.
 */
function toggleMarker(view: EditorView, marker: '**' | '*'): boolean {
  const size = marker.length;
  const isMarked = (stars: number) => stars === size || stars === 3;
  return replaceRanges(view, (range, state) => {
    const { from, to } = range;
    const text = state.sliceDoc(from, to);
    const inside = Math.min(starRun(text), starRun([...text].reverse().join('')));
    if (text.length > 2 * inside && isMarked(inside)) {
      return {
        changes: [
          { from, to: from + size },
          { from: to - size, to },
        ],
        range: EditorSelection.range(from, to - 2 * size),
      };
    }
    const before = starRun([...state.sliceDoc(Math.max(0, from - 3), from)].reverse().join(''));
    const after = starRun(state.sliceDoc(to, to + 3));
    if (isMarked(Math.min(before, after))) {
      return {
        changes: [
          { from: from - size, to: from },
          { from: to, to: to + size },
        ],
        range: EditorSelection.range(from - size, to - size),
      };
    }
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: EditorSelection.range(from + size, to + size),
    };
  });
}

function toggleListMarker(view: EditorView, marked: RegExp, prefix: string): boolean {
  const { state } = view;
  const removing = selectedLines(state).every((line) => marked.test(line.text));
  return editLines(view, (line) => {
    const list = ANY_LIST.exec(line.text);
    const indent = list ? list[1].length : (/^\s*/.exec(line.text)?.[0].length ?? 0);
    const markerTo = line.from + (list ? list[0].length : indent);
    if (removing) return { from: line.from + indent, to: markerTo };
    // Keeps a ticked task ticked.
    if (marked.test(line.text)) return [];
    return { from: line.from + indent, to: markerTo, insert: prefix };
  });
}

function editLines(view: EditorView, edit: (line: Line) => ChangeSpec): boolean {
  return replaceRanges(view, (range, state) => {
    const changes = state.changes(linesOf(state, range).map(edit));
    return { changes, range: range.map(changes, 1) };
  });
}

function selectedLines(state: EditorState): Line[] {
  return state.selection.ranges.flatMap((range) => linesOf(state, range));
}

// Blank lines inside a multi-line selection are left alone.
function linesOf(state: EditorState, range: SelectionRange): Line[] {
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  const lines: Line[] = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
  const filled = lines.filter((line) => !isBlank(line.text));
  return lines.length > 1 && filled.length > 0 ? filled : lines;
}

function starRun(text: string): number {
  return /^\**/.exec(text)![0].length;
}

function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
}
