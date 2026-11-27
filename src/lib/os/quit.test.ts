import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTo } from '@tauri-apps/api/event';
import { message, save } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { saveWindowState } from '@tauri-apps/plugin-window-state';
import { createDoc, docs, isDirty, saveDoc, trackHandoff, untitledCounter } from '../docs/store.svelte';
import { writeTextFile } from '../ipc';
import {
  HANDOFF_STUCK,
  listenForQuitRequests,
  NOT_RESPONDING,
  QUIT_PROGRESS,
  QUIT_REPLY,
  QUIT_REQUEST,
  QUIT_ROUND,
  quitApp,
  runQuitRounds,
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
// What Rust reports about hand-overs app-wide.
const status = vi.hoisted(() => ({
  current: { pending: 0, completed: 0, adopters: [] as string[] },
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
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  frontendReady: vi.fn(async () => []),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => 1),
  completeHandoff: vi.fn(async () => true),
  cancelHandoff: vi.fn(async () => true),
  handoffStatus: vi.fn(async () => status.current),
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
  status.current = { pending: 0, completed: 0, adopters: [] };
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
    // Size is left to Rust, which a docked Web Inspector cannot skew (Ruling 222).
    expect(saveWindowState).toHaveBeenCalledWith(2 | 4);
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

    expect(replies[0]).toEqual({ requestId: 'r1', label: 'w-1', ok: false, asked: true });
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
      // Cancel first, so it is the default button and Return keeps the app (Ruling 219).
      expect.objectContaining({ buttons: { ok: 'Cancel', cancel: 'Quit Anyway' } }),
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

  it('keeps waiting while the other window beats during its prompt (Ruling 235)', async () => {
    vi.useFakeTimers();
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    let request = '';
    let beat: ReturnType<typeof setInterval> | undefined;
    fakeWindow('w-1', (requestId) => {
      // The sweep before exit asks again; by then nothing has changed.
      if (request) return send(QUIT_REPLY, { requestId, label: 'w-1', ok: true });
      request = requestId;
      const progress = () => send(QUIT_PROGRESS, { requestId, label: 'w-1', prompting: true });
      progress();
      beat = setInterval(progress, 2000);
    });

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messageDialog).not.toHaveBeenCalled();

    clearInterval(beat);
    send(QUIT_REPLY, { requestId: request, label: 'w-1', ok: true });
    await vi.advanceTimersByTimeAsync(10);
    await quitting;

    expect(messageDialog).not.toHaveBeenCalled();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('reports a window that said its prompt was open and then fell silent (Ruling 235)', async () => {
    vi.useFakeTimers();
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    messageDialog.mockResolvedValue('Cancel');
    fakeWindow('w-1', (requestId) => send(QUIT_PROGRESS, { requestId, label: 'w-1', prompting: true }));

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(4900);
    expect(messageDialog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await quitting;

    expect(messageDialog).toHaveBeenCalledWith(NOT_RESPONDING, expect.anything());
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('quits from the not-responding alert only on Quit Anyway; Return and Escape keep the app (Ruling 235)', async () => {
    vi.useFakeTimers();
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    // Escape or closing the alert answers its Cancel button, or nothing at all.
    for (const answer of ['Cancel', undefined, null, 'Ok']) {
      messageDialog.mockReset();
      messageDialog.mockResolvedValue(answer as never);
      const quitting = quitApp();
      await vi.advanceTimersByTimeAsync(5100);
      await quitting;
      expect(exitApp, String(answer)).not.toHaveBeenCalled();
    }
    const options = messageDialog.mock.calls[0][1] as { buttons: { ok: string; cancel: string } };
    // AppKit gives the button titled Cancel the Escape key and no default; it must come first,
    // or the other button becomes the default and Return quits.
    expect(options.buttons).toEqual({ ok: 'Cancel', cancel: 'Quit Anyway' });

    messageDialog.mockResolvedValue('Quit Anyway');
    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(5100);
    await quitting;
    expect(exitApp).toHaveBeenCalledTimes(1);
  });
});

describe('a quit round and hand-overs (Ruling 235)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('waits until no hand-over is pending app-wide, then asks about the doc that landed', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-c', 'w-b']);
    windowAnswering('w-c');
    windowAnswering('w-b');
    status.current = { pending: 1, completed: 0, adopters: [] };
    messageDialog.mockResolvedValue('Cancel');

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(3000);
    expect(exitApp).not.toHaveBeenCalled();
    // The hand-over w-b -> w-c completes and the doc lands dirty in w-c.
    dirtyDoc('/landed.md');
    status.current = { pending: 0, completed: 1, adopters: ['w-c'] };
    await vi.advanceTimersByTimeAsync(1000);
    await quitting;

    expect(String(messageDialog.mock.calls[0]?.[0])).toContain('landed.md');
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('asks a window that took a doc in after it answered again, and only about that doc', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-c', 'w-b']);
    windowAnswering('w-c');
    dirtyDoc('/main.md');
    // w-b's hand-over to w-c completes while w-b is asked, after w-c has answered ok.
    fakeWindow('w-b', (requestId) => {
      dirtyDoc('/landed.md');
      status.current = { pending: 0, completed: 1, adopters: ['w-c'] };
      send(QUIT_REPLY, { requestId, label: 'w-b', ok: true });
    });
    messageDialog.mockResolvedValueOnce("Don't Save").mockResolvedValue('Cancel');

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(1000);
    await quitting;

    expect(messageDialog.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining('main.md'),
      expect.stringContaining('landed.md'),
    ]);
    expect(exitApp).not.toHaveBeenCalled();
  });
});

describe('a window answering a quit stays seen as alive (Ruling 219)', () => {
  type Progress = { requestId: string; label: string; prompting: boolean };
  let progress: Progress[];
  let replies: unknown[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    progress = [];
    replies = [];
    bus.listeners.add({ event: QUIT_PROGRESS, label: null, handler: ({ payload }) => progress.push(payload as Progress) });
    bus.listeners.add({ event: QUIT_REPLY, label: null, handler: ({ payload }) => replies.push(payload) });
  });

  const of = (id: string) => progress.filter((p) => p.requestId === id);

  it('acknowledges at once and beats every 2 s while a Save As dialog is open', async () => {
    windowAnswering('w-1');
    const untitled = createDoc({ path: null, raw: '', hash: '', mode: 'split' });
    untitled.text = 'draft';
    let chooseNothing: (path: string | null) => void = () => {};
    vi.mocked(save).mockReturnValueOnce(new Promise((resolve) => (chooseNothing = resolve)));
    const saving = saveDoc(untitled.id);

    await emitTo('w-1', QUIT_REQUEST, { requestId: 'r1' });
    await vi.advanceTimersByTimeAsync(1);
    expect(of('r1')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);

    expect(of('r1').length).toBeGreaterThanOrEqual(4);
    expect(replies).toEqual([]);
    messageDialog.mockResolvedValue('Cancel');
    chooseNothing(null);
    await saving;
    await vi.advanceTimersByTimeAsync(10);
    expect(replies).toEqual([expect.objectContaining({ requestId: 'r1', label: 'w-1', ok: false })]);
  });

  it('beats every 2 s while a hand-over is running, then answers', async () => {
    windowAnswering('w-1');
    let settle: () => void = () => {};
    trackHandoff(new Promise<void>((resolve) => (settle = resolve)));

    await emitTo('w-1', QUIT_REQUEST, { requestId: 'r1' });
    await vi.advanceTimersByTimeAsync(9000);
    expect(of('r1').length).toBeGreaterThanOrEqual(5);
    expect(replies).toEqual([]);

    settle();
    await vi.advanceTimersByTimeAsync(10);
    expect(replies).toEqual([expect.objectContaining({ requestId: 'r1', label: 'w-1', ok: true })]);
    const count = progress.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(progress).toHaveLength(count);
  });

  it('says its prompt is open, so the asker waits as long as the user takes', async () => {
    windowAnswering('w-1');
    dirtyDoc('/a.md');
    let answer: (button: string) => void = () => {};
    messageDialog.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);

    await emitTo('w-1', QUIT_REQUEST, { requestId: 'r1' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(of('r1').some((p) => p.prompting)).toBe(true);
    expect(of('r1').at(-1)?.prompting).toBe(true);
    answer("Don't Save");
    await vi.advanceTimersByTimeAsync(10);
    expect(replies).toEqual([expect.objectContaining({ requestId: 'r1', label: 'w-1', ok: true })]);
  });

  it('tells a second asker that joins an open prompt that the prompt is open', async () => {
    windowAnswering('main');
    vi.mocked(docWindowLabels).mockResolvedValue(['main']);
    dirtyDoc('/a.md');
    let answer: (button: string) => void = () => {};
    messageDialog.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(10);

    await emitTo('main', QUIT_REQUEST, { requestId: 'r2' });
    await vi.advanceTimersByTimeAsync(10);

    expect(of('r2').some((p) => p.prompting)).toBe(true);
    answer('Cancel');
    await vi.advanceTimersByTimeAsync(10);
    await quitting;
    expect(replies).toEqual([expect.objectContaining({ requestId: 'r2', label: 'main', ok: false })]);
  });

  it('a second Cmd+Q in a window answering a quit joins that answer and starts no round', async () => {
    windowAnswering('w-1');
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    dirtyDoc('/a.md');
    let answer: (button: string) => void = () => {};
    messageDialog.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
    await emitTo('w-1', QUIT_REQUEST, { requestId: 'r1' });
    await vi.advanceTimersByTimeAsync(10);
    vi.mocked(emitTo).mockClear();

    win.label = 'w-1';
    const second = quitApp();
    win.label = 'main';
    answer("Don't Save");
    await vi.advanceTimersByTimeAsync(10);
    await second;

    expect(emitTo).not.toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();
    expect(replies).toEqual([expect.objectContaining({ requestId: 'r1', label: 'w-1', ok: true })]);
  });

  it('a Cmd+Q while another window runs a quit round joins it, until that round stops', async () => {
    windowAnswering('w-1');
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    send(QUIT_ROUND, { label: 'main', running: true });
    await vi.advanceTimersByTimeAsync(1);

    win.label = 'w-1';
    await quitApp();
    expect(emitTo).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();

    send(QUIT_ROUND, { label: 'main', running: false });
    await vi.advanceTimersByTimeAsync(1);
    windowAnswering('main');
    win.label = 'w-1';
    const own = quitApp();
    await vi.advanceTimersByTimeAsync(10);
    await own;
    expect(emitTo).toHaveBeenCalledWith('main', QUIT_REQUEST, expect.anything());
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('starts its own round when the window that ran one has closed', async () => {
    windowAnswering('w-1');
    send(QUIT_ROUND, { label: 'w-9', running: true });
    await vi.advanceTimersByTimeAsync(1);
    vi.mocked(docWindowLabels).mockResolvedValue(['w-1']);

    win.label = 'w-1';
    const own = quitApp();
    await vi.advanceTimersByTimeAsync(10);
    await own;
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

describe('a quit round before exit (Ruling 237)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('cancels the quit and says so when a hand-over never settles, never exiting', async () => {
    dirtyDoc('/a.md');
    status.current = { pending: 1, completed: 0, adopters: [] };
    messageDialog.mockResolvedValue("Don't Save");

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(70_000);
    await quitting;

    expect(messageDialog).toHaveBeenCalledWith(HANDOFF_STUCK, expect.objectContaining({ kind: 'error' }));
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('asks the quitting window again about a doc typed in while another window was asked', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-b']);
    const a = dirtyDoc('/a.md');
    // w-b's prompt is open while the user types in main's a.md, then w-b answers.
    fakeWindow('w-b', (requestId) => {
      a.text = 'typed after the answer';
      send(QUIT_REPLY, { requestId, label: 'w-b', ok: true, asked: true });
    });
    messageDialog.mockResolvedValueOnce("Don't Save").mockResolvedValue('Cancel');

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(1000);
    await quitting;

    expect(messageDialog.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining('a.md'),
      expect.stringContaining('a.md'),
    ]);
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('sweeps every window once more just before exit', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-a']);
    const requests: string[] = [];
    fakeWindow('w-a', (requestId) => {
      requests.push(requestId);
      send(QUIT_REPLY, { requestId, label: 'w-a', ok: true, asked: false });
    });

    const quitting = quitApp();
    await vi.advanceTimersByTimeAsync(1000);
    await quitting;

    expect(requests).toHaveLength(2);
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('a window asked again in the same round asks only about docs changed since its answer', async () => {
    windowAnswering('w-a');
    const a = dirtyDoc('/a.md');
    dirtyDoc('/b.md');
    messageDialog.mockResolvedValue("Don't Save");
    const replies: unknown[] = [];
    bus.listeners.add({ event: QUIT_REPLY, label: null, handler: ({ payload }) => replies.push(payload) });

    await emitTo('w-a', QUIT_REQUEST, { requestId: 'r1', round: 'R' });
    await vi.advanceTimersByTimeAsync(10);
    a.text = 'changed since';
    await emitTo('w-a', QUIT_REQUEST, { requestId: 'r2', round: 'R' });
    await vi.advanceTimersByTimeAsync(10);
    await emitTo('w-a', QUIT_REQUEST, { requestId: 'r3', round: 'R' });
    await vi.advanceTimersByTimeAsync(10);

    expect(messageDialog.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining('a.md'),
      expect.stringContaining('b.md'),
      expect.stringContaining('a.md'),
    ]);
    expect(replies).toEqual([
      expect.objectContaining({ requestId: 'r1', asked: true }),
      expect.objectContaining({ requestId: 'r2', asked: true }),
      expect.objectContaining({ requestId: 'r3', asked: false }),
    ]);
  });

  it('asks again in a new round about a doc answered in a cancelled one', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    dirtyDoc('/a.md');
    fakeWindow('w-1', (requestId) => send(QUIT_REPLY, { requestId, label: 'w-1', ok: false }));
    messageDialog.mockResolvedValue("Don't Save");
    const first = quitApp();
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(messageDialog).toHaveBeenCalledTimes(1);

    const second = quitApp();
    await vi.advanceTimersByTimeAsync(1000);
    await second;

    expect(messageDialog).toHaveBeenCalledTimes(2);
    expect(exitApp).not.toHaveBeenCalled();
  });
});

describe('runQuitRounds for an update (Ruling 343)', () => {
  it('runs its own step, not exit, once every window has answered yes and saved', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    windowAnswering('w-1');
    const install = vi.fn(async () => {});

    expect(await runQuitRounds(undefined, install)).toBe('proceed');

    expect(install).toHaveBeenCalledOnce();
    expect(exitApp).not.toHaveBeenCalled();
    expect(vi.mocked(saveWindowSession).mock.calls).toEqual([['main'], ['w-1']]);
    expect(vi.mocked(saveWindowState).mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]);
  });

  it('returns cancelled on Cancel, so nothing installs and the update stays ready', async () => {
    dirtyDoc('/a.md');
    messageDialog.mockResolvedValue('Cancel');
    const install = vi.fn(async () => {});

    expect(await runQuitRounds(undefined, install)).toBe('cancelled');

    expect(install).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('says why a failed install failed, and quits nothing', async () => {
    const install = vi.fn(async () => {
      throw 'No update is ready to install.';
    });

    expect(await runQuitRounds(undefined, install)).toBe('cancelled');

    expect(messageDialog).toHaveBeenCalledWith(
      'No update is ready to install.',
      expect.objectContaining({ kind: 'error' }),
    );
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('a Quit during the update round joins it, so it never exits over the install', async () => {
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-1']);
    windowAnswering('w-1');
    const install = vi.fn(async () => {});

    await Promise.all([runQuitRounds(undefined, install), quitApp()]);

    expect(install).toHaveBeenCalledOnce();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('quitApp still exits, once', async () => {
    await quitApp();

    expect(exitApp).toHaveBeenCalledOnce();
    expect(exitApp).toHaveBeenCalledWith(0);
  });
});
