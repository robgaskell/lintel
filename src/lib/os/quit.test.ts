import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTo } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { saveWindowState } from '@tauri-apps/plugin-window-state';
import { createDoc, docs, isDirty, saveDoc, trackHandoff, untitledCounter } from '../docs/store.svelte';
import { writeTextFile } from '../ipc';
import {
  listenForQuitRequests,
  NOT_RESPONDING,
  QUIT_PROGRESS,
  QUIT_REPLY,
  QUIT_REQUEST,
  quitApp,
  type QuitRequestEvent,
} from './quit';
import { forgetWindowSession, saveWindowSession } from './session';
import { docWindowLabels } from './windows';

// Events reach a listener when either side names no window, or both name the same one.
const bus = vi.hoisted(() => {
  type Listener = { event: string; label: string | null; handler: (e: { payload: unknown }) => void };
  const listeners = new Set<Listener>();
  return {
    listeners,
    deliver(event: string, payload: unknown, label: string | null) {
      const sent = JSON.parse(JSON.stringify(payload ?? null));
      for (const l of listeners) {
        if (l.event !== event || (label !== null && l.label !== null && l.label !== label)) continue;
        setTimeout(() => l.handler({ payload: sent }), 0);
      }
    },
  };
});
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async (event: string, payload?: unknown) => bus.deliver(event, payload, null)),
  emitTo: vi.fn(async (label: string, event: string, payload?: unknown) => bus.deliver(event, payload, label)),
  listen: vi.fn(
    async (
      event: string,
      handler: (e: { payload: unknown }) => void,
      options?: { target?: { label: string } },
    ) => {
      const listener = { event, handler, label: options?.target?.label ?? null };
      bus.listeners.add(listener);
      return () => bus.listeners.delete(listener);
    },
  ),
}));
const win = vi.hoisted(() => ({
  label: 'main',
  isMinimized: vi.fn(async () => false),
  unminimize: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  setFocus: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));
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
vi.mock('@tauri-apps/plugin-process', () => ({
  exit: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-window-state', () => ({
  saveWindowState: vi.fn(async () => {}),
  StateFlags: { SIZE: 1, POSITION: 2, MAXIMIZED: 4 },
}));
vi.mock('./session', () => ({
  saveWindowSession: vi.fn(async () => {}),
  forgetWindowSession: vi.fn(async () => {}),
}));
vi.mock('./windows', () => ({ docWindowLabels: vi.fn(async () => ['main']) }));
vi.mock('./open', () => ({
  requireWorkspace: () => ({ docIdsInOrder: () => [], activate: () => {} }),
}));

const messageDialog = vi.mocked(message);
const exitApp = vi.mocked(exit);
const writeFile = vi.mocked(writeTextFile);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function dirtyDoc(path: string) {
  const doc = createDoc({ path, raw: '', hash: '', mode: 'split' });
  doc.text = 'changed';
  return doc;
}

// The real request handler, as it runs in window `label`.
function windowAnswering(label: string): () => void {
  win.label = label;
  const stop = listenForQuitRequests();
  win.label = 'main';
  return stop;
}

// A window that answers each request with `reply`, or not at all.
function fakeWindow(label: string, reply: (requestId: string) => void) {
  bus.listeners.add({
    event: QUIT_REQUEST,
    label,
    handler: ({ payload }) => reply((payload as QuitRequestEvent).requestId),
  });
}

function send(event: string, payload: unknown) {
  bus.deliver(event, payload, null);
}

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  messageDialog.mockReset();
  exitApp.mockClear();
  writeFile.mockReset();
  bus.listeners.clear();
  win.label = 'main';
  vi.mocked(docWindowLabels).mockResolvedValue(['main']);
  vi.mocked(saveWindowSession).mockClear();
  vi.mocked(forgetWindowSession).mockClear();
  vi.mocked(saveWindowState).mockClear();
  vi.mocked(emitTo).mockClear();
  for (const fn of [win.isMinimized, win.unminimize, win.show, win.setFocus]) fn.mockClear();
});

afterEach(() => vi.useRealTimers());

describe('quitApp across windows (Ruling 211)', () => {
  it('saves each window once and exits once when every window answers yes, forgetting none', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    windowAnswering('w-1');

    await quitApp();

    expect(vi.mocked(saveWindowSession).mock.calls).toEqual([['main'], ['w-1']]);
    expect(exitApp).toHaveBeenCalledTimes(1);
    expect(exitApp).toHaveBeenCalledWith(0);
    expect(forgetWindowSession).not.toHaveBeenCalled();
    expect(saveWindowState).toHaveBeenCalledWith(1 | 2 | 4);
  });

  it('does not exit when the second window answers no', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    fakeWindow('w-1', (requestId) => send(QUIT_REPLY, { requestId, label: 'w-1', ok: false }));

    await quitApp();

    expect(exitApp).not.toHaveBeenCalled();
    expect(forgetWindowSession).not.toHaveBeenCalled();
  });

  it('asks no other window once this one is cancelled', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    windowAnswering('w-1');
    dirtyDoc('/a.md');
    messageDialog.mockResolvedValue('Cancel');

    await quitApp();

    expect(emitTo).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('answers a request with its own prompts, brought forward first, and says no on Cancel', async () => {
    windowAnswering('w-1');
    const a = dirtyDoc('/a.md');
    messageDialog.mockResolvedValue('Cancel');
    const replies: unknown[] = [];
    bus.listeners.add({ event: QUIT_REPLY, label: null, handler: ({ payload }) => replies.push(payload) });

    await emitTo('w-1', QUIT_REQUEST, { requestId: 'r1' });
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    expect(replies[0]).toEqual({ requestId: 'r1', label: 'w-1', ok: false });
    expect(String(messageDialog.mock.calls[0][0])).toContain('a.md');
    expect(win.setFocus.mock.invocationCallOrder[0]).toBeLessThan(messageDialog.mock.invocationCallOrder[0]);
    expect(saveWindowSession).not.toHaveBeenCalled();
    expect(docs.has(a.id)).toBe(true);
  });

  it('does not bring forward a window with nothing to ask', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    windowAnswering('w-1');

    await quitApp();

    expect(win.show).not.toHaveBeenCalled();
    expect(win.setFocus).not.toHaveBeenCalled();
  });

  it('only the window named hears a request', async () => {
    windowAnswering('w-1');
    windowAnswering('w-2');

    await emitTo('w-1', QUIT_REQUEST, { requestId: 'r2' });
    await vi.waitFor(() => expect(saveWindowSession).toHaveBeenCalled());
    await flush();

    expect(vi.mocked(saveWindowSession).mock.calls).toEqual([['w-1']]);
  });

  it('asks whether to quit anyway when a window says nothing for 5 s', async () => {
    vi.useFakeTimers();
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    messageDialog.mockResolvedValue('Quit Anyway');

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(4999);
    expect(messageDialog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await quitting;

    expect(messageDialog).toHaveBeenCalledWith(
      NOT_RESPONDING,
      expect.objectContaining({ buttons: { ok: 'Quit Anyway', cancel: 'Cancel' } }),
    );
    expect(exitApp).toHaveBeenCalledWith(0);
  });

  it('stops the quit on Cancel at the not-responding dialog, and Cmd+Q works again', async () => {
    vi.useFakeTimers();
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    messageDialog.mockResolvedValue('Cancel');

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(5000);
    await quitting;
    expect(exitApp).not.toHaveBeenCalled();

    windowAnswering('w-1');
    const again = quitApp();
    await vi.advanceTimersByTimeAsync(10);
    await again;
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('waits without a limit while the other window shows a prompt, then 5 s again', async () => {
    vi.useFakeTimers();
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    let request = '';
    fakeWindow('w-1', (requestId) => {
      request = requestId;
      send(QUIT_PROGRESS, { requestId, label: 'w-1', prompting: true });
    });

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messageDialog).not.toHaveBeenCalled();

    send(QUIT_PROGRESS, { requestId: request, label: 'w-1', prompting: false });
    await vi.advanceTimersByTimeAsync(4000);
    send(QUIT_REPLY, { requestId: request, label: 'w-1', ok: true });
    await vi.advanceTimersByTimeAsync(10);
    await quitting;

    expect(messageDialog).not.toHaveBeenCalled();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });
});

describe('quitApp', () => {
  it('waits for a hand-over to settle, then asks about a doc that came back (Ruling 213)', async () => {
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));
    messageDialog.mockResolvedValue('Cancel');

    const quitting = quitApp();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exitApp).not.toHaveBeenCalled();
    dirtyDoc('/back.md');
    settle();
    await quitting;

    expect(messageDialog).toHaveBeenCalledWith(expect.stringContaining('back.md'), expect.anything());
    expect(exitApp).not.toHaveBeenCalled();
  });

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
