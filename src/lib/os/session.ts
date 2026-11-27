import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { load, type Store } from '@tauri-apps/plugin-store';
import { setStartTopLine, topLineOf } from '../docs/cursor.svelte';
import { docs, restoreDoc, type ViewMode } from '../docs/store.svelte';
import { pathsExist } from '../ipc';
import { outline } from '../layout/outline.svelte';
import type { Workspace } from '../layout/workspace';
import { SETTINGS_LABEL } from '../../settings/settingsWindow';
import { largeFileNotices, requireWorkspace } from './open';
import { createAppWindow, docWindowLabels, setRestoring } from './windows';

/**
 * Persisted in session.json. The store holds key "version" (= 1) and one key per window,
 * "window:<label>", whose value is a WindowSession. Each window writes only its own key.
 */
export interface SessionState {
  version: 1;
  windows: Record<string, WindowSession>;
}

export interface WindowSession {
  label: string;
  layout: unknown; // dockview toJSON() output, stored as-is
  tabs: Record<string, PersistedTab>; // keyed by DocState.id / panel id
  outlineVisible: boolean;
}

export interface PersistedTab {
  path: string; // untitled docs are not persisted
  pinned: boolean;
  mode: ViewMode;
  topLine: number; // first visible source line, 1-based
}

const FILE = 'session.json';
const VERSION = 1;
const KEY_PREFIX = 'window:';
const MAIN = 'main';
const SAVE_DELAY_MS = 1000;
const MODES: readonly ViewMode[] = ['edit', 'split', 'read'];

/** This window's session as it stands. Untitled docs are left out. */
export function toWindowSession(
  ws: Pick<Workspace, 'toJSON'>,
  outlineVisible: boolean,
  label: string = getCurrentWindow().label,
): WindowSession {
  const tabs: Record<string, PersistedTab> = {};
  for (const doc of docs.values()) {
    if (doc.path === null) continue;
    tabs[doc.id] = { path: doc.path, pinned: doc.pinned, mode: doc.mode, topLine: topLineOf(doc.id) };
  }
  return { label, layout: ws.toJSON(), tabs, outlineVisible };
}

/** "1 file from last session was not found", for the status bar (Ruling 212). */
export function missingNotice(count: number): string {
  return count === 1
    ? '1 file from last session was not found'
    : `${count} files from last session were not found`;
}

let pending: ReturnType<typeof setTimeout> | undefined;
let pendingLabel: string | null = null;
// Until a window's restore is done, its stored key is the truth and saves skip. After a
// failed restore the key stays until the user changes something (Ruling 222).
const restoreState = new Map<string, 'done' | 'failed'>();
// A forgotten window is closing; a late save must not bring its key back.
const forgotten = new Set<string>();

/** Saves this window's session once nothing has changed for 1 s (Ruling 209). */
export function scheduleWindowSave(label: string): void {
  if (forgotten.has(label)) return;
  if (restoreState.get(label) === 'failed') restoreState.set(label, 'done');
  cancelPendingSave();
  pendingLabel = label;
  pending = setTimeout(() => {
    pending = undefined;
    saveWindowSession(label).catch((err) => console.error('Could not save the session:', err));
  }, SAVE_DELAY_MS);
}

/**
 * Writes only the key `window:<label>`, at once; any pending save is folded in. A window
 * other than main with no saved tabs is removed instead, so it does not come back empty.
 */
export function saveWindowSession(label: string): Promise<void> {
  cancelPendingSave();
  return oneAtATime(async () => {
    if (restoreState.get(label) !== 'done' || forgotten.has(label)) return;
    const session = toWindowSession(requireWorkspace(), outline.visible, label);
    const store = await sessionStore();
    // A session of another version was ignored at launch; the first save starts over (Ruling 210).
    if ((await store.get('version')) !== VERSION) {
      await store.clear();
      await store.set('version', VERSION);
    }
    if (label !== MAIN && Object.keys(session.tabs).length === 0) await store.delete(KEY_PREFIX + label);
    else await store.set(KEY_PREFIX + label, session);
    await store.save();
  });
}

/** Deletes the key `window:<label>` now. */
export function forgetWindowSession(label: string): Promise<void> {
  if (pendingLabel === label) cancelPendingSave();
  forgotten.add(label);
  return oneAtATime(async () => {
    const store = await sessionStore();
    await store.delete(KEY_PREFIX + label);
    await store.save();
  });
}

/** Sent by a window closing while others stay open; they forget its key 2 s on. */
export const FORGET_WINDOW = 'lintel://forget-window';
const FORGET_DELAY_MS = 2000;

export interface ForgetWindowEvent {
  label: string;
}

/**
 * Asks the other windows to forget `label`'s key in 2 s. A window that closes or quits
 * meanwhile takes its timer with it, so closing every window at once keeps the session,
 * as a quit does (Ruling 220).
 */
export async function forgetWindowSessionLater(label: string): Promise<void> {
  await emit(FORGET_WINDOW, { label } satisfies ForgetWindowEvent);
}

/** Forgets the keys of windows closed while this one stays open. Returns the stop. */
export function listenForForgets(label: string): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stop = listen<ForgetWindowEvent>(FORGET_WINDOW, ({ payload }) => {
    if (payload.label === label) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      forgetWindowSession(payload.label).catch((err) => console.error('Could not forget a window:', err));
    }, FORGET_DELAY_MS);
    timers.add(timer);
  });
  stop.catch((err) => console.error('Could not listen for closed windows:', err));
  return () => {
    for (const timer of timers) clearTimeout(timer);
    void stop.then((unlisten) => unlisten()).catch(() => {});
  };
}

let shown: () => void = () => {};
const shownGate = new Promise<void>((resolve) => (shown = resolve));

/**
 * Resolves once the restore is done, for main and for a window that had a session; a new
 * window waits for its doc instead (Ruling 205).
 */
export function whenRestored(): Promise<void> {
  return shownGate;
}

/**
 * Reopens this window's tabs from the last session under their old ids, then lays them
 * out as saved (Ruling 204). Files that are gone are returned in `missing`.
 */
export async function restoreWindow(label: string): Promise<{ restored: number; missing: string[] }> {
  let found = false;
  let outcome: 'done' | 'failed' = 'failed';
  try {
    const session = await readSession(label);
    if (!session) {
      outcome = 'done';
      return { restored: 0, missing: [] };
    }
    found = true;
    setRestoring(true);
    try {
      const result = await rebuild(session);
      outcome = 'done';
      return result;
    } finally {
      setRestoring(false);
    }
  } finally {
    // A user change may have come first; it already opened saving.
    if (restoreState.get(label) !== 'done') restoreState.set(label, outcome);
    if (found || label === MAIN) shown();
  }
}

/** Opens every other window of the last session; each then restores itself. Main only. */
export async function restoreAllWindows(): Promise<void> {
  const store = await sessionStore();
  if ((await store.get('version')) !== VERSION) return;
  const open = new Set(await docWindowLabels());
  const labels = (await store.keys())
    .filter((key) => key.startsWith(KEY_PREFIX))
    .map((key) => key.slice(KEY_PREFIX.length))
    // Only w-* windows get the document capability; Settings is never one (Ruling 147).
    .filter((label) => label.startsWith('w-') && label !== SETTINGS_LABEL && !open.has(label));
  for (const label of labels) {
    try {
      await createAppWindow(label);
    } catch (err) {
      console.error(`Could not reopen window ${label}:`, err);
    }
  }
}

async function rebuild(session: WindowSession): Promise<{ restored: number; missing: string[] }> {
  const ws = requireWorkspace();
  const tabs = Object.entries(session.tabs);
  // Checked first, so a gone file is counted, not shown as an error dialog.
  const found = await pathsExist(tabs.map(([, tab]) => tab.path));
  const missing: string[] = [];
  let restored = 0;
  for (const [i, [id, tab]] of tabs.entries()) {
    if (!found[i]) {
      missing.push(tab.path);
      continue;
    }
    try {
      const opened = await restoreDoc({ id, path: tab.path, mode: tab.mode, pinned: tab.pinned });
      // Null: another window shows the file, or this one does already.
      if (!opened) continue;
      if (opened.large) largeFileNotices.add(id);
      setStartTopLine(id, tab.topLine);
      restored++;
    } catch (err) {
      console.error(`Could not reopen ${tab.path}:`, err);
      missing.push(tab.path);
    }
  }
  outline.visible = session.outlineVisible;
  try {
    ws.fromJSON(session.layout);
  } catch (err) {
    console.error('Could not restore the tab layout:', err);
  }
  return { restored, missing };
}

async function readSession(label: string): Promise<WindowSession | null> {
  const store = await sessionStore();
  if ((await store.get('version')) !== VERSION) return null;
  const value = await store.get<unknown>(KEY_PREFIX + label);
  if (!isRecord(value) || !isRecord(value.tabs)) return null;
  const tabs: Record<string, PersistedTab> = {};
  for (const [id, tab] of Object.entries(value.tabs)) {
    if (isTab(tab)) tabs[id] = tab;
  }
  return { label, layout: value.layout, tabs, outlineVisible: value.outlineVisible !== false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTab(value: unknown): value is PersistedTab {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.pinned === 'boolean' &&
    MODES.includes(value.mode as ViewMode) &&
    typeof value.topLine === 'number' &&
    Number.isFinite(value.topLine)
  );
}

function cancelPendingSave(): void {
  clearTimeout(pending);
  pending = undefined;
  pendingLabel = null;
}

let queue: Promise<unknown> = Promise.resolve();

// A save still writing when the window is forgotten would put the key back.
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

let opened: Promise<Store> | null = null;

// One store instance per file is shared by every window, so it is never closed.
function sessionStore(): Promise<Store> {
  opened ??= load(FILE, { autoSave: false }).catch((err) => {
    opened = null;
    throw err;
  });
  return opened;
}
