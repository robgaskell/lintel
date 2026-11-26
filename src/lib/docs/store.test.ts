import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPath, normalizePath, releasePath, writeTextFile } from '../ipc';
import { message, save } from '@tauri-apps/plugin-dialog';
import { recordRecent } from '../os/recent';
import {
  adoptDoc,
  closeDocWithPrompt,
  confirmCloseAll,
  createDoc,
  docs,
  findByPath,
  isDirty,
  removeDoc,
  saveDoc,
  saveDocAs,
  untitledCounter,
} from './store.svelte';

vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../os/recent', () => ({ recordRecent: vi.fn() }));

const write = vi.mocked(writeTextFile);
const normalize = vi.mocked(normalizePath);
const saveDialog = vi.mocked(save);
const messageDialog = vi.mocked(message);

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  write.mockReset();
  normalize.mockReset();
  normalize.mockImplementation(async (path) => path);
  saveDialog.mockReset();
  messageDialog.mockReset();
  vi.mocked(recordRecent).mockReset();
  vi.mocked(claimPath).mockReset();
  vi.mocked(claimPath).mockResolvedValue(null);
  vi.mocked(releasePath).mockReset();
  vi.mocked(releasePath).mockResolvedValue();
});

describe('createDoc', () => {
  it('loads raw text into an LF buffer and keeps the ending', () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\r\nb\r\n', hash: 'h0', mode: 'edit' });
    expect(doc.text).toBe('a\nb\n');
    expect(doc.savedText).toBe('a\nb\n');
    expect(doc.lineEnding).toBe('\r\n');
    expect(doc.diskHash).toBe('h0');
    expect(doc.title).toBe('a.md');
    expect(doc.external).toBe('none');
    expect(doc.diskText).toBeNull();
    expect(doc.lintConfigPath).toBeNull();
    expect(docs.get(doc.id)).toBe(doc);
  });

  it('names untitled docs Untitled-1, Untitled-2', () => {
    expect(createDoc({ path: null, raw: '', hash: '', mode: 'edit' }).title).toBe('Untitled-1');
    expect(createDoc({ path: null, raw: '', hash: '', mode: 'edit' }).title).toBe('Untitled-2');
  });

  it('takes the title from a Windows path', () => {
    const doc = createDoc({ path: 'C:\\notes\\b.md', raw: '', hash: '', mode: 'edit' });
    expect(doc.title).toBe('b.md');
  });
});

describe('findByPath', () => {
  it('finds an open doc by path', () => {
    const doc = createDoc({ path: '/notes/a.md', raw: '', hash: '', mode: 'edit' });
    expect(findByPath('/notes/a.md')).toBe(doc);
    expect(findByPath('/notes/missing.md')).toBeUndefined();
  });
});

describe('saveDoc', () => {
  it('writes nothing when the doc is not dirty', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\r\nb\r\n', hash: 'h0', mode: 'edit' });
    expect(isDirty(doc)).toBe(false);
    expect(await saveDoc(doc.id)).toBe(true);
    expect(write).toHaveBeenCalledTimes(0);
  });

  it('writes the edit back with the original CRLF endings', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\r\nb\r\n', hash: 'h0', mode: 'edit' });
    doc.text = 'a\nbc\n';
    expect(isDirty(doc)).toBe(true);
    write.mockResolvedValue('h1');

    expect(await saveDoc(doc.id)).toBe(true);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('/notes/a.md', 'a\r\nbc\r\n');
    expect(doc.savedText).toBe(doc.text);
    expect(doc.diskHash).toBe('h1');
    expect(isDirty(doc)).toBe(false);
  });

  it('writes a clean doc that was deleted on disk, and clears the mark', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\n', hash: 'h0', mode: 'edit' });
    doc.external = 'deleted';
    write.mockResolvedValue('h1');

    expect(await saveDoc(doc.id)).toBe(true);

    expect(write).toHaveBeenCalledWith('/notes/a.md', 'a\n');
    expect(doc.external).toBe('none');
  });

  it('keeps edits typed during the write as unsaved', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\n', hash: 'h0', mode: 'edit' });
    doc.text = 'ab\n';
    write.mockImplementation(async () => {
      doc.text = 'abc\n';
      return 'h1';
    });

    await saveDoc(doc.id);

    expect(doc.savedText).toBe('ab\n');
    expect(isDirty(doc)).toBe(true);
  });

  it('asks for a path for a clean, empty untitled doc', async () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    saveDialog.mockResolvedValue('/notes/empty.md');
    write.mockResolvedValue('h1');

    expect(await saveDoc(doc.id)).toBe(true);

    expect(saveDialog).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('/notes/empty.md', '');
    expect(doc.path).toBe('/notes/empty.md');
  });

  it('keeps the doc dirty when the write fails', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\n', hash: 'h0', mode: 'edit' });
    doc.text = 'ab\n';
    write.mockRejectedValue('Could not save /notes/a.md: disk full');

    await expect(saveDoc(doc.id)).rejects.toBe('Could not save /notes/a.md: disk full');

    expect(isDirty(doc)).toBe(true);
    expect(doc.diskHash).toBe('h0');
  });

  it('clears the held disk version on save', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\n', hash: 'h0', mode: 'edit' });
    doc.text = 'mine\n';
    doc.external = 'conflict';
    doc.diskText = 'theirs\n';
    write.mockResolvedValue('h1');

    await saveDoc(doc.id);

    expect(doc.external).toBe('none');
    expect(doc.diskText).toBeNull();
  });

  it('writes once when Save is pressed twice during one write', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\n', hash: 'h0', mode: 'edit' });
    doc.text = 'ab\n';
    let finish: (hash: string) => void = () => {};
    write.mockImplementation(() => new Promise<string>((resolve) => (finish = resolve)));

    const first = saveDoc(doc.id);
    const second = saveDoc(doc.id);
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    finish('h1');

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('throws for an unknown doc id', async () => {
    await expect(saveDoc('no-such-id')).rejects.toThrow('no-such-id');
    await expect(saveDocAs('no-such-id')).rejects.toThrow('no-such-id');
  });

  it('asks for a path when the doc is untitled, and returns false on cancel', async () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    doc.text = 'new\n';
    saveDialog.mockResolvedValue(null);

    expect(await saveDoc(doc.id)).toBe(false);
    expect(write).toHaveBeenCalledTimes(0);
  });
});

describe('saveDocAs', () => {
  it('writes to the chosen path and renames the doc', async () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    doc.text = 'new\n';
    saveDialog.mockResolvedValue('/notes/new.md');
    write.mockResolvedValue('h2');

    expect(await saveDocAs(doc.id)).toBe(true);

    expect(write).toHaveBeenCalledWith('/notes/new.md', 'new\n');
    expect(doc.path).toBe('/notes/new.md');
    expect(doc.title).toBe('new.md');
    expect(doc.diskHash).toBe('h2');
    expect(isDirty(doc)).toBe(false);
  });

  it('keeps the old path when the write fails', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\n', hash: 'h0', mode: 'edit' });
    saveDialog.mockResolvedValue('/notes/b.md');
    write.mockRejectedValue('This file is read-only.');

    await expect(saveDocAs(doc.id)).rejects.toBe('This file is read-only.');

    expect(doc.path).toBe('/notes/a.md');
    expect(doc.title).toBe('a.md');
    expect(doc.diskHash).toBe('h0');
  });
});

describe('closeDocWithPrompt', () => {
  function dirtyDoc(path: string | null = '/notes/a.md') {
    const doc = createDoc({ path, raw: 'a\n', hash: 'h0', mode: 'split' });
    doc.text = 'a\nb\n';
    return doc;
  }

  it('keeps a dirty doc open when the answer is Cancel', async () => {
    const doc = dirtyDoc();
    messageDialog.mockResolvedValue('Cancel');

    expect(await closeDocWithPrompt(doc.id)).toBe(false);
    expect(docs.has(doc.id)).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('offers Save, Don\'t Save and Cancel, naming the doc', async () => {
    const doc = dirtyDoc();
    messageDialog.mockResolvedValue('Cancel');

    await closeDocWithPrompt(doc.id);

    expect(messageDialog).toHaveBeenCalledTimes(1);
    const [text, options] = messageDialog.mock.calls[0];
    expect(text).toContain('a.md');
    expect(options).toMatchObject({
      kind: 'warning',
      buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
    });
  });

  it('treats an unknown answer as Cancel', async () => {
    const doc = dirtyDoc();
    messageDialog.mockResolvedValue('Yes');

    expect(await closeDocWithPrompt(doc.id)).toBe(false);
    expect(docs.has(doc.id)).toBe(true);
  });

  it("discards edits and removes the doc on Don't Save", async () => {
    const doc = dirtyDoc();
    messageDialog.mockResolvedValue("Don't Save");

    expect(await closeDocWithPrompt(doc.id)).toBe(true);
    expect(docs.has(doc.id)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('saves and removes the doc on Save', async () => {
    const doc = dirtyDoc();
    messageDialog.mockResolvedValue('Save');
    write.mockResolvedValue('h1');

    expect(await closeDocWithPrompt(doc.id)).toBe(true);
    expect(write).toHaveBeenCalledWith('/notes/a.md', 'a\nb\n');
    expect(docs.has(doc.id)).toBe(false);
  });

  it('keeps an untitled doc open when Save As is cancelled', async () => {
    const doc = dirtyDoc(null);
    messageDialog.mockResolvedValue('Save');
    saveDialog.mockResolvedValue(null);

    expect(await closeDocWithPrompt(doc.id)).toBe(false);
    expect(docs.has(doc.id)).toBe(true);
  });

  it('shows the error and keeps the doc open when the save fails', async () => {
    const doc = dirtyDoc();
    messageDialog.mockResolvedValueOnce('Save').mockResolvedValueOnce('Ok');
    write.mockRejectedValue('Could not write /notes/a.md: disk full');

    expect(await closeDocWithPrompt(doc.id)).toBe(false);
    expect(docs.has(doc.id)).toBe(true);
    expect(messageDialog).toHaveBeenCalledTimes(2);
    expect(messageDialog.mock.calls[1][0]).toContain('disk full');
    expect(messageDialog.mock.calls[1][1]).toMatchObject({ kind: 'error' });
  });

  it('closes a clean doc without asking', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a', hash: 'h0', mode: 'split' });

    expect(await closeDocWithPrompt(doc.id)).toBe(true);
    expect(messageDialog).not.toHaveBeenCalled();
    expect(docs.has(doc.id)).toBe(false);
  });
});

describe('confirmCloseAll', () => {
  it('asks once per dirty doc, in the order given, and skips clean ones', async () => {
    const a = createDoc({ path: '/a.md', raw: '', hash: '', mode: 'split' });
    const b = createDoc({ path: '/b.md', raw: '', hash: '', mode: 'split' });
    const c = createDoc({ path: '/c.md', raw: '', hash: '', mode: 'split' });
    a.text = 'x';
    c.text = 'y';
    messageDialog.mockResolvedValue("Don't Save");
    const shown: string[] = [];

    expect(await confirmCloseAll([c.id, b.id, a.id], (id) => shown.push(id))).toBe(true);
    expect(shown).toEqual([c.id, a.id]);
    expect(messageDialog).toHaveBeenCalledTimes(2);
  });

  it('stops at the first Cancel and closes nothing', async () => {
    const a = createDoc({ path: '/a.md', raw: '', hash: '', mode: 'split' });
    const b = createDoc({ path: '/b.md', raw: '', hash: '', mode: 'split' });
    a.text = 'x';
    b.text = 'y';
    messageDialog.mockResolvedValueOnce("Don't Save").mockResolvedValueOnce('Cancel');

    expect(await confirmCloseAll([a.id, b.id])).toBe(false);
    expect(docs.has(a.id)).toBe(true);
    expect(docs.has(b.id)).toBe(true);
  });

  it('returns true at once when nothing is dirty', async () => {
    const a = createDoc({ path: '/a.md', raw: '', hash: '', mode: 'split' });

    expect(await confirmCloseAll([a.id])).toBe(true);
    expect(messageDialog).not.toHaveBeenCalled();
  });
});

describe('closing while a save is still writing', () => {
  function heldWrite() {
    let finish: (hash: string) => void = () => {};
    write.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
    return (hash: string) => finish(hash);
  }

  it('keeps the doc open when edits made after Cmd+S are still unsaved', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'v0', hash: 'h0', mode: 'split' });
    doc.text = 'v1';
    const finish = heldWrite();
    const firstSave = saveDoc(doc.id);
    doc.text = 'v2';
    messageDialog.mockResolvedValue('Save');

    const closing = closeDocWithPrompt(doc.id);
    await vi.waitFor(() => expect(messageDialog).toHaveBeenCalled());
    finish('h1');

    expect(await firstSave).toBe(true);
    expect(await closing).toBe(false);
    expect(docs.has(doc.id)).toBe(true);
    expect(isDirty(doc)).toBe(true);
  });

  it('stops a close-all at a doc that is still dirty after its save', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'v0', hash: 'h0', mode: 'split' });
    doc.text = 'v1';
    const finish = heldWrite();
    void saveDoc(doc.id);
    doc.text = 'v2';
    messageDialog.mockResolvedValue('Save');

    const closing = confirmCloseAll([doc.id]);
    await vi.waitFor(() => expect(messageDialog).toHaveBeenCalled());
    finish('h1');

    expect(await closing).toBe(false);
  });
});

describe('saveDocAs path', () => {
  it('stores the normalised form of the chosen path', async () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'split' });
    doc.text = 'x';
    saveDialog.mockResolvedValue('/link/new.md');
    write.mockResolvedValue('h1');
    normalize.mockImplementation(async (path) => path.replace('/link/', '/real/'));

    expect(await saveDocAs(doc.id)).toBe(true);
    expect(doc.path).toBe('/real/new.md');
    expect(doc.title).toBe('new.md');
  });
});

describe('Save As and Open Recent', () => {
  it('records the normalised path chosen in Save As', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\n', hash: 'h0', mode: 'split' });
    saveDialog.mockResolvedValue('/link/b.md');
    write.mockResolvedValue('h1');
    normalize.mockImplementation(async (path) => path.replace('/link/', '/real/'));

    await saveDocAs(doc.id);

    expect(recordRecent).toHaveBeenCalledExactlyOnceWith('/real/b.md');
  });

  it('records the first save of an untitled doc from Cmd+S and from the close prompt', async () => {
    write.mockResolvedValue('h1');
    const first = createDoc({ path: null, raw: '', hash: '', mode: 'split' });
    first.text = 'x';
    saveDialog.mockResolvedValueOnce('/notes/one.md');
    await saveDoc(first.id);

    const second = createDoc({ path: null, raw: '', hash: '', mode: 'split' });
    second.text = 'y';
    saveDialog.mockResolvedValueOnce('/notes/two.md');
    messageDialog.mockResolvedValue('Save');
    await closeDocWithPrompt(second.id);

    expect(vi.mocked(recordRecent).mock.calls).toEqual([['/notes/one.md'], ['/notes/two.md']]);
  });

  it('does not wait for the record, so a slow store never holds up the save', async () => {
    vi.mocked(recordRecent).mockReturnValue(new Promise(() => {}));
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'split' });
    saveDialog.mockResolvedValue('/notes/new.md');
    write.mockResolvedValue('h1');

    const done = await Promise.race([
      saveDocAs(doc.id),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 100)),
    ]);

    expect(done).toBe(true);
  });

  it('records nothing for a plain save, a cancelled Save As or a failed write', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'a\n', hash: 'h0', mode: 'split' });
    doc.text = 'b\n';
    write.mockResolvedValue('h1');
    await saveDoc(doc.id);

    saveDialog.mockResolvedValueOnce(null);
    await saveDocAs(doc.id);

    saveDialog.mockResolvedValueOnce('/notes/c.md');
    write.mockRejectedValue('This file is read-only.');
    await expect(saveDocAs(doc.id)).rejects.toBe('This file is read-only.');

    expect(recordRecent).not.toHaveBeenCalled();
  });
});

describe('the path registry (Ruling 185)', () => {
  it('removeDoc drops the doc and releases its path', () => {
    const doc = createDoc({ path: '/notes/a.md', raw: '', hash: 'h', mode: 'edit' });
    removeDoc(doc.id);
    expect(docs.has(doc.id)).toBe(false);
    expect(releasePath).toHaveBeenCalledWith('/notes/a.md');
  });

  it('removeDoc releases nothing for an untitled doc', () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    removeDoc(doc.id);
    expect(releasePath).not.toHaveBeenCalled();
  });

  it('removeDoc keeps the claim while another tab of this window has the path', () => {
    const a = createDoc({ path: '/notes/a.md', raw: '', hash: 'h', mode: 'edit' });
    createDoc({ path: '/notes/a.md', raw: '', hash: 'h', mode: 'edit' });
    removeDoc(a.id);
    expect(releasePath).not.toHaveBeenCalled();
  });

  it('closing a doc with the prompt releases its path', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: '', hash: 'h', mode: 'edit' });
    expect(await closeDocWithPrompt(doc.id)).toBe(true);
    expect(releasePath).toHaveBeenCalledWith('/notes/a.md');
  });

  it('a cancelled close releases nothing', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: '', hash: 'h', mode: 'edit' });
    doc.text = 'edited';
    messageDialog.mockResolvedValueOnce('Cancel');
    expect(await closeDocWithPrompt(doc.id)).toBe(false);
    expect(releasePath).not.toHaveBeenCalled();
  });

  it('Save As claims the new path and releases the old one', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    saveDialog.mockResolvedValueOnce('/notes/b.md');
    write.mockResolvedValueOnce('h2');

    expect(await saveDocAs(doc.id)).toBe(true);

    expect(claimPath).toHaveBeenCalledWith('/notes/b.md');
    expect(releasePath).toHaveBeenCalledWith('/notes/a.md');
    expect(vi.mocked(claimPath).mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  });

  it('Save As onto a file another window has open is refused before writing', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    saveDialog.mockResolvedValueOnce('/notes/b.md');
    vi.mocked(claimPath).mockResolvedValueOnce('w-1');

    expect(await saveDocAs(doc.id)).toBe(false);

    expect(write).not.toHaveBeenCalled();
    expect(doc.path).toBe('/notes/a.md');
    expect(releasePath).not.toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledWith(
      expect.stringContaining('b.md is open in another window'),
      expect.objectContaining({ kind: 'error' }),
    );
  });

  it('Save As releases the new claim when the write fails', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    saveDialog.mockResolvedValueOnce('/notes/b.md');
    write.mockRejectedValueOnce(new Error('disk full'));

    await expect(saveDocAs(doc.id)).rejects.toThrow('disk full');

    expect(releasePath).toHaveBeenCalledWith('/notes/b.md');
    expect(releasePath).not.toHaveBeenCalledWith('/notes/a.md');
  });

  it('Save As onto its own path claims and releases nothing new', async () => {
    const doc = createDoc({ path: '/notes/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    saveDialog.mockResolvedValueOnce('/notes/a.md');
    write.mockResolvedValueOnce('h2');

    expect(await saveDocAs(doc.id)).toBe(true);

    expect(releasePath).not.toHaveBeenCalled();
  });

  it('an untitled doc claims its path on its first save', async () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    doc.text = 'new';
    saveDialog.mockResolvedValueOnce('/notes/new.md');
    write.mockResolvedValueOnce('h1');

    expect(await saveDoc(doc.id)).toBe(true);

    expect(claimPath).toHaveBeenCalledWith('/notes/new.md');
    expect(releasePath).not.toHaveBeenCalled();
  });

  it('claims the normalised spelling when it differs from the one chosen', async () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    saveDialog.mockResolvedValueOnce('/tmp/new.md');
    write.mockResolvedValueOnce('h1');
    // The file does not exist until written, so only the second normalise succeeds.
    normalize.mockRejectedValueOnce(new Error('missing'));
    normalize.mockResolvedValueOnce('/private/tmp/new.md');

    expect(await saveDocAs(doc.id)).toBe(true);

    expect(doc.path).toBe('/private/tmp/new.md');
    expect(claimPath).toHaveBeenCalledWith('/tmp/new.md');
    expect(claimPath).toHaveBeenCalledWith('/private/tmp/new.md');
    expect(releasePath).toHaveBeenCalledWith('/tmp/new.md');
  });
});

describe('adoptDoc (Ruling 186)', () => {
  it('inserts a handed-over doc as it is, unsaved edits and all', () => {
    const state = {
      id: 'moved-1',
      path: '/notes/a.md',
      title: 'a.md',
      text: 'edited',
      savedText: 'saved',
      lineEnding: '\r\n' as const,
      diskHash: 'h1',
      pinned: true,
      mode: 'read' as const,
      external: 'none' as const,
      diskText: null,
      lintConfigPath: null,
    };

    const doc = adoptDoc(state);

    expect(docs.get('moved-1')).toBe(doc);
    expect(doc).toEqual(state);
    expect(isDirty(doc)).toBe(true);
    expect(claimPath).not.toHaveBeenCalled();
  });
});
