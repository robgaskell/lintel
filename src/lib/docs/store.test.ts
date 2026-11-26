import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTextFile } from '../ipc';
import { save } from '@tauri-apps/plugin-dialog';
import {
  createDoc,
  docs,
  findByPath,
  isDirty,
  saveDoc,
  saveDocAs,
  untitledCounter,
} from './store.svelte';

vi.mock('../ipc', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

const write = vi.mocked(writeTextFile);
const saveDialog = vi.mocked(save);

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  write.mockReset();
  saveDialog.mockReset();
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
