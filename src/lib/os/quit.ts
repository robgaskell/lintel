import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { saveWindowState, StateFlags } from '@tauri-apps/plugin-window-state';
import {
  arrivalKey,
  confirmCloseAll,
  docs,
  handoffsSettled,
  isDirty,
  savesSettled,
} from '../docs/store.svelte';
import { handoffStatus, type HandoffStatus } from '../ipc';
import type { Workspace } from '../layout/workspace';
import { requireWorkspace } from './open';
import { saveWindowSession } from './session';
import { docWindowLabels } from './windows';

/** Sent by the quitting window to each other document window in turn. */
export const QUIT_REQUEST = 'lintel://quit-request';
/** A window's answer: false when the user cancelled one of its prompts. */
export const QUIT_REPLY = 'lintel://quit-reply';
/** Sent at once and every 2 s while a window answers, prompts included (Rulings 219, 235). */
export const QUIT_PROGRESS = 'lintel://quit-progress';
/** Sent to every window when a quit round starts and when it stops without quitting. */
export const QUIT_ROUND = 'lintel://quit-round';

export interface QuitRequestEvent {
  requestId: string;
  // Docs already asked about in this round are not asked about again.
  round: string;
}

export interface QuitReplyEvent {
  requestId: string;
  label: string;
  ok: boolean;
}

export interface QuitRoundEvent {
  label: string;
  running: boolean;
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
const GEOMETRY = StateFlags.POSITION | StateFlags.MAXIMIZED;
const HEARTBEAT_MS = 2000;
const HANDOFF_POLL_MS = 200;
// Each hand-over step gives up after 10 s, so a longer wait means a window has stopped.
const HANDOFF_WAIT_MS = 30_000;

type QuitOrder = Pick<Workspace, 'docIdsInOrder' | 'activate'>;

let quitting: Promise<void> | null = null;
// The window running a quit round elsewhere, as announced by QUIT_ROUND.
let roundElsewhere: string | null = null;

/**
 * Asks every document window, this one first, about its dirty docs and saves its session,
 * then exits. Cancel in any window stops the quit and closes nothing (Rulings 32, 211).
 * A Cmd+Q while a quit round is running joins that round (Ruling 219).
 */
export async function quitApp(workspace?: QuitOrder): Promise<void> {
  if (quitting) return quitting;
  if (answering) {
    await answering.catch(() => {});
    return;
  }
  if (await roundRunsElsewhere()) return;
  quitting ??= runQuit(workspace).finally(() => (quitting = null));
  return quitting;
}

/** Answers quit requests from other windows. Returns a function that stops listening. */
export function listenForQuitRequests(): () => void {
  const label = getCurrentWindow().label;
  const requests = listen<QuitRequestEvent>(
    QUIT_REQUEST,
    ({ payload }) => void replyToQuit(label, payload.requestId, payload.round),
    // A plain listen would also hear requests sent to other windows.
    { target: { kind: 'WebviewWindow', label } },
  );
  const rounds = listen<QuitRoundEvent>(QUIT_ROUND, ({ payload }) => {
    if (payload.label === label) return;
    if (payload.running) roundElsewhere = payload.label;
    else if (roundElsewhere === payload.label) roundElsewhere = null;
  });
  for (const stop of [requests, rounds]) {
    stop.catch((err) => console.error('Could not listen for quit requests:', err));
  }
  return () => {
    for (const stop of [requests, rounds]) void stop.then((unlisten) => unlisten()).catch(() => {});
  };
}

async function runQuit(workspace?: QuitOrder): Promise<void> {
  const self = getCurrentWindow().label;
  const round = crypto.randomUUID();
  await announceRound(self, true);
  try {
    // Docs on their way between windows land first, and the window list is read after.
    let mark = (await handoffsQuiet(0)).completed;
    const others = (await docWindowLabels()).filter((label) => label !== self);
    if (!(await answerQuit(self, round, workspace))) return;
    for (const label of others) {
      if (!(await askWindow(label, round))) return;
    }
    // A window that took a doc in during the round answers again for it (Ruling 235).
    for (;;) {
      const status = await handoffsQuiet(mark);
      if (status.adopters.length === 0) break;
      mark = status.completed;
      for (const label of status.adopters) {
        const ok = label === self ? await answerQuit(self, round, workspace) : await askWindow(label, round);
        if (!ok) return;
      }
    }
    // Size stays with Rust: on macOS a docked Web Inspector shrinks the size read here.
    await saveWindowState(GEOMETRY).catch((err) => console.error('Could not save window positions:', err));
    // exit() raises no close-requested event, so the window prompt does not run again.
    await exit(0);
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
  } finally {
    await announceRound(self, false);
  }
}

/** Resolves once no hand-over is pending app-wide, or after 30 s. */
async function handoffsQuiet(since: number): Promise<HandoffStatus> {
  const giveUp = Date.now() + HANDOFF_WAIT_MS;
  for (;;) {
    const status = await handoffStatus(since);
    if (status.pending === 0 || Date.now() >= giveUp) return status;
    await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
  }
}

// A round whose window has since closed is over.
async function roundRunsElsewhere(): Promise<boolean> {
  if (roundElsewhere === null || roundElsewhere === getCurrentWindow().label) return false;
  if ((await docWindowLabels()).includes(roundElsewhere)) return true;
  roundElsewhere = null;
  return false;
}

async function announceRound(label: string, running: boolean): Promise<void> {
  try {
    await emit(QUIT_ROUND, { label, running } satisfies QuitRoundEvent);
  } catch (err) {
    console.error('Could not announce the quit:', err);
  }
}

let answering: Promise<boolean> | null = null;

// Doc arrival keys already asked about in `askedRound`, so answering again asks only new docs.
let askedRound: string | null = null;
const askedInRound = new Set<string>();

// Two quits at once share one round of prompts in this window.
function answerQuit(label: string, round: string, workspace?: QuitOrder): Promise<boolean> {
  answering ??= runAnswer(label, round, workspace ?? requireWorkspace()).finally(
    () => (answering = null),
  );
  return answering;
}

async function runAnswer(label: string, round: string, workspace: QuitOrder): Promise<boolean> {
  if (askedRound !== round) {
    askedRound = round;
    askedInRound.clear();
  }
  // A doc mid-save is still dirty: asking now would offer to exit mid-write.
  await savesSettled();
  // A doc on its way to or from this window may land here, and must then be asked about.
  await handoffsSettled();
  const ordered = workspace.docIdsInOrder();
  const ids = [...ordered, ...[...docs.keys()].filter((id) => !ordered.includes(id))].filter(
    (id) => !askedInRound.has(arrivalKey(id)),
  );
  const asking = ids.some((id) => {
    const doc = docs.get(id);
    return doc !== undefined && isDirty(doc);
  });
  if (asking) {
    setPrompting(true);
    await bringForward();
  }
  let ok: boolean;
  try {
    ok = await confirmCloseAll(ids, (id) => workspace.activate(id));
  } finally {
    if (asking) setPrompting(false);
  }
  if (ok) for (const id of ids) if (docs.has(id)) askedInRound.add(arrivalKey(id));
  if (!ok) return false;
  try {
    await saveWindowSession(label);
  } catch (err) {
    console.error('Could not save the session:', err);
  }
  return true;
}

// Every request this window is answering, joined ones included, by id; each hears progress.
const answeringFor = new Map<string, string>();
let prompting = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;

async function replyToQuit(label: string, requestId: string, round: string): Promise<void> {
  answeringFor.set(requestId, label);
  // At once, then every 2 s, so a slow save or hand-over never looks like a hang (Ruling 219).
  reportProgress();
  heartbeat ??= setInterval(reportProgress, HEARTBEAT_MS);
  let ok = false;
  try {
    ok = await answerQuit(label, round);
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
  } finally {
    answeringFor.delete(requestId);
    if (answeringFor.size === 0) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }
  try {
    await emit(QUIT_REPLY, { requestId, label, ok } satisfies QuitReplyEvent);
  } catch (err) {
    console.error('Could not answer the quit:', err);
  }
}

function setPrompting(open: boolean): void {
  prompting = open;
  reportProgress();
}

function reportProgress(): void {
  for (const [requestId, label] of answeringFor) {
    emit(QUIT_PROGRESS, { requestId, label, prompting } satisfies QuitProgressEvent).catch((err) =>
      console.error('Could not report quit progress:', err),
    );
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

async function askWindow(label: string, round: string): Promise<boolean> {
  const requestId = crypto.randomUUID();
  const answer = await waitForAnswer(requestId, label);
  try {
    await emitTo(label, QUIT_REQUEST, { requestId, round } satisfies QuitRequestEvent);
    const result = await answer.result;
    if (result === 'silent') return (await message(NOT_RESPONDING, notRespondingOptions)) === QUIT_ANYWAY;
    return result === 'ok';
  } finally {
    answer.stop();
  }
}

// AppKit gives a button titled Cancel the Escape key and leaves Return unbound, so Return
// does nothing and Escape keeps the app running (Ruling 235).
const notRespondingOptions = {
  title: 'Lintel',
  kind: 'warning',
  buttons: { ok: 'Cancel', cancel: QUIT_ANYWAY },
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
      // Every beat, prompt open or not, restarts the 5 s (Ruling 235).
      wait();
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
