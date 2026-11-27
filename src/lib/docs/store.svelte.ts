import { SvelteMap } from 'svelte/reactivity';
import { message, save } from '@tauri-apps/plugin-dialog';
import {
  claimPath,
  normalizePath,
  readTextFile,
  releasePath,
  unwatchPath,
  watchPath,
  writeTextFile,
} from '../ipc';
import { recordRecent } from '../os/recent';
import { detectLineEnding, toBuffer, toDisk, type LineEnding } from './text';

export type ViewMode = 'edit' | 'split' | 'read';

/** One open document, keyed by id in `docs`. */
export interface DocState {
  id: string;
  path: string | null;
  title: string;
  text: string;
  savedText: string;
  lineEnding: LineEnding;
  diskHash: string;
  pinned: boolean;
  mode: ViewMode;
  external: 'none' | 'updated' | 'conflict' | 'deleted';
  diskText: string | null;
  lintConfigPath: string | null;
}

// $state does not track Map.set/delete, so the map itself is a SvelteMap.
export const docs: Map<string, DocState> = $state(new SvelteMap());

export const untitledCounter = $state({ n: 0 });

export function createDoc(init: {
  path: string | null;
  raw: string;
  hash: string;
  mode: ViewMode;
}): DocState {
  return insertDoc(crypto.randomUUID(), init);
}

/** Spec: above 2 MB a tab opens in Edit only, with a notice (1 MB = 1,000,000 bytes, Ruling 78). */
export const LARGE_FILE_BYTES = 2_000_000;

/** `raw` is the file's text before newline changes, so its UTF-8 length is the file size. */
export function isLargeFile(raw: string): boolean {
  return new TextEncoder().encode(raw).length > LARGE_FILE_BYTES;
}

/**
 * Opens a file from the last session under its old id, so the saved layout finds its tab
 * (Ruling 204). No dialogs and no Open Recent entry; a large file opens in Edit (Ruling 222).
 * Null when another window, or this one, has the file already; rejects when it cannot be read.
 */
export async function restoreDoc(init: {
  id: string;
  path: string;
  mode: ViewMode;
  pinned: boolean;
}): Promise<{ doc: DocState; large: boolean } | null> {
  const { id, path, mode, pinned } = init;
  // Opened here already, by an outside open that did not wait for the restore (Ruling 242).
  if (findByPath(path)) return null;
  opening.add(path);
  try {
    if ((await claimPath(path)) !== null) return null;
    let read;
    try {
      read = await readTextFile(path);
    } catch (err) {
      void release(path);
      throw err;
    }
    const large = isLargeFile(read.text);
    const doc = insertDoc(id, { path, raw: read.text, hash: read.hash, mode: large ? 'edit' : mode });
    doc.pinned = pinned;
    return { doc, large };
  } finally {
    opening.delete(path);
  }
}

function insertDoc(
  id: string,
  init: { path: string | null; raw: string; hash: string; mode: ViewMode },
): DocState {
  const text = toBuffer(init.raw);
  const doc = $state<DocState>({
    id,
    path: init.path,
    title: init.path === null ? `Untitled-${++untitledCounter.n}` : baseName(init.path),
    text,
    savedText: text,
    lineEnding: detectLineEnding(init.raw),
    diskHash: init.hash,
    pinned: false,
    mode: init.mode,
    external: 'none',
    diskText: null,
    lintConfigPath: null,
  });
  return place(doc);
}

/** Inserts a doc handed over from another window as it is, unsaved edits included (Ruling 186). */
export function adoptDoc(state: DocState): DocState {
  const doc = $state<DocState>({ ...state });
  arrivals.set(doc.id, arrivalOf(doc.id) + 1);
  return place(doc);
}

/**
 * Every way a doc arrives in this window ends here: open, restore, hand-over, and a doc that
 * comes back from a failed one. Its file is watched from the hash it carries (Ruling 257).
 */
function place(doc: DocState): DocState {
  docs.set(doc.id, doc);
  if (doc.path !== null) void watch(doc.path, doc.diskHash);
  hooks?.placed(doc);
  return doc;
}

/** Lets another module follow each doc through this window, as the lint config does (Ruling 284). */
export interface DocHooks {
  /** Opened, restored, handed over, or back from a failed hand-over. */
  placed(doc: DocState): void;
  removed(id: string): void;
  /** After a Save or Save As wrote the doc; `oldPath` is its path before. */
  saved(doc: DocState, oldPath: string | null): void;
}

let hooks: DocHooks | null = null;

export function setDocHooks(next: DocHooks | null): void {
  hooks = next;
}

// A doc keeps its id across windows, so a doc back from a failed hand-over needs this.
const arrivals = new Map<string, number>();

/**
 * The doc's id plus how many times it has arrived in this window, so a doc that left and
 * came back is not taken for one already asked about (Ruling 235).
 */
export function arrivalKey(id: string): string {
  return `${id}#${arrivalOf(id)}`;
}

function arrivalOf(id: string): number {
  return arrivals.get(id) ?? 0;
}

/**
 * Every way a doc leaves this window ends here, so its path is released for other windows
 * (Ruling 185). It does not prompt. `keepClaim` is for a hand-over, which moves the claim.
 */
export function removeDoc(id: string, { keepClaim = false } = {}): void {
  const path = docs.get(id)?.path ?? null;
  docs.delete(id);
  hooks?.removed(id);
  if (path === null) return;
  // A hand-over unwatches too; Rust keeps the watch once the new window has taken it.
  void unwatch(path);
  if (!keepClaim) void release(path);
}

/**
 * Paths this window has claimed for a doc that does not have them yet, while a file opens
 * or a Save As runs. Their claims are right though no tab shows them (Ruling 213).
 */
export const opening = new Set<string>();

const handoffs = new Set<Promise<unknown>>();

/** Counts a hand-over of a doc to another window until it settles. */
export function trackHandoff(handoff: Promise<unknown>): void {
  handoffs.add(handoff);
  const forget = () => handoffs.delete(handoff);
  handoff.then(forget, forget);
}

/**
 * Resolves once every hand-over running now has settled. A doc that comes back is then
 * in `docs`, so closing or quitting asks about it (Ruling 213).
 */
export async function handoffsSettled(): Promise<void> {
  await Promise.allSettled([...handoffs]);
}

let showTab: (id: string) => void = () => {};

/** How Save As brings forward the tab that already has the chosen file. */
export function setTabShower(show: (id: string) => void): void {
  showTab = show;
}

export function isDirty(doc: DocState): boolean {
  return doc.text !== doc.savedText;
}

/**
 * Resolves to false only if the user cancels the Save As dialog.
 * Rejects for an unknown id. A second call while a save is running gets the first call's promise.
 */
export function saveDoc(id: string): Promise<boolean> {
  return onceAtATime(id, async () => runSave(getDoc(id)));
}

/** As saveDoc, but always asks for a path. */
export function saveDocAs(id: string): Promise<boolean> {
  return onceAtATime(id, async () => runSaveAs(getDoc(id)));
}

/**
 * Asks Save / Don't Save / Cancel when the doc is dirty, then removes it from `docs`.
 * False means the doc stays open: Cancel, a cancelled Save As, or a failed save.
 */
export async function closeDocWithPrompt(id: string): Promise<boolean> {
  if (!(await mayClose(getDoc(id)))) return false;
  removeDoc(id);
  return true;
}

/**
 * Prompts for each dirty doc in `ids`, in order, without closing any of them.
 * False at the first Cancel. `beforeAsk` lets the caller show the doc being asked about.
 */
export async function confirmCloseAll(
  ids: string[],
  beforeAsk?: (id: string) => void,
): Promise<boolean> {
  for (const id of ids) {
    const doc = docs.get(id);
    if (!doc || !isDirty(doc)) continue;
    beforeAsk?.(id);
    if (!(await mayClose(doc))) return false;
  }
  return true;
}

/** Resolves once no save of `id` is running, including one started while waiting. */
export async function saveSettled(id: string): Promise<void> {
  for (let running = inFlight.get(id); running; running = inFlight.get(id)) {
    await running.catch(() => {});
  }
}

/** Resolves once every save running now has finished, whatever its outcome. */
export async function savesSettled(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}

export function findByPath(path: string): DocState | undefined {
  for (const doc of docs.values()) {
    if (doc.path === path) return doc;
  }
  return undefined;
}

const inFlight = new Map<string, Promise<boolean>>();

// A double Cmd+S must not start two writes of the same doc (Ruling 11).
function onceAtATime(id: string, run: () => Promise<boolean>): Promise<boolean> {
  const running = inFlight.get(id);
  if (running) return running;
  const promise = run().finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

function getDoc(id: string): DocState {
  const doc = docs.get(id);
  if (!doc) throw new Error(`No open document has id ${id}`);
  return doc;
}

async function runSave(doc: DocState): Promise<boolean> {
  // Untitled docs always ask for a path, even when empty (Ruling 14).
  if (doc.path === null) return runSaveAs(doc);
  // A clean save must not touch the file, so its bytes stay identical.
  if (!isDirty(doc) && doc.external !== 'deleted') return true;
  await writeTo(doc, doc.path);
  hooks?.saved(doc, doc.path);
  return true;
}

async function runSaveAs(doc: DocState): Promise<boolean> {
  const path = await save({
    defaultPath: doc.path ?? `${doc.title}.md`,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (path === null) return false;
  const oldPath = doc.path;
  // A file that does not exist yet keeps the spelling chosen until it is written.
  const chosen = await normalizedOrAsGiven(path);
  // A file is never open in two places (spec), so Save As must not write over it.
  const otherTab = findByPath(chosen);
  if (otherTab && otherTab !== doc) {
    showTab(otherTab.id);
    const text = `${baseName(chosen)} is already open in another tab.`;
    await message(text, { title: 'Lintel', kind: 'error' });
    return false;
  }
  opening.add(chosen);
  try {
    if (chosen !== oldPath && (await claimPath(chosen)) !== null) {
      await refuseOpenElsewhere(chosen);
      return false;
    }
    try {
      await writeTo(doc, path);
    } catch (err) {
      if (chosen !== oldPath) void release(chosen);
      throw err;
    }
    doc.path = await normalizedOrAsGiven(path);
  } finally {
    opening.delete(chosen);
  }
  doc.title = baseName(doc.path);
  if (doc.path !== chosen) {
    void claimPath(doc.path).catch((err) => console.error('Could not claim the saved file:', err));
    void release(chosen);
  }
  if (doc.path !== oldPath) void watch(doc.path, doc.diskHash);
  if (oldPath !== null && oldPath !== doc.path) {
    void unwatch(oldPath);
    void release(oldPath);
  }
  // Every Save As route passes here (Ruling 49). Not awaited: a slow store must not delay a save.
  void recordRecent(doc.path);
  hooks?.saved(doc, oldPath);
  return true;
}

async function refuseOpenElsewhere(path: string): Promise<void> {
  const text =
    `${baseName(path)} is open in another window. ` + 'Close it there first, or choose another name.';
  await message(text, { title: 'Lintel', kind: 'error' });
}

async function writeTo(doc: DocState, path: string): Promise<void> {
  // Snapshot first: edits typed while the write is in flight stay unsaved.
  const text = doc.text;
  const hash = await writeTextFile(path, toDisk(text, doc.lineEnding));
  doc.savedText = text;
  doc.diskHash = hash;
  doc.external = 'none';
  doc.diskText = null;
}

const SAVE = 'Save';
const DONT_SAVE = "Don't Save";
const CANCEL = 'Cancel';

async function mayClose(doc: DocState): Promise<boolean> {
  if (!isDirty(doc)) return true;
  const answer = await message(`Do you want to save the changes you made to "${doc.title}"?`, {
    title: 'Lintel',
    kind: 'warning',
    buttons: { yes: SAVE, no: DONT_SAVE, cancel: CANCEL },
  });
  // The dialog returns the clicked label; anything unexpected (Esc, a dismissed sheet) is Cancel.
  if (answer === DONT_SAVE) return true;
  if (answer !== SAVE) return false;
  try {
    if (!(await saveDoc(doc.id))) return false;
  } catch (err) {
    await message(String(err), { title: 'Lintel', kind: 'error' });
    return false;
  }
  // A save already running when Save was chosen wrote an older snapshot (Ruling 42).
  return !isDirty(doc);
}

// The file is already written, so failing here would lose track of it; the chosen
// spelling only weakens duplicate detection in openPaths.
async function normalizedOrAsGiven(path: string): Promise<string> {
  try {
    return await normalizePath(path);
  } catch {
    return path;
  }
}

// A failed release only leaves the file claimed by this window until it closes.
async function release(path: string): Promise<void> {
  // Another tab of this window may still show the file.
  if (findByPath(path)) return;
  try {
    await releasePath(path);
  } catch (err) {
    console.error(`Could not release ${path}:`, err);
  }
}

let reportWatchFailure: (err: unknown) => void = (err) => console.error(err);

/** How a failed watch is reported; the window then says live reload is off (Ruling 265). */
export function setWatchFailureReporter(report: (err: unknown) => void): void {
  reportWatchFailure = report;
}

// Unwatched, the file only stops reloading; nothing is lost.
async function watch(path: string, hash: string): Promise<void> {
  try {
    await watchPath(path, hash);
  } catch (err) {
    reportWatchFailure(err);
  }
}

async function unwatch(path: string): Promise<void> {
  if (findByPath(path)) return;
  try {
    await unwatchPath(path);
  } catch (err) {
    console.error(`Could not stop watching ${path}:`, err);
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
