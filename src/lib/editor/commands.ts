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

/**
 * Fences the selected lines, or opens an empty fenced block below the cursor line.
 * Ranges that share lines get one block between them.
 */
export function insertCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const blocks = codeBlockSpans(state);
  const specs: ChangeSpec[] = blocks.map((block) => {
    if (!block.empty) {
      return [
        { from: block.first.from, insert: FENCE + '\n' },
        { from: block.last.to, insert: '\n' + FENCE },
      ];
    }
    const line = block.first;
    return isBlank(line.text)
      ? { from: line.from, to: line.to, insert: EMPTY_BLOCK }
      : { from: line.to, insert: '\n' + EMPTY_BLOCK };
  });
  const changes = state.changes(specs);
  const ranges = blocks.flatMap((block) => {
    if (block.empty) {
      const line = block.first;
      const blockStart = isBlank(line.text)
        ? changes.mapPos(line.from, -1)
        : changes.mapPos(line.to, -1) + 1;
      return [EditorSelection.cursor(blockStart + FENCE.length + 1)];
    }
    // Ends map backwards so a selection never grows over the closing fence.
    return block.ranges.map((r) => {
      const from = changes.mapPos(r.from, 1);
      const to = r.empty ? from : changes.mapPos(r.to, -1);
      return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
    });
  });
  view.dispatch({
    changes,
    selection: EditorSelection.create(ranges),
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
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
const EMPTY_BLOCK = FENCE + '\n\n' + FENCE;
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
 * Unwrapping needs exactly one marked span, so "**a** and **b**" is never half-stripped.
 */
function toggleMarker(view: EditorView, marker: '**' | '*'): boolean {
  const size = marker.length;
  const isMarked = (stars: number) => stars === size || stars === 3;
  return replaceRanges(view, (range, state) => {
    // CommonMark does not treat "**word **" as bold, so spaces stay outside the markers.
    const { from, to } = withoutOuterSpace(state, range);
    const text = state.sliceDoc(from, to);
    const inside = Math.min(starRun(text), starRun(reversed(text)));
    const content = text.slice(inside, text.length - inside);
    if (isMarked(inside) && content.length > 0 && !content.includes('*')) {
      return {
        changes: [
          { from, to: from + size },
          { from: to - size, to },
        ],
        range: EditorSelection.range(from, to - 2 * size),
      };
    }
    const before = starRun(reversed(state.sliceDoc(Math.max(0, from - 3), from)));
    const after = starRun(state.sliceDoc(to, to + 3));
    if (!text.includes('*') && isMarked(Math.min(before, after))) {
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

function withoutOuterSpace(state: EditorState, range: SelectionRange): { from: number; to: number } {
  const text = state.sliceDoc(range.from, range.to);
  const trimmed = text.trim();
  if (!trimmed) return range;
  const from = range.from + text.indexOf(trimmed);
  return { from, to: from + trimmed.length };
}

function toggleListMarker(view: EditorView, marked: RegExp, prefix: string): boolean {
  const removing = selectedLines(view.state).every((line) => marked.test(line.text));
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

/** Applies `edit` once to each selected line, however many ranges touch it. */
function editLines(view: EditorView, edit: (line: Line) => ChangeSpec): boolean {
  const { state } = view;
  const changes = state.changes(selectedLines(state).map(edit));
  view.dispatch({
    changes,
    selection: state.selection.map(changes, 1),
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

function selectedLines(state: EditorState): Line[] {
  const byNumber = new Map<number, Line>();
  for (const range of state.selection.ranges) {
    for (const line of linesOf(state, range)) byNumber.set(line.number, line);
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

// Blank lines inside a multi-line selection are left alone.
function linesOf(state: EditorState, range: SelectionRange): Line[] {
  const first = state.doc.lineAt(range.from).number;
  const last = lastLine(state, range).number;
  const lines: Line[] = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
  const filled = lines.filter((line) => !isBlank(line.text));
  return lines.length > 1 && filled.length > 0 ? filled : lines;
}

// A selection ending at column 0 (after a triple-click, say) does not include that line.
function lastLine(state: EditorState, range: SelectionRange): Line {
  const line = state.doc.lineAt(range.to);
  return range.to === line.from && range.to > range.from ? state.doc.line(line.number - 1) : line;
}

type CodeBlockSpan = { first: Line; last: Line; empty: boolean; ranges: SelectionRange[] };

/** One span per block to insert: ranges whose lines overlap are merged. */
function codeBlockSpans(state: EditorState): CodeBlockSpan[] {
  const spans: CodeBlockSpan[] = [];
  const ranges = [...state.selection.ranges].sort((a, b) => a.from - b.from);
  for (const range of ranges) {
    const first = state.doc.lineAt(range.from);
    const last = lastLine(state, range);
    const open = spans.at(-1);
    if (open && first.number <= open.last.number) {
      if (last.number > open.last.number) open.last = last;
      open.empty &&= range.empty;
      open.ranges.push(range);
    } else {
      spans.push({ first, last, empty: range.empty, ranges: [range] });
    }
  }
  return spans;
}

function reversed(text: string): string {
  return [...text].reverse().join('');
}

function starRun(text: string): number {
  return /^\**/.exec(text)![0].length;
}

function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
}
