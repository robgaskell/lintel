import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FILE_CHANGED, FILE_REMOVED, readTextFile, writeTextFile } from '../ipc';
import { editorExtensions } from '../editor/setup';
import { registerView, setActiveDocSource } from '../editor/views';
import {
  handleFileChanged,
  handleFileRemoved,
  keepMine,
  listenForFileEvents,
  loadDisk,
  markSeen,
  setReloadNoticeShower,
} from './reload';
import { createDoc, docs, isDirty, saveDoc, type DocState } from './store.svelte';

vi.mock('../ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc')>()),
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('../os/recent', () => ({ recordRecent: vi.fn() }));

const read = vi.mocked(readTextFile);
const write = vi.mocked(writeTextFile);
const notices: string[] = [];
let active: string | null = null;
const views: EditorView[] = [];

beforeEach(() => {
  docs.clear();
  read.mockReset();
  write.mockReset();
  notices.length = 0;
  setReloadNoticeShower((text) => notices.push(text));
  active = null;
  setActiveDocSource({ activeDocId: () => active });
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  setActiveDocSource(null);
});

function openDoc(raw: string, path = '/notes/plan.md'): DocState {
  return createDoc({ path, raw, hash: 'h-old', mode: 'edit' });
}

// The editor as DocPane mounts it: edits flow into doc.text.
function editorFor(doc: DocState): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: doc.text,
      extensions: editorExtensions((text) => (doc.text = text)),
    }),
  });
  registerView(doc.id, view);
  views.push(view);
  return view;
}

function cursorLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number;
}

function diskHas(text: string, hash: string) {
  read.mockResolvedValueOnce({ text, hash });
}

describe('handleFileChanged', () => {
  it('reloads a clean active doc in its editor, keeping the cursor line', async () => {
    const doc = openDoc('# Plan\n\none\ntwo\n');
    const view = editorFor(doc);
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 2 } });
    active = doc.id;
    diskHas('# New plan\n\none\ntwo\nthree\n', 'h-new');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-new' });

    expect(view.state.doc.toString()).toBe('# New plan\n\none\ntwo\nthree\n');
    expect(cursorLine(view)).toBe(3);
    expect(doc.text).toBe('# New plan\n\none\ntwo\nthree\n');
    expect(doc.savedText).toBe(doc.text);
    expect(doc.diskHash).toBe('h-new');
    expect(doc.external).toBe('none');
    expect(notices).toEqual(['plan.md reloaded from disk']);
  });

  it('reloads a clean inactive doc and marks it updated', async () => {
    const doc = openDoc('old\n');
    active = 'another-doc';
    diskHas('new\r\n', 'h-new');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-new' });

    expect(doc.text).toBe('new\n');
    expect(doc.savedText).toBe('new\n');
    expect(doc.lineEnding).toBe('\r\n');
    expect(doc.diskHash).toBe('h-new');
    expect(doc.external).toBe('updated');
    expect(notices).toEqual(['plan.md reloaded from disk']);
  });

  it('holds the disk version of a dirty doc as a conflict and changes nothing else', async () => {
    const doc = openDoc('old\n');
    const view = editorFor(doc);
    view.dispatch({ changes: { from: 3, insert: ' mine' } });
    diskHas('theirs\r\n', 'h-theirs');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-theirs' });

    expect(doc.external).toBe('conflict');
    expect(doc.diskText).toBe('theirs\n');
    expect(doc.diskHash).toBe('h-theirs');
    expect(doc.text).toBe('old mine\n');
    expect(doc.savedText).toBe('old\n');
    expect(view.state.doc.toString()).toBe('old mine\n');
    expect(notices).toEqual([]);
  });

  it('reads nothing when the hash is the one the doc has, or the path is not open here', async () => {
    openDoc('old\n');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-old' });
    await handleFileChanged({ path: '/notes/other.md', hash: 'h-new' });

    expect(read).not.toHaveBeenCalled();
  });

  it('leaves a doc that was edited while the disk version was read as a conflict', async () => {
    const doc = openDoc('old\n');
    read.mockImplementationOnce(async () => {
      doc.text = 'typed meanwhile\n';
      return { text: 'theirs\n', hash: 'h-theirs' };
    });

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-theirs' });

    expect(doc.external).toBe('conflict');
    expect(doc.text).toBe('typed meanwhile\n');
  });

  it('logs and ignores a file that can no longer be read', async () => {
    const doc = openDoc('old\n');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    read.mockRejectedValueOnce('Lintel opens UTF-8 text files only.');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-new' });

    expect(doc.text).toBe('old\n');
    expect(doc.external).toBe('none');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('makes the reload one undo step that brings the old text back as unsaved (Ruling 258)', async () => {
    const doc = openDoc('old\n');
    const view = editorFor(doc);
    // An edit saved just now, which a reload must not join in one undo step.
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    doc.savedText = doc.text;
    active = doc.id;
    diskHas('new\n', 'h-new');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-new' });
    undo(view);

    expect(doc.text).toBe('xold\n');
    expect(isDirty(doc)).toBe(true);
  });
});

describe('keepMine', () => {
  it('drops the disk version, and the next save writes my text over it', async () => {
    const doc = openDoc('old\n');
    doc.text = 'mine\n';
    diskHas('theirs\n', 'h-theirs');
    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-theirs' });

    keepMine(doc.id);

    expect(doc.diskText).toBeNull();
    expect(doc.external).toBe('none');
    expect(doc.diskHash).toBe('h-theirs');
    // Unsaved now means "differs from the file on disk".
    expect(doc.savedText).toBe('theirs\n');
    doc.text = 'theirs\n';
    expect(isDirty(doc)).toBe(false);
  });
});

describe('loadDisk', () => {
  it('replaces text and savedText with the disk version in the editor', async () => {
    const doc = openDoc('old\n');
    const view = editorFor(doc);
    view.dispatch({ changes: { from: 3, insert: ' mine' } });
    diskHas('theirs\r\n', 'h-theirs');
    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-theirs' });

    loadDisk(doc.id);

    expect(view.state.doc.toString()).toBe('theirs\n');
    expect(doc.text).toBe('theirs\n');
    expect(doc.savedText).toBe('theirs\n');
    expect(doc.lineEnding).toBe('\r\n');
    expect(doc.diskHash).toBe('h-theirs');
    expect(doc.diskText).toBeNull();
    expect(doc.external).toBe('none');
    undo(view);
    expect(doc.text).toBe('old mine\n');
  });
});

describe('handleFileRemoved', () => {
  it('marks the doc deleted, and a save of the clean doc writes it once and clears the mark', async () => {
    const doc = openDoc('kept\n');
    write.mockResolvedValueOnce('h-kept');

    handleFileRemoved({ path: '/notes/plan.md' });
    expect(doc.external).toBe('deleted');

    expect(await saveDoc(doc.id)).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('/notes/plan.md', 'kept\n');
    expect(doc.external).toBe('none');
  });

  it('clears the mark when the file comes back as it was', async () => {
    const doc = openDoc('kept\n');
    handleFileRemoved({ path: '/notes/plan.md' });
    diskHas('kept\n', 'h-old');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-old' });

    expect(doc.external).toBe('none');
    expect(notices).toEqual([]);
  });
});

describe('markSeen', () => {
  it("clears 'updated' and leaves the other marks", () => {
    const updated = openDoc('a', '/notes/a.md');
    const deleted = openDoc('b', '/notes/b.md');
    updated.external = 'updated';
    deleted.external = 'deleted';

    markSeen(updated.id);
    markSeen(deleted.id);
    markSeen(null);

    expect(updated.external).toBe('none');
    expect(deleted.external).toBe('deleted');
  });
});

describe('listenForFileEvents', () => {
  it("listens for this window's changes and removals only", async () => {
    const doc = openDoc('kept\n');
    const { ready } = listenForFileEvents('w-1');
    await ready;

    const calls = vi.mocked(listen).mock.calls;
    expect(calls.map(([event, , options]) => [event, options])).toEqual([
      [FILE_CHANGED, { target: { kind: 'WebviewWindow', label: 'w-1' } }],
      [FILE_REMOVED, { target: { kind: 'WebviewWindow', label: 'w-1' } }],
    ]);
    const removed = calls[1][1] as (e: { payload: { path: string } }) => void;
    removed({ payload: { path: '/notes/plan.md' } });
    expect(doc.external).toBe('deleted');
  });
});
