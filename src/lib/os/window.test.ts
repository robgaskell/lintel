import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from '@tauri-apps/plugin-dialog';
import { adoptDoc, createDoc, docs, trackHandoff, untitledCounter } from '../docs/store.svelte';
import { forgetWindowSessionLater, saveWindowSession } from './session';
import { closeTabOrWindow, handleCloseRequested } from './window';
import { docWindowLabels } from './windows';
import { readyForOpenFilesAgain } from './open';

vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  frontendReady: vi.fn(async () => []),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => 1),
  completeHandoff: vi.fn(async () => true),
  cancelHandoff: vi.fn(async () => true),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('./session', () => ({
  forgetWindowSessionLater: vi.fn(async () => {}),
  saveWindowSession: vi.fn(async () => {}),
}));
vi.mock('./windows', () => ({ docWindowLabels: vi.fn(async () => ['main']) }));
vi.mock('./open', () => ({ readyForOpenFilesAgain: vi.fn() }));

const messageDialog = vi.mocked(message);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function dirtyDoc(path: string) {
  const doc = createDoc({ path, raw: '', hash: '', mode: 'split' });
  doc.text = 'changed';
  return doc;
}

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  messageDialog.mockReset();
  vi.mocked(forgetWindowSessionLater).mockClear();
  vi.mocked(saveWindowSession).mockClear();
  vi.mocked(readyForOpenFilesAgain).mockClear();
  vi.mocked(docWindowLabels).mockResolvedValue(['main']);
});

const noTabs = { docIdsInOrder: () => [], activate: vi.fn() };

describe('the session when a window closes (spec: Session lifetime, Ruling 209)', () => {
  it('closing window w-1 while main is open saves it, then has it forgotten 2 s on (Ruling 220)', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);

    await handleCloseRequested({ preventDefault: vi.fn() }, noTabs, 'w-1');

    expect(forgetWindowSessionLater).toHaveBeenCalledWith('w-1');
    // Saved first: if main closes within the 2 s too, the session is kept as on a quit.
    expect(saveWindowSession).toHaveBeenCalledWith('w-1');
    expect(vi.mocked(saveWindowSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(forgetWindowSessionLater).mock.invocationCallOrder[0],
    );
  });

  it('keeps the session of the last window, saved for the next launch', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['w-1']);

    await handleCloseRequested({ preventDefault: vi.fn() }, noTabs, 'w-1');

    expect(saveWindowSession).toHaveBeenCalledWith('w-1');
    expect(forgetWindowSessionLater).not.toHaveBeenCalled();
  });

  it('touches no session when the close is cancelled', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    const a = dirtyDoc('/a.md');
    messageDialog.mockResolvedValue('Cancel');

    await handleCloseRequested({ preventDefault: vi.fn() }, { docIdsInOrder: () => [a.id], activate: vi.fn() }, 'w-1');

    expect(forgetWindowSessionLater).not.toHaveBeenCalled();
    expect(saveWindowSession).not.toHaveBeenCalled();
  });

  it('forgets an empty window closed with Cmd+W before destroying it', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    const win = { destroy: vi.fn(async () => {}) };

    await closeTabOrWindow({ activeDocId: () => null, closeDoc: vi.fn() }, win, 'w-1');

    expect(forgetWindowSessionLater).toHaveBeenCalledWith('w-1');
    expect(vi.mocked(forgetWindowSessionLater).mock.invocationCallOrder[0]).toBeLessThan(
      win.destroy.mock.invocationCallOrder[0],
    );
  });

  it('still closes the window when the session cannot be written', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    vi.mocked(forgetWindowSessionLater).mockRejectedValueOnce(new Error('store down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = { preventDefault: vi.fn() };

    await handleCloseRequested(event, noTabs, 'w-1');

    expect(event.preventDefault).not.toHaveBeenCalled();
    error.mockRestore();
  });
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

  it('never asks about a doc that moved away while it waited, and closes (Ruling 217)', async () => {
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    const moving = dirtyDoc('/moving.md');
    const event = { preventDefault: vi.fn() };

    const closing = handleCloseRequested(event, { docIdsInOrder: () => [...docs.keys()], activate: vi.fn() });
    await tick();
    docs.delete(moving.id);
    settle();
    await closing;

    expect(messageDialog).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('asks once about a doc that comes back while it asks about another, then closes (Ruling 217)', async () => {
    const a = dirtyDoc('/a.md');
    let answer: (choice: string) => void = () => {};
    messageDialog.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    messageDialog.mockResolvedValue("Don't Save");
    const event = { preventDefault: vi.fn() };

    const closing = handleCloseRequested(event, { docIdsInOrder: () => [...docs.keys()], activate: vi.fn() });
    await vi.waitFor(() => expect(messageDialog).toHaveBeenCalledOnce());
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    const back = dirtyDoc('/back.md');
    settle();
    answer("Don't Save");
    await closing;

    expect(messageDialog.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining('a.md'),
      expect.stringContaining('back.md'),
    ]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(docs.has(a.id) && docs.has(back.id)).toBe(true);
  });

  it('asks about a doc that left during its turn and came back with the same id (Ruling 235)', async () => {
    const a = dirtyDoc('/a.md');
    const y = dirtyDoc('/y.md');
    let answer: (choice: string) => void = () => {};
    messageDialog.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    messageDialog.mockResolvedValue('Cancel');
    const event = { preventDefault: vi.fn() };
    const order = [a.id, y.id];

    const closing = handleCloseRequested(event, { docIdsInOrder: () => order, activate: vi.fn() });
    await vi.waitFor(() => expect(messageDialog).toHaveBeenCalledOnce());
    // y leaves on a hand-over while a's prompt is open, which then fails and brings y back.
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    const leaving = { ...y };
    docs.delete(y.id);
    answer("Don't Save");
    await tick();
    adoptDoc(leaving);
    settle();
    await closing;

    expect(messageDialog.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining('a.md'),
      expect.stringContaining('y.md'),
    ]);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('waits for a hand-over that starts while its prompt is open before it closes (Ruling 216)', async () => {
    const x = dirtyDoc('/x.md');
    let answer: (choice: string) => void = () => {};
    messageDialog.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const event = { preventDefault: vi.fn() };
    let closed = false;

    const closing = handleCloseRequested(event, { docIdsInOrder: () => [...docs.keys()], activate: vi.fn() }).then(
      () => (closed = true),
    );
    await vi.waitFor(() => expect(messageDialog).toHaveBeenCalledOnce());
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    docs.delete(x.id);
    answer("Don't Save");
    await tick();
    expect(closed).toBe(false);

    settle();
    await closing;
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledOnce();
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

  it('takes files opened from outside again once the close is cancelled or fails (Ruling 242)', async () => {
    const a = dirtyDoc('/a.md');
    const workspace = { docIdsInOrder: () => [a.id], activate: vi.fn() };
    messageDialog.mockResolvedValueOnce('Cancel');
    await handleCloseRequested({ preventDefault: vi.fn() }, workspace);
    expect(readyForOpenFilesAgain).toHaveBeenCalledOnce();

    messageDialog.mockRejectedValueOnce(new Error('dialog broke')).mockResolvedValue('Ok');
    await handleCloseRequested({ preventDefault: vi.fn() }, workspace);
    expect(readyForOpenFilesAgain).toHaveBeenCalledTimes(2);

    messageDialog.mockResolvedValue("Don't Save");
    await handleCloseRequested({ preventDefault: vi.fn() }, workspace);
    expect(readyForOpenFilesAgain).toHaveBeenCalledTimes(2);
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
    const doc = dirtyDoc('/a.md');
    const workspace = { activeDocId: () => doc.id, closeDoc: vi.fn(async () => true) };
    const win = { destroy: vi.fn(async () => {}) };

    await closeTabOrWindow(workspace, win);

    expect(workspace.closeDoc).toHaveBeenCalledWith(doc.id);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('asks nothing about a tab that moves away meanwhile, and closes the window it empties (Ruling 217)', async () => {
    const doc = dirtyDoc('/moving.md');
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    const workspace = { activeDocId: () => (docs.has(doc.id) ? doc.id : null), closeDoc: vi.fn(async () => true) };
    const win = { destroy: vi.fn(async () => {}) };

    const closing = closeTabOrWindow(workspace, win, 'w-1');
    await tick();
    docs.delete(doc.id);
    settle();
    await closing;

    expect(workspace.closeDoc).not.toHaveBeenCalled();
    expect(win.destroy).toHaveBeenCalled();
  });

  it('keeps the window when other tabs remain after the active one moved away', async () => {
    const doc = dirtyDoc('/moving.md');
    const other = dirtyDoc('/other.md');
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    const workspace = { activeDocId: () => (docs.has(doc.id) ? doc.id : other.id), closeDoc: vi.fn(async () => true) };
    const win = { destroy: vi.fn(async () => {}) };

    const closing = closeTabOrWindow(workspace, win, 'w-1');
    await tick();
    docs.delete(doc.id);
    settle();
    await closing;

    expect(workspace.closeDoc).not.toHaveBeenCalled();
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
