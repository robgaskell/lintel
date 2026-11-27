import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { get } from 'svelte/store';
import { cursors, setStartCursor, type Cursor } from '../docs/cursor.svelte';
import {
  adoptDoc,
  docs,
  findByPath,
  removeDoc,
  saveSettled,
  type DocState,
} from '../docs/store.svelte';
import { claimPath, releasePath, transferPath } from '../ipc';
import type { Workspace } from '../layout/workspace';
import { settings } from '../settings/settings.svelte';
import { resolvedTheme } from '../theme/theme';
import { largeFileNotices, requireWorkspace, revealAnswered } from './open';

/** Sent by a document window once its Workspace is mounted and it listens for adoption. */
export const WINDOW_READY = 'lintel://window-ready';
/** Sent to a new window with the document it takes over. */
export const ADOPT_DOC = 'lintel://adopt-doc';
/** Sent back by the new window once the document shows there. */
export const DOC_ADOPTED = 'lintel://doc-adopted';
/** Sent by Rust to the window that owns a path another window tried to open. */
export const REVEAL_DOC = 'lintel://reveal-doc';
/** The owner's answer to a reveal: whether it shows the file (Ruling 199). */
export const REVEAL_ANSWER = 'lintel://reveal-answer';

/** Docs larger than this stay in their window: an event carries the whole buffer (Ruling 187). */
export const MOVE_LIMIT_BYTES = 10_000_000;

// Each step of a hand-over that takes longer counts as failed, and the doc stays put.
const STEP_TIMEOUT_MS = 10_000;
const DEFAULT_SIZE = { width: 1200, height: 800 };
const CASCADE_PX = 28;

export interface WindowReadyEvent {
  label: string;
}

/** The doc travels whole, with the per-window state that goes with it (Rulings 186, 201). */
export interface AdoptDocEvent {
  doc: DocState;
  largeFileNotice: boolean;
  cursor: Cursor | null;
}

export interface DocAdoptedEvent {
  label: string;
  docId: string;
}

export interface RevealDocEvent {
  path: string;
}

export interface RevealAnswerEvent {
  path: string;
  shown: boolean;
}

let adopted: () => void = () => {};
let hasAdopted = false;
const firstAdoption = new Promise<void>((resolve) => (adopted = resolve));

// Paths this window is handing to another; their claims are right though no tab shows them.
const moving = new Set<string>();

/**
 * Opens a document window, hidden and already in the app's theme until its page shows it
 * (Ruling 184), at this window's size and cascaded from it (Ruling 201).
 */
export async function createAppWindow(label: string): Promise<WebviewWindow> {
  const geometry = (await cascadeFromThisWindow()) ?? DEFAULT_SIZE;
  const win = new WebviewWindow(label, {
    url: '/',
    title: 'Lintel',
    ...geometry,
    minWidth: 480,
    minHeight: 320,
    visible: false,
    theme: settings.theme === 'system' ? undefined : settings.theme,
    backgroundColor: settings.palettes[get(resolvedTheme)].background,
  });
  return new Promise((resolve, reject) => {
    void win.once('tauri://created', () => resolve(win));
    void win.once('tauri://error', (event) => reject(event.payload));
  });
}

export function tooLargeToMove(doc: DocState): boolean {
  // Cheap bounds first: UTF-8 takes one to three bytes per UTF-16 unit.
  if (doc.text.length > MOVE_LIMIT_BYTES) return true;
  if (doc.text.length * 3 <= MOVE_LIMIT_BYTES) return false;
  return new TextEncoder().encode(doc.text).length > MOVE_LIMIT_BYTES;
}

/**
 * Moves a doc, unsaved edits included, to a new window. Once the window is ready and no
 * save of the doc is running, the doc leaves this window at once and its claim moves with
 * it. If the new window does not take it in time, the doc comes back here (Ruling 197).
 */
export async function openDocInNewWindow(docId: string): Promise<void> {
  const doc = docs.get(docId);
  if (!doc || tooLargeToMove(doc)) return;
  const label = `w-${crypto.randomUUID()}`;
  const ready = await waitFor<WindowReadyEvent>(WINDOW_READY, (e) => e.label === label);
  let win: WebviewWindow | null = null;
  try {
    win = await createAppWindow(label);
    await ready.promise;
    // A save finishing after the hand-over would update a doc that is no longer here.
    await saveSettled(docId);
  } catch (err) {
    ready.stop();
    void win?.destroy().catch(() => {});
    throw err;
  }
  const handover = takeOut(docId);
  // The tab closed while the window was starting.
  if (!handover) {
    await win.destroy();
    return;
  }
  const path = handover.doc.path;
  if (path !== null) moving.add(path);
  try {
    await handOver(label, handover);
  } catch (err) {
    await win.destroy().catch(() => {});
    await bringBack(handover);
    throw err;
  } finally {
    if (path !== null) moving.delete(path);
  }
}

/**
 * Takes in docs handed over by other windows, then tells them this window is ready.
 * Returns a function that stops listening.
 */
export function listenForAdoption(): () => void {
  const label = getCurrentWindow().label;
  const stop = listenHere<AdoptDocEvent>(label, ADOPT_DOC, (event) => {
    adopt(label, event).catch((err) => console.error('Could not take in the document:', err));
  });
  void stop.ready
    .then(() => emit(WINDOW_READY, { label } satisfies WindowReadyEvent))
    .catch((err) => console.error('Could not announce the window:', err));
  return stop.stop;
}

/** Resolves once this window has taken in its first handed-over doc. */
export function whenAdopted(): Promise<void> {
  return firstAdoption;
}

/**
 * Shows the doc Rust names in this window and brings the window forward, and answers
 * the window that asked. Also passes on other windows' answers to this one's requests.
 */
export function listenForReveal(ws: Pick<Workspace, 'activate'>): () => void {
  const label = getCurrentWindow().label;
  const reveals = listenHere<RevealDocEvent>(label, REVEAL_DOC, ({ path }) => void reveal(ws, path));
  const answers = listenHere<RevealAnswerEvent>(null, REVEAL_ANSWER, ({ path, shown }) =>
    revealAnswered(path, shown),
  );
  return () => {
    reveals.stop();
    answers.stop();
  };
}

// Synchronous from the snapshot to the removal, so no edit typed in between is lost.
function takeOut(docId: string): AdoptDocEvent | null {
  const doc = docs.get(docId);
  if (!doc) return null;
  const cursor = cursors.get(docId);
  const event: AdoptDocEvent = {
    doc: { ...doc },
    largeFileNotice: largeFileNotices.has(docId),
    cursor: cursor ? { ...cursor } : null,
  };
  removeDoc(docId, { keepClaim: true });
  void requireWorkspace().closeDoc(docId);
  return event;
}

async function handOver(label: string, event: AdoptDocEvent): Promise<void> {
  const taken = await waitFor<DocAdoptedEvent>(
    DOC_ADOPTED,
    (e) => e.label === label && e.docId === event.doc.id,
  );
  try {
    if (event.doc.path !== null) await transferPath(event.doc.path, label);
    await emitTo(label, ADOPT_DOC, event);
    await taken.promise;
  } catch (err) {
    taken.stop();
    throw err;
  }
}

async function bringBack(event: AdoptDocEvent): Promise<void> {
  const path = event.doc.path;
  if (path !== null) {
    try {
      await transferPath(path, getCurrentWindow().label);
    } catch (err) {
      console.error(`Could not take back ${path}:`, err);
    }
  }
  place(event);
}

async function adopt(label: string, event: AdoptDocEvent): Promise<void> {
  const path = event.doc.path;
  if (path !== null) {
    // The doc must not be lost whatever the answer, so a failed claim only logs.
    try {
      const owner = await claimPath(path);
      if (owner !== null) console.error(`${path} is also open in window ${owner}`);
    } catch (err) {
      console.error(`Could not claim ${path}:`, err);
    }
  }
  place(event);
  hasAdopted = true;
  adopted();
  await emit(DOC_ADOPTED, { label, docId: event.doc.id } satisfies DocAdoptedEvent);
}

function place({ doc: state, largeFileNotice, cursor }: AdoptDocEvent): void {
  const doc = adoptDoc(state);
  if (largeFileNotice) largeFileNotices.add(doc.id);
  if (cursor !== null) setStartCursor(doc.id, cursor);
  requireWorkspace().openDoc(doc);
}

async function reveal(ws: Pick<Workspace, 'activate'>, path: string): Promise<void> {
  const doc = findByPath(path);
  if (!doc) {
    // A doc on its way out, or one this new window is about to take in, keeps its claim.
    const arriving = getCurrentWindow().label.startsWith('w-') && !hasAdopted;
    if (moving.has(path) || arriving) return answer(path, true);
    // A stale claim: nothing here shows the file, so the window that asked opens it.
    try {
      await releasePath(path);
    } catch (err) {
      console.error(`Could not release ${path}:`, err);
    }
    return answer(path, false);
  }
  ws.activate(doc.id);
  void answer(path, true);
  const win = getCurrentWindow();
  try {
    if (await win.isMinimized()) await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch (err) {
    console.error('Could not bring the window forward:', err);
  }
}

async function answer(path: string, shown: boolean): Promise<void> {
  try {
    await emit(REVEAL_ANSWER, { path, shown } satisfies RevealAnswerEvent);
  } catch (err) {
    console.error('Could not answer a reveal:', err);
  }
}

// Logical pixels. Null when this window's frame cannot be read; the OS then places it.
async function cascadeFromThisWindow(): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  try {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    const inner = (await win.innerSize()).toLogical(scale);
    const outer = (await win.outerSize()).toLogical(scale);
    const at = (await win.outerPosition()).toLogical(scale);
    let x = at.x + CASCADE_PX;
    let y = at.y + CASCADE_PX;
    const monitor = await currentMonitor();
    if (monitor) {
      const area = monitor.workArea;
      const left = area.position.x / monitor.scaleFactor;
      const top = area.position.y / monitor.scaleFactor;
      // Past the edge of the screen, the cascade starts again from its corner.
      if (x + outer.width > left + area.size.width / monitor.scaleFactor) x = left;
      if (y + outer.height > top + area.size.height / monitor.scaleFactor) y = top;
    }
    return { x, y, width: inner.width, height: inner.height };
  } catch (err) {
    console.error('Could not read the window frame:', err);
    return null;
  }
}

// A plain listen would also hear events sent to other windows; null hears every event.
function listenHere<T>(
  label: string | null,
  event: string,
  handler: (payload: T) => void,
): { ready: Promise<void>; stop: () => void } {
  let unlisten: UnlistenFn | null = null;
  let stopped = false;
  const options = label === null ? undefined : { target: { kind: 'WebviewWindow' as const, label } };
  const ready = listen<T>(event, ({ payload }) => handler(payload), options).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });
  ready.catch((err) => console.error(`Could not listen for ${event}:`, err));
  return {
    ready,
    stop: () => {
      stopped = true;
      unlisten?.();
    },
  };
}

// Listens before the step that causes the event, so a quick answer cannot be missed.
async function waitFor<T>(
  event: string,
  matches: (payload: T) => boolean,
): Promise<{ promise: Promise<void>; stop: () => void }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done: () => void = () => {};
  let fail: (err: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  const unlisten = await listen<T>(event, ({ payload }) => {
    if (matches(payload)) done();
  });
  const stop = () => {
    clearTimeout(timer);
    unlisten();
  };
  timer = setTimeout(() => fail(new Error('The new window did not start.')), STEP_TIMEOUT_MS);
  void promise.then(stop, stop);
  return { promise, stop };
}
