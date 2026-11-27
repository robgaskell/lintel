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
import { handoffStatus } from '../ipc';
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
  // True when the window showed a prompt; the round then sweeps once more.
  asked?: boolean;
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
export const HANDOFF_STUCK =
  'Lintel could not finish moving a document between windows, so it did not quit.';
const REPLY_TIMEOUT_MS = 5000;
// Rust saves geometry on exit too; saved here, while the windows exist, maximised is current.
const GEOMETRY = StateFlags.POSITION | StateFlags.MAXIMIZED;
const HEARTBEAT_MS = 2000;
const HANDOFF_POLL_MS = 200;
// Each hand-over step gives up after 10 s, so a longer wait means a window has stopped.
const HANDOFF_WAIT_MS = 30_000;

type QuitOrder = Pick<Workspace, 'docIdsInOrder' | 'activate'>;

/** 'proceed': the round passed every prompt and ran the `then` it started with. */
export type QuitOutcome = 'cancelled' | 'proceed';

let quitting: Promise<QuitOutcome> | null = null;
// The window running a quit round elsewhere, as announced by QUIT_ROUND.
let roundElsewhere: string | null = null;

/** Exits once every window's prompts have passed (Rulings 32, 211). */
export async function quitApp(workspace?: QuitOrder): Promise<void> {
  await runQuitRounds(workspace, () => exit(0));
}

/**
 * Asks every document window, this one first, about its dirty docs and saves its session,
 * then runs `then`: exit, or install an update (Ruling 343). Cancel in any window stops the
 * round and closes nothing. A call while a round runs joins it; its own `then` never runs
 * (Ruling 219).
 */
export async function runQuitRounds(
  workspace: QuitOrder | undefined,
  then: () => Promise<unknown>,
): Promise<QuitOutcome> {
  if (quitting) return quitting;
  if (answering) {
    await answering.catch(() => {});
    return 'cancelled';
  }
  if (await roundRunsElsewhere()) return 'cancelled';
  quitting ??= runQuit(workspace, then).finally(() => (quitting = null));
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

async function runQuit(
  workspace: QuitOrder | undefined,
  then: () => Promise<unknown>,
): Promise<QuitOutcome> {
  const self = getCurrentWindow().label;
  const round = crypto.randomUUID();
  await announceRound(self, true);
  try {
    // Docs on their way between windows land first, and the window list is read after.
    if (!(await handoffsQuiet())) return 'cancelled';
    // After the first pass, every window is asked again until a pass shows no prompt, so a
    // doc taken in, edited or made dirty after its window answered is asked about (Ruling 237).
    const abandoned = new Set<string>();
    for (let pass = 0; ; pass++) {
      const labels = [self, ...(await docWindowLabels()).filter((label) => label !== self)];
      let asked = false;
      for (const label of labels.filter((label) => !abandoned.has(label))) {
        const answer = label === self ? await answerQuit(self, round, workspace) : await askWindow(label, round);
        if (!answer.ok) return 'cancelled';
        if (answer.abandoned) abandoned.add(label);
        asked ||= answer.asked;
      }
      if (!(await handoffsQuiet())) return 'cancelled';
      if (pass > 0 && !asked) break;
    }
    // Size stays with Rust: on macOS a docked Web Inspector shrinks the size read here.
    await saveWindowState(GEOMETRY).catch((err) => console.error('Could not save window positions:', err));
    // Neither exit nor an update's relaunch raises close-requested, so no prompt runs again.
    await then();
    return 'proceed';
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
    return 'cancelled';
  } finally {
    await announceRound(self, false);
  }
}

/**
 * True once no hand-over is pending app-wide. After 30 s the doc in flight cannot be asked
 * about, so the quit stops and says so; it never exits over it (Ruling 237).
 */
async function handoffsQuiet(): Promise<boolean> {
  const giveUp = Date.now() + HANDOFF_WAIT_MS;
  while ((await handoffStatus(0)).pending > 0) {
    if (Date.now() >= giveUp) {
      await message(HANDOFF_STUCK, { title: 'Lintel', kind: 'error' });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
  }
  return true;
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

let answering: Promise<Answer> | null = null;

// Each doc answered in `askedRound`, by arrival key, with its text then: asking again asks
// only about docs that are new or have changed since.
let askedRound: string | null = null;
const askedInRound = new Map<string, string>();
// The round each window label last saved its session in.
const savedRound = new Map<string, string>();

interface Answer {
  ok: boolean;
  asked: boolean;
  // The user chose Quit Anyway for a window that did not answer.
  abandoned?: boolean;
}

// Two quits at once share one round of prompts in this window.
function answerQuit(label: string, round: string, workspace?: QuitOrder): Promise<Answer> {
  answering ??= runAnswer(label, round, workspace ?? requireWorkspace()).finally(
    () => (answering = null),
  );
  return answering;
}

async function runAnswer(label: string, round: string, workspace: QuitOrder): Promise<Answer> {
  if (askedRound !== round) {
    askedRound = round;
    askedInRound.clear();
  }
  const firstInRound = savedRound.get(label) !== round;
  // A doc mid-save is still dirty: asking now would offer to exit mid-write.
  await savesSettled();
  // A doc on its way to or from this window may land here, and must then be asked about.
  await handoffsSettled();
  const ordered = workspace.docIdsInOrder();
  const ids = [...ordered, ...[...docs.keys()].filter((id) => !ordered.includes(id))].filter(
    (id) => askedInRound.get(arrivalKey(id)) !== docs.get(id)?.text,
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
  if (!ok) return { ok, asked: asking };
  for (const id of ids) {
    const doc = docs.get(id);
    if (doc) askedInRound.set(arrivalKey(id), doc.text);
  }
  // A sweep that found nothing new leaves the session as saved.
  if (!firstInRound && ids.length === 0) return { ok, asked: asking };
  savedRound.set(label, round);
  try {
    await saveWindowSession(label);
  } catch (err) {
    console.error('Could not save the session:', err);
  }
  return { ok, asked: asking };
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
  let answer: Answer = { ok: false, asked: false };
  try {
    answer = await answerQuit(label, round);
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
    await emit(QUIT_REPLY, { requestId, label, ...answer } satisfies QuitReplyEvent);
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

async function askWindow(label: string, round: string): Promise<Answer> {
  const requestId = crypto.randomUUID();
  const answer = await waitForAnswer(requestId, label);
  try {
    await emitTo(label, QUIT_REQUEST, { requestId, round } satisfies QuitRequestEvent);
    const result = await answer.result;
    if (result === 'silent') {
      const quitAnyway = (await message(NOT_RESPONDING, notRespondingOptions)) === QUIT_ANYWAY;
      return { ok: quitAnyway, asked: false, abandoned: true };
    }
    return result;
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
): Promise<{ result: Promise<Answer | 'silent'>; stop: () => void }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: (result: Answer | 'silent') => void = () => {};
  const result = new Promise<Answer | 'silent'>((resolve) => (settle = resolve));
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(() => settle('silent'), REPLY_TIMEOUT_MS);
  };
  const mine = (e: { requestId: string; label: string }) => e.requestId === requestId && e.label === label;
  const stopReply = await listen<QuitReplyEvent>(QUIT_REPLY, ({ payload }) => {
    if (mine(payload)) settle({ ok: payload.ok, asked: payload.asked === true });
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
