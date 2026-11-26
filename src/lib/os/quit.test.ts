import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { createDoc, docs, isDirty, saveDoc, untitledCounter } from '../docs/store.svelte';
import { writeTextFile } from '../ipc';
import { quitApp } from './quit';

vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-process', () => ({
  exit: vi.fn(async () => {}),
}));

const messageDialog = vi.mocked(message);
const exitApp = vi.mocked(exit);
const writeFile = vi.mocked(writeTextFile);

function dirtyDoc(path: string) {
  const doc = createDoc({ path, raw: '', hash: '', mode: 'split' });
  doc.text = 'changed';
  return doc;
}

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  messageDialog.mockReset();
  exitApp.mockClear();
  writeFile.mockReset();
});

describe('quitApp', () => {
  it('stays open when the user cancels', async () => {
    dirtyDoc('/a.md');
    messageDialog.mockResolvedValue('Cancel');

    await quitApp();

    expect(exitApp).not.toHaveBeenCalled();
  });

  it("exits once after Don't Save", async () => {
    dirtyDoc('/a.md');
    messageDialog.mockResolvedValue("Don't Save");

    await quitApp();

    expect(exitApp).toHaveBeenCalledTimes(1);
    expect(exitApp).toHaveBeenCalledWith(0);
  });

  it('closes nothing when a later doc is cancelled', async () => {
    const a = dirtyDoc('/a.md');
    const b = dirtyDoc('/b.md');
    messageDialog.mockResolvedValueOnce("Don't Save").mockResolvedValueOnce('Cancel');

    await quitApp();

    expect(exitApp).not.toHaveBeenCalled();
    expect(docs.has(a.id)).toBe(true);
    expect(docs.has(b.id)).toBe(true);
  });

  it('asks in tab order and shows each doc before asking', async () => {
    const a = dirtyDoc('/a.md');
    const b = dirtyDoc('/b.md');
    const activate = vi.fn();
    messageDialog.mockResolvedValue("Don't Save");

    await quitApp({ docIdsInOrder: () => [b.id, a.id], activate });

    expect(activate.mock.calls).toEqual([[b.id], [a.id]]);
    expect(String(messageDialog.mock.calls[0][0])).toContain('b.md');
  });

  it('stays open and shows the error when prompting fails', async () => {
    dirtyDoc('/a.md');
    messageDialog.mockRejectedValueOnce(new Error('dialog broke')).mockResolvedValue('Ok');

    await quitApp();

    expect(exitApp).not.toHaveBeenCalled();
    expect(String(messageDialog.mock.calls.at(-1)?.[0])).toContain('dialog broke');
  });

  it('asks only once when quit is chosen twice while a prompt is open', async () => {
    dirtyDoc('/a.md');
    messageDialog.mockResolvedValue("Don't Save");

    await Promise.all([quitApp(), quitApp()]);

    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('saves, then exits, when the user picks Save', async () => {
    const a = dirtyDoc('/a.md');
    messageDialog.mockResolvedValue('Save');
    writeFile.mockResolvedValue('hash-1');

    await quitApp();

    expect(writeFile).toHaveBeenCalledWith('/a.md', 'changed');
    expect(isDirty(a)).toBe(false);
    expect(exitApp).toHaveBeenCalledWith(0);
  });

  it('stays open when the save chosen at the prompt fails', async () => {
    dirtyDoc('/a.md');
    messageDialog.mockResolvedValueOnce('Save').mockResolvedValue('Ok');
    writeFile.mockRejectedValue(new Error('disk full'));

    await quitApp();

    expect(exitApp).not.toHaveBeenCalled();
    expect(String(messageDialog.mock.calls.at(-1)?.[0])).toContain('disk full');
  });

  it('waits for a save already running before asking', async () => {
    const a = dirtyDoc('/a.md');
    let finishWrite!: (hash: string) => void;
    writeFile.mockReturnValueOnce(new Promise((resolve) => (finishWrite = resolve)));
    const saving = saveDoc(a.id);

    const quitting = quitApp();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messageDialog).not.toHaveBeenCalled();

    finishWrite('hash-1');
    await saving;
    await quitting;
    expect(messageDialog).not.toHaveBeenCalled();
    expect(exitApp).toHaveBeenCalledWith(0);
  });
});
