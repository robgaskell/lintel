import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '../ipc';
import { docs, untitledCounter } from '../docs/store.svelte';
import { newUntitled, openPaths, setWorkspace } from './open';

vi.mock('../ipc', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn(),
  save: vi.fn(),
}));

const read = vi.mocked(readTextFile);
const messageDialog = vi.mocked(message);
const workspace = { openDoc: vi.fn(), activate: vi.fn() };

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  read.mockReset();
  read.mockImplementation(async (path) => ({ text: `# ${path}\n`, hash: `hash-${path}` }));
  messageDialog.mockReset();
  workspace.openDoc.mockReset();
  workspace.activate.mockReset();
  setWorkspace(workspace);
});

describe('openPaths', () => {
  it('creates one doc when the same path is given twice', async () => {
    await openPaths(['/a.md', '/a.md']);

    expect(docs.size).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(workspace.openDoc).toHaveBeenCalledTimes(1);
  });

  it('activates an already-open doc without reading the file again', async () => {
    await openPaths(['/a.md']);
    const [doc] = docs.values();
    read.mockClear();
    workspace.openDoc.mockClear();

    await openPaths(['/a.md']);

    expect(read).not.toHaveBeenCalled();
    expect(workspace.openDoc).not.toHaveBeenCalled();
    expect(workspace.activate).toHaveBeenCalledWith(doc.id);
  });

  it('opens new docs in split mode with the file text and hash', async () => {
    await openPaths(['/notes/b.md']);

    const [doc] = docs.values();
    expect(doc.path).toBe('/notes/b.md');
    expect(doc.title).toBe('b.md');
    expect(doc.text).toBe('# /notes/b.md\n');
    expect(doc.diskHash).toBe('hash-/notes/b.md');
    expect(doc.mode).toBe('split');
    expect(workspace.openDoc).toHaveBeenCalledWith(doc);
  });

  it('reports an unreadable file and still opens the rest', async () => {
    read.mockImplementation(async (path) => {
      if (path === '/bad.md') throw 'Lintel opens UTF-8 text files only.';
      return { text: 'ok', hash: 'h' };
    });

    await openPaths(['/bad.md', '/good.md']);

    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(messageDialog.mock.calls[0][0]).toContain('bad.md');
    expect(messageDialog.mock.calls[0][0]).toContain('Lintel opens UTF-8 text files only.');
    expect(messageDialog.mock.calls[0][1]).toMatchObject({ kind: 'error' });
    expect([...docs.values()].map((d) => d.path)).toEqual(['/good.md']);
  });
});

describe('newUntitled', () => {
  it('makes Untitled-1 first, in split mode, and opens it', () => {
    newUntitled();

    const [doc] = docs.values();
    expect(doc.title).toBe('Untitled-1');
    expect(doc.path).toBeNull();
    expect(doc.mode).toBe('split');
    expect(untitledCounter.n).toBe(1);
    expect(workspace.openDoc).toHaveBeenCalledWith(doc);
  });

  it('numbers the next one Untitled-2', () => {
    newUntitled();
    newUntitled();

    expect([...docs.values()].map((d) => d.title)).toEqual(['Untitled-1', 'Untitled-2']);
  });
});
