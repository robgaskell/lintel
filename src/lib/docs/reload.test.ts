import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import { undo } from '@codemirror/commands';
import { EditorState, type ChangeSet } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FILE_CHANGED, FILE_REMOVED, pathsExist, readTextFile, writeTextFile } from '../ipc';
import { editorExtensions } from '../editor/setup';
import { registerView, setActiveDocSource } from '../editor/views';
import {
  followWorkspace,
  handleFileChanged,
  handleFileRemoved,
  keepMine,
  listenForFileEvents,
  loadDisk,
  markSeen,
  reportLiveReloadOff,
  setReloadNoticeShower,
} from './reload';
import { createDoc, docs, isDirty, saveDoc, type DocState } from './store.svelte';
import { handleConfigFileEvent } from '../lint/config';

vi.mock('../ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc')>()),
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  pathsExist: vi.fn(async (paths: string[]) => paths.map(() => false)),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('../os/recent', () => ({ recordRecent: vi.fn() }));
vi.mock('../lint/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lint/config')>()),
  handleConfigFileEvent: vi.fn(),
}));

const read = vi.mocked(readTextFile);
const write = vi.mocked(writeTextFile);
const notices: string[] = [];
let active: string | null = null;
const views: EditorView[] = [];

beforeEach(() => {
  docs.clear();
  read.mockReset();
  write.mockReset();
  vi.mocked(message).mockReset();
  vi.mocked(pathsExist).mockClear();
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

// The editor as DocPane mounts it: edits flow into doc.text. `changes` records each edit.
function editorFor(doc: DocState, changes: ChangeSet[] = []): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: doc.text,
      extensions: [
        editorExtensions((text) => (doc.text = text)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changes.push(update.changes);
        }),
      ],
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

async function conflictOver(doc: DocState, disk: string, hash: string) {
  diskHas(disk, hash);
  await handleFileChanged({ path: doc.path!, hash });
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

  it('replaces only what changed, so an appended line leaves the rest and the cursor alone', async () => {
    const doc = openDoc('one\ntwo\n');
    const changes: ChangeSet[] = [];
    const view = editorFor(doc, changes);
    view.dispatch({ selection: { anchor: 5 } });
    diskHas('one\ntwo\nmore\n', 'h-new');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-new' });

    const touched: [number, number, string][] = [];
    changes[0].iterChanges((from, to, _f, _t, inserted) => touched.push([from, to, inserted.toString()]));
    expect(touched).toEqual([[8, 8, 'more\n']]);
    expect(view.state.selection.main.head).toBe(5);
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

  it('does not mark a doc updated while another group shows it (Ruling 265)', async () => {
    const doc = openDoc('old\n');
    active = 'another-doc';
    const stop = followWorkspace({ onActiveChange: () => () => {}, isVisible: (id) => id === doc.id });
    diskHas('new\n', 'h-new');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-new' });
    stop();

    expect(doc.text).toBe('new\n');
    expect(doc.external).toBe('none');
  });

  it('holds the disk version of a dirty doc as a conflict and changes nothing else', async () => {
    const doc = openDoc('old\n');
    const view = editorFor(doc);
    view.dispatch({ changes: { from: 3, insert: ' mine' } });

    await conflictOver(doc, 'theirs\r\n', 'h-theirs');

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

  it('drops a read that a save finished during, then finds the file is the saved one (Ruling 263)', async () => {
    const doc = openDoc('old\n');
    const view = editorFor(doc);
    write.mockResolvedValueOnce('h-mine');
    read.mockImplementationOnce(async () => {
      view.dispatch({ changes: { from: 3, insert: ' mine' } });
      await saveDoc(doc.id);
      return { text: 'theirs\n', hash: 'h-theirs' };
    });
    diskHas('old mine\n', 'h-mine');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-theirs' });

    expect(view.state.doc.toString()).toBe('old mine\n');
    expect(doc.savedText).toBe('old mine\n');
    expect(doc.diskHash).toBe('h-mine');
    expect(doc.external).toBe('none');
  });

  it('keeps "Deleted on disk" when the file is removed during the read (Ruling 278)', async () => {
    const doc = openDoc('old\n');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    read.mockImplementationOnce(async () => {
      await handleFileRemoved({ path: '/notes/plan.md' });
      return { text: 'new\n', hash: 'h-new' };
    });
    read.mockRejectedValueOnce('Could not read /notes/plan.md: gone');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-new' });

    expect(doc.external).toBe('deleted');
    expect(doc.text).toBe('old\n');
    expect(doc.diskHash).toBe('h-old');
    quiet.mockRestore();
  });

  it('looks again when the doc was edited during the read, and holds a conflict', async () => {
    const doc = openDoc('old\n');
    read.mockImplementationOnce(async () => {
      doc.text = 'typed meanwhile\n';
      return { text: 'theirs\n', hash: 'h-theirs' };
    });
    diskHas('theirs\n', 'h-theirs');

    await handleFileChanged({ path: '/notes/plan.md', hash: 'h-theirs' });

    expect(doc.external).toBe('conflict');
    expect(doc.diskText).toBe('theirs\n');
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
    await conflictOver(doc, 'theirs\n', 'h-theirs');

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
  it('loads the file as it is now, with its line ending, into the editor (Ruling 263)', async () => {
    const doc = openDoc('old\n');
    const view = editorFor(doc);
    view.dispatch({ changes: { from: 3, insert: ' mine' } });
    await conflictOver(doc, 'theirs\n', 'h-theirs');
    diskHas('newest\r\n', 'h-newest');

    await loadDisk(doc.id);

    expect(view.state.doc.toString()).toBe('newest\n');
    expect(doc.text).toBe('newest\n');
    expect(doc.savedText).toBe('newest\n');
    expect(doc.lineEnding).toBe('\r\n');
    expect(doc.diskHash).toBe('h-newest');
    expect(doc.diskText).toBeNull();
    expect(doc.external).toBe('none');
    undo(view);
    expect(doc.text).toBe('old mine\n');
  });

  it('shows why the file could not be read and keeps the banner', async () => {
    const doc = openDoc('old\n');
    doc.text = 'mine\n';
    await conflictOver(doc, 'theirs\n', 'h-theirs');
    read.mockRejectedValueOnce('Could not read /notes/plan.md: gone');

    await loadDisk(doc.id);

    expect(message).toHaveBeenCalledWith(
      'Could not read /notes/plan.md: gone',
      expect.objectContaining({ kind: 'error' }),
    );
    expect(doc.external).toBe('conflict');
    expect(doc.diskText).toBe('theirs\n');
    expect(doc.text).toBe('mine\n');
  });
});

describe('handleFileRemoved', () => {
  it('marks the doc deleted, and a save of the clean doc writes it once and clears the mark', async () => {
    const doc = openDoc('kept\n');
    write.mockResolvedValueOnce('h-kept');

    await handleFileRemoved({ path: '/notes/plan.md' });
    expect(doc.external).toBe('deleted');

    expect(await saveDoc(doc.id)).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('/notes/plan.md', 'kept\n');
    expect(doc.external).toBe('none');
  });

  it('does nothing when the file is there after all, as after a save that raced it (Ruling 263)', async () => {
    const doc = openDoc('kept\n');
    vi.mocked(pathsExist).mockResolvedValueOnce([true]);

    await handleFileRemoved({ path: '/notes/plan.md' });

    expect(pathsExist).toHaveBeenCalledWith(['/notes/plan.md']);
    expect(doc.external).toBe('none');
  });

  it('drops the disk version a conflict held', async () => {
    const doc = openDoc('old\n');
    doc.text = 'mine\n';
    await conflictOver(doc, 'theirs\n', 'h-theirs');

    await handleFileRemoved({ path: '/notes/plan.md' });

    expect(doc.external).toBe('deleted');
    expect(doc.diskText).toBeNull();
  });

  it('clears the mark when the file comes back as it was', async () => {
    const doc = openDoc('kept\n');
    await handleFileRemoved({ path: '/notes/plan.md' });
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

describe('live reload switched off (Ruling 265)', () => {
  it('says so once per window, with the first reason', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    reportLiveReloadOff('Could not watch /notes: too many open files');
    reportLiveReloadOff(new Error('again'));

    expect(notices).toEqual(['Live reload is off: Could not watch /notes: too many open files']);
    quiet.mockRestore();
  });

  it('says so when this window cannot listen for file events', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(listen).mockRejectedValueOnce(new Error('no event plugin'));

    await listenForFileEvents('w-1').ready;

    expect(notices).toEqual(['Live reload is off: no event plugin']);
    quiet.mockRestore();
  });
});

describe('listenForFileEvents', () => {
  it("listens for this window's changes and removals only", async () => {
    const doc = openDoc('kept\n');
    vi.mocked(listen).mockClear();
    const { ready } = listenForFileEvents('w-1');
    await ready;

    const calls = vi.mocked(listen).mock.calls;
    expect(calls.map(([event, , options]) => [event, options])).toEqual([
      [FILE_CHANGED, { target: { kind: 'WebviewWindow', label: 'w-1' } }],
      [FILE_REMOVED, { target: { kind: 'WebviewWindow', label: 'w-1' } }],
    ]);
    const removed = calls[1][1] as (e: { payload: { path: string } }) => void;
    removed({ payload: { path: '/notes/plan.md' } });
    await vi.waitFor(() => expect(doc.external).toBe('deleted'));
  });

  it('passes each change and removal on to the lint config too (Ruling 284)', async () => {
    vi.mocked(listen).mockClear();
    await listenForFileEvents('main').ready;
    const [changed, removed] = vi.mocked(listen).mock.calls.map(([, handler]) => handler as (e: unknown) => void);

    changed({ payload: { path: '/repo/.markdownlint.json', hash: 'h' } });
    removed({ payload: { path: '/repo/.markdownlint.yaml' } });

    expect(vi.mocked(handleConfigFileEvent).mock.calls).toEqual([
      ['/repo/.markdownlint.json'],
      ['/repo/.markdownlint.yaml'],
    ]);
  });
});
