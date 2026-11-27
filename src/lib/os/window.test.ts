import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from '@tauri-apps/plugin-dialog';
import { createDoc, docs, trackHandoff, untitledCounter } from '../docs/store.svelte';
import { closeTabOrWindow, handleCloseRequested } from './window';

vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => 1),
  completeHandoff: vi.fn(async () => true),
  cancelHandoff: vi.fn(async () => true),
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
  it('waits for a hand-over to settle, then asks about a doc that came back (Ruling 213)', async () => {
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    const event = { preventDefault: vi.fn() };
    messageDialog.mockResolvedValue('Cancel');

    const closing = handleCloseRequested(event, { docIdsInOrder: () => [...docs.keys()], activate: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const back = dirtyDoc('/back.md');
    settle();
    await closing;

    expect(messageDialog).toHaveBeenCalledWith(expect.stringContaining('back.md'), expect.anything());
    expect(event.preventDefault).toHaveBeenCalled();
    expect(docs.has(back.id)).toBe(true);
  });

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
