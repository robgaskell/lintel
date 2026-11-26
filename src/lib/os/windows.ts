import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { get } from 'svelte/store';
import { setStartLine, cursors } from '../docs/cursor.svelte';
import { adoptDoc, docs, findByPath, removeDoc, type DocState } from '../docs/store.svelte';
import { claimPath, releasePath } from '../ipc';
import type { Workspace } from '../layout/workspace';
import { settings } from '../settings/settings.svelte';
import { resolvedTheme } from '../theme/theme';
import { largeFileNotices, requireWorkspace } from './open';

/** Sent by a document window once its Workspace is mounted and it listens for adoption. */
export const WINDOW_READY = 'lintel://window-ready';
/** Sent to a new window with the document it takes over. */
export const ADOPT_DOC = 'lintel://adopt-doc';
/** Sent by Rust to the window that owns a path another window tried to open. */
export const REVEAL_DOC = 'lintel://reveal-doc';

/** Docs larger than this stay in their window: an event carries the whole buffer (Ruling 187). */
export const MOVE_LIMIT_BYTES = 10_000_000;
export const TOO_LARGE_TO_MOVE = 'Too large to move to a new window';

// A window that has not started by then is taken as failed, and the doc stays put.
const READY_TIMEOUT_MS = 10_000;

export interface WindowReadyEvent {
  label: string;
}

/** The doc travels whole, with the per-window state that goes with it (Ruling 186). */
export interface AdoptDocEvent {
  doc: DocState;
  largeFileNotice: boolean;
  cursorLine: number | null;
}

export interface RevealDocEvent {
  path: string;
}

let adopted: () => void = () => {};
const firstAdoption = new Promise<void>((resolve) => (adopted = resolve));

/**
 * Opens a document window like the main one, hidden and already in the app's theme until
 * its page shows it (Ruling 184).
 */
export function createAppWindow(label: string): Promise<WebviewWindow> {
  const win = new WebviewWindow(label, {
    url: '/',
    title: 'Lintel',
    width: 1200,
    height: 800,
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
 * Moves a doc, unsaved edits included, to a new window: once that window is ready, this
 * window releases the path, hands the doc over and drops it without prompting.
 */
export async function openDocInNewWindow(docId: string): Promise<void> {
  const doc = docs.get(docId);
  if (!doc || tooLargeToMove(doc)) return;
  const label = `w-${crypto.randomUUID()}`;
  const ready = await windowReady(label);
  let win: WebviewWindow | null = null;
  try {
    win = await createAppWindow(label);
    await ready.promise;
  } catch (err) {
    ready.stop();
    void win?.destroy().catch(() => {});
    throw err;
  }
  // The tab may have closed while the window was starting.
  if (!docs.has(docId)) {
    await win.destroy();
    return;
  }
  const event: AdoptDocEvent = {
    doc: { ...doc },
    largeFileNotice: largeFileNotices.has(docId),
    cursorLine: cursors.get(docId)?.line ?? null,
  };
  if (doc.path !== null) await releasePath(doc.path);
  try {
    await emitTo(label, ADOPT_DOC, event);
  } catch (err) {
    if (doc.path !== null) void claimPath(doc.path);
    void win.destroy();
    throw err;
  }
  removeDoc(docId);
  await requireWorkspace().closeDoc(docId);
}

/**
 * Takes in docs handed over by other windows, then tells them this window is ready.
 * Returns a function that stops listening.
 */
export function listenForAdoption(): () => void {
  const label = getCurrentWindow().label;
  const stop = listenHere<AdoptDocEvent>(label, ADOPT_DOC, (event) => void adopt(event));
  void stop.ready
    .then(() => emit(WINDOW_READY, { label } satisfies WindowReadyEvent))
    .catch((err) => console.error('Could not announce the window:', err));
  return stop.stop;
}

/** Resolves once this window has taken in its first handed-over doc. */
export function whenAdopted(): Promise<void> {
  return firstAdoption;
}

/** Shows the doc Rust names in this window, and brings the window forward. */
export function listenForReveal(ws: Pick<Workspace, 'activate'>): () => void {
  const label = getCurrentWindow().label;
  return listenHere<RevealDocEvent>(label, REVEAL_DOC, ({ path }) => void reveal(ws, path)).stop;
}

async function adopt({ doc: state, largeFileNotice, cursorLine }: AdoptDocEvent): Promise<void> {
  if (state.path !== null) {
    // The doc must not be lost whatever the answer, so a failed claim only logs.
    try {
      const owner = await claimPath(state.path);
      if (owner !== null) console.error(`${state.path} is also open in window ${owner}`);
    } catch (err) {
      console.error(`Could not claim ${state.path}:`, err);
    }
  }
  const doc = adoptDoc(state);
  if (largeFileNotice) largeFileNotices.add(doc.id);
  if (cursorLine !== null) setStartLine(doc.id, cursorLine);
  requireWorkspace().openDoc(doc);
  adopted();
}

async function reveal(ws: Pick<Workspace, 'activate'>, path: string): Promise<void> {
  const doc = findByPath(path);
  if (!doc) return;
  ws.activate(doc.id);
  const win = getCurrentWindow();
  try {
    if (await win.isMinimized()) await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch (err) {
    console.error('Could not bring the window forward:', err);
  }
}

// A plain listen would also hear events sent to other windows.
function listenHere<T>(
  label: string,
  event: string,
  handler: (payload: T) => void,
): { ready: Promise<void>; stop: () => void } {
  let unlisten: UnlistenFn | null = null;
  let stopped = false;
  const ready = listen<T>(event, ({ payload }) => handler(payload), {
    target: { kind: 'WebviewWindow', label },
  }).then((fn) => {
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

// Listens before the window exists, so a quick window cannot be missed.
async function windowReady(label: string): Promise<{ promise: Promise<void>; stop: () => void }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done: () => void = () => {};
  let fail: (err: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  const unlisten = await listen<WindowReadyEvent>(WINDOW_READY, ({ payload }) => {
    if (payload.label === label) done();
  });
  const stop = () => {
    clearTimeout(timer);
    unlisten();
  };
  timer = setTimeout(() => fail(new Error('The new window did not start.')), READY_TIMEOUT_MS);
  void promise.then(stop, stop);
  return { promise, stop };
}
