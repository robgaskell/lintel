import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from '@tauri-apps/plugin-dialog';
import { createDoc, docs, untitledCounter } from '../docs/store.svelte';
import { closeTabOrWindow, handleCloseRequested } from './window';

vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn(),
  save: vi.fn(),
}));

const messageDialog = vi.mocked(message);

function dirtyDoc(path: string) {
  const doc = createDoc({ path, raw: '', hash: '', mode: 'split' });
  doc.text = 'changed';
  return doc;
}

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  messageDialog.mockReset();
});

describe('handleCloseRequested', () => {
  it('stops the window closing when the user cancels', async () => {
    const a = dirtyDoc('/a.md');
    const event = { preventDefault: vi.fn() };
    const workspace = { docIdsInOrder: () => [a.id], activate: vi.fn() };
    messageDialog.mockResolvedValue('Cancel');

    await handleCloseRequested(event, workspace);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(workspace.activate).toHaveBeenCalledWith(a.id);
  });

  it('lets the window close once every dirty doc is answered', async () => {
    const a = dirtyDoc('/a.md');
    const b = dirtyDoc('/b.md');
    const event = { preventDefault: vi.fn() };
    messageDialog.mockResolvedValue("Don't Save");

    await handleCloseRequested(event, { docIdsInOrder: () => [a.id, b.id], activate: vi.fn() });

    expect(messageDialog).toHaveBeenCalledTimes(2);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the window open and shows the error when prompting fails', async () => {
    const a = dirtyDoc('/a.md');
    const event = { preventDefault: vi.fn() };
    messageDialog.mockRejectedValueOnce(new Error('dialog broke')).mockResolvedValue('Ok');

    await handleCloseRequested(event, { docIdsInOrder: () => [a.id], activate: vi.fn() });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(String(messageDialog.mock.calls.at(-1)?.[0])).toContain('dialog broke');
  });
});

describe('closeTabOrWindow', () => {
  it('closes the active tab when there is one', async () => {
    const workspace = { activeDocId: () => 'doc-1', closeDoc: vi.fn(async () => true) };
    const win = { destroy: vi.fn(async () => {}) };

    await closeTabOrWindow(workspace, win);

    expect(workspace.closeDoc).toHaveBeenCalledWith('doc-1');
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('closes the window when no tab is open', async () => {
    const workspace = { activeDocId: () => null, closeDoc: vi.fn(async () => true) };
    const win = { destroy: vi.fn(async () => {}) };

    await closeTabOrWindow(workspace, win);

    expect(win.destroy).toHaveBeenCalled();
    expect(workspace.closeDoc).not.toHaveBeenCalled();
  });
});
