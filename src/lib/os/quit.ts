import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { saveWindowState, StateFlags } from '@tauri-apps/plugin-window-state';
import { confirmCloseAll, docs, handoffsSettled, isDirty, savesSettled } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import { requireWorkspace } from './open';
import { saveWindowSession } from './session';
import { docWindowLabels } from './windows';

/** Sent by the quitting window to each other document window in turn. */
export const QUIT_REQUEST = 'lintel://quit-request';
/** A window's answer: false when the user cancelled one of its prompts. */
export const QUIT_REPLY = 'lintel://quit-reply';
/** Sent while a window answers: the asker's 5 s wait stops while a prompt is open (Ruling 211). */
export const QUIT_PROGRESS = 'lintel://quit-progress';

export interface QuitRequestEvent {
  requestId: string;
}

export interface QuitReplyEvent {
  requestId: string;
  label: string;
  ok: boolean;
}

export interface QuitProgressEvent {
  requestId: string;
  label: string;
  prompting: boolean;
}

export const NOT_RESPONDING =
  'A Lintel window is not responding. Quit anyway? Unsaved changes in it may be lost.';
const QUIT_ANYWAY = 'Quit Anyway';
const REPLY_TIMEOUT_MS = 5000;
// Rust saves geometry on exit too; saved here, while the windows exist, maximised is current.
const GEOMETRY = StateFlags.SIZE | StateFlags.POSITION | StateFlags.MAXIMIZED;

type QuitOrder = Pick<Workspace, 'docIdsInOrder' | 'activate'>;

let quitting: Promise<void> | null = null;

/**
 * Asks every document window, this one first, about its dirty docs and saves its session,
 * then exits. Cancel in any window stops the quit and closes nothing (Rulings 32, 211).
 */
export function quitApp(workspace?: QuitOrder): Promise<void> {
  // A second Cmd+Q while a prompt is open must not stack another round of prompts.
  quitting ??= runQuit(workspace).finally(() => (quitting = null));
  return quitting;
}

/** Answers quit requests from other windows. Returns a function that stops listening. */
export function listenForQuitRequests(): () => void {
  const label = getCurrentWindow().label;
  const stop = listen<QuitRequestEvent>(
    QUIT_REQUEST,
    ({ payload }) => void replyToQuit(label, payload.requestId),
    // A plain listen would also hear requests sent to other windows.
    { target: { kind: 'WebviewWindow', label } },
  );
  stop.catch((err) => console.error('Could not listen for quit requests:', err));
  return () => void stop.then((unlisten) => unlisten()).catch(() => {});
}

async function runQuit(workspace?: QuitOrder): Promise<void> {
  try {
    const self = getCurrentWindow().label;
    const others = (await docWindowLabels()).filter((label) => label !== self);
    if (!(await answerQuit(self, workspace))) return;
    for (const label of others) {
      if (!(await askWindow(label))) return;
    }
    await saveWindowState(GEOMETRY).catch((err) => console.error('Could not save window positions:', err));
    // exit() raises no close-requested event, so the window prompt does not run again.
    await exit(0);
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
  }
}

let answering: Promise<boolean> | null = null;

// Two quits at once share one round of prompts in this window.
function answerQuit(
  label: string,
  workspace?: QuitOrder,
  prompting?: (open: boolean) => void,
): Promise<boolean> {
  answering ??= runAnswer(label, workspace ?? requireWorkspace(), prompting).finally(
    () => (answering = null),
  );
  return answering;
}

async function runAnswer(
  label: string,
  workspace: QuitOrder,
  prompting?: (open: boolean) => void,
): Promise<boolean> {
  // A doc mid-save is still dirty: asking now would offer to exit mid-write.
  await savesSettled();
  // A doc on its way to another window may come back, and must then be asked about.
  await handoffsSettled();
  const ordered = workspace.docIdsInOrder();
  const ids = [...ordered, ...[...docs.keys()].filter((id) => !ordered.includes(id))];
  const asking = ids.some((id) => {
    const doc = docs.get(id);
    return doc !== undefined && isDirty(doc);
  });
  if (asking) {
    prompting?.(true);
    await bringForward();
  }
  const ok = await confirmCloseAll(ids, (id) => workspace.activate(id));
  if (asking) prompting?.(false);
  if (!ok) return false;
  try {
    await saveWindowSession(label);
  } catch (err) {
    console.error('Could not save the session:', err);
  }
  return true;
}

async function replyToQuit(label: string, requestId: string): Promise<void> {
  const send = (prompting: boolean) =>
    emit(QUIT_PROGRESS, { requestId, label, prompting } satisfies QuitProgressEvent).catch((err) =>
      console.error('Could not report quit progress:', err),
    );
  let ok = false;
  try {
    // Says this window is alive; the asker's wait starts again from here.
    void send(false);
    ok = await answerQuit(label, undefined, send);
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
  }
  try {
    await emit(QUIT_REPLY, { requestId, label, ok } satisfies QuitReplyEvent);
  } catch (err) {
    console.error('Could not answer the quit:', err);
  }
}

// A window behind the others must come forward, or its prompt shows behind them.
async function bringForward(): Promise<void> {
  const win = getCurrentWindow();
  try {
    if (await win.isMinimized()) await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch (err) {
    console.error('Could not bring the window forward:', err);
  }
}

async function askWindow(label: string): Promise<boolean> {
  const requestId = crypto.randomUUID();
  const answer = await waitForAnswer(requestId, label);
  try {
    await emitTo(label, QUIT_REQUEST, { requestId } satisfies QuitRequestEvent);
    const result = await answer.result;
    if (result === 'silent') return (await message(NOT_RESPONDING, notRespondingOptions)) === QUIT_ANYWAY;
    return result === 'ok';
  } finally {
    answer.stop();
  }
}

const notRespondingOptions = {
  title: 'Lintel',
  kind: 'warning',
  buttons: { ok: QUIT_ANYWAY, cancel: 'Cancel' },
} as const;

// Listens before the request goes out, so a quick answer cannot be missed.
async function waitForAnswer(
  requestId: string,
  label: string,
): Promise<{ result: Promise<'ok' | 'cancel' | 'silent'>; stop: () => void }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: (result: 'ok' | 'cancel' | 'silent') => void = () => {};
  const result = new Promise<'ok' | 'cancel' | 'silent'>((resolve) => (settle = resolve));
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(() => settle('silent'), REPLY_TIMEOUT_MS);
  };
  const mine = (e: { requestId: string; label: string }) => e.requestId === requestId && e.label === label;
  const stopReply = await listen<QuitReplyEvent>(QUIT_REPLY, ({ payload }) => {
    if (mine(payload)) settle(payload.ok ? 'ok' : 'cancel');
  });
  let stopProgress: () => void = () => {};
  try {
    stopProgress = await listen<QuitProgressEvent>(QUIT_PROGRESS, ({ payload }) => {
      if (!mine(payload)) return;
      // No limit while the user reads a prompt; 5 s again once it is answered.
      if (payload.prompting) clearTimeout(timer);
      else wait();
    });
  } catch (err) {
    stopReply();
    throw err;
  }
  wait();
  return {
    result,
    stop: () => {
      clearTimeout(timer);
      stopReply();
      stopProgress();
    },
  };
}
