import { SvelteSet } from 'svelte/reactivity';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';
import {
  claimPath,
  frontendReady,
  normalizePath,
  pathsExist,
  readTextFile,
  releasePath,
  type ReadResult,
} from '../ipc';
import { createDoc, findByPath, isLargeFile, opening, setTabShower } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import { settings } from '../settings/settings.svelte';
import { recordRecent } from './recent';

type DocOpener = Pick<Workspace, 'openDoc' | 'activate' | 'closeDoc'>;

/** Sent by Rust with files opened from Finder, the `lintel` command or launch arguments. */
export const OPEN_FILES = 'lintel://open-files';

export interface OpenFilesEvent {
  paths: string[];
}

export interface OpenOptions {
  /** Opened from outside Lintel: no window is brought forward (Ruling 229). */
  fromOutside?: boolean;
  /** One dialog lists every file that failed, as for a drop (Ruling 232). */
  oneDialog?: boolean;
}

// The whole Workspace, as the session and quit code read its layout and tab order (Ruling 207).
let workspace: Workspace | null = null;

/** Docs opened in Edit because they are large; DocPane shows the notice while an id is here. */
export const largeFileNotices: Set<string> = new SvelteSet<string>();

// An owner that does not answer in time is taken to show the file.
const REVEAL_ANSWER_MS = 1000;
const revealWaits = new Map<string, (shown: boolean) => void>();

/** Passes on the owner's answer to a reveal this window asked for (Ruling 199). */
export function revealAnswered(path: string, shown: boolean): void {
  revealWaits.get(path)?.(shown);
}

export function setWorkspace(target: Workspace): void {
  workspace = target;
  setTabShower((id) => target.activate(id));
}

/**
 * Every route that opens files ends here. Paths are normalised first, so an already-open
 * file is activated, not reopened, whichever spelling reaches it (Ruling 44). A file open
 * in another window is shown there instead (Ruling 185).
 */
export async function openPaths(paths: string[], options: OpenOptions = {}): Promise<void> {
  const target = requireWorkspace();
  const failures: string[] = [];
  for (const given of paths) {
    let path = given;
    let failure: string | null;
    try {
      failure = await openOne(target, given, options, (normalised) => {
        path = normalised;
        opening.add(path);
      });
    } finally {
      opening.delete(path);
    }
    if (failure === null) continue;
    if (options.oneDialog) failures.push(failure);
    else await showOpenError(failure);
  }
  if (failures.length > 0) await showOpenError(failures.join('\n\n'));
}

/**
 * Opens the files Rust sends to this window. Listens before it reports ready, so no file
 * sent in between is lost (Ruling 230).
 */
export function listenForOpenFiles(): void {
  const label = getCurrentWindow().label;
  const open = (paths: string[]) =>
    openPaths(paths, { fromOutside: true }).catch((err) => console.error('Could not open files:', err));
  listen<OpenFilesEvent>(OPEN_FILES, ({ payload }) => void open(payload.paths), {
    target: { kind: 'WebviewWindow', label },
  })
    .then(() => frontendReady())
    .then(open)
    .catch((err) => console.error('Could not take files opened from outside:', err));
}

/** Opens files dropped on this window. Returns a function that stops listening. */
export function listenForDrops(): () => void {
  const stop = getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'drop') void openDropped(payload.paths);
  });
  stop.catch((err) => console.error('Could not listen for dropped files:', err));
  return () => void stop.then((unlisten) => unlisten()).catch(() => {});
}

// Folders are skipped; any other file opens as File > Open's "All files" would (Ruling 232).
async function openDropped(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const isFile = await pathsExist(paths);
    await openPaths(
      paths.filter((_, i) => isFile[i]),
      { oneDialog: true },
    );
  } catch (err) {
    console.error('Could not open the dropped files:', err);
  }
}

// `claiming` names the path before it is claimed, so the claim stays while no tab has it.
// Resolves to the error text when the file could not be opened.
async function openOne(
  target: DocOpener,
  given: string,
  { fromOutside = false }: OpenOptions,
  claiming: (path: string) => void,
): Promise<string | null> {
  let path = given;
  let claimed = false;
  let result: ReadResult;
  try {
    path = await normalizePath(given);
    const open = findByPath(path);
    if (open) {
      target.activate(open.id);
      void recordRecent(path);
      return null;
    }
    claiming(path);
    const owner = await claimHere(path);
    if (owner !== null) {
      if (!fromOutside) void bringForward(owner);
      void recordRecent(path);
      return null;
    }
    claimed = true;
    result = await readTextFile(path);
  } catch (err) {
    if (claimed) void releaseQuietly(path);
    return openErrorText(given, path, err);
  }
  // Another openPaths call may have opened it while this read was in flight.
  const raced = findByPath(path);
  if (raced) {
    target.activate(raced.id);
  } else {
    const { text: raw, hash } = result;
    const large = isLargeFile(raw);
    const doc = createDoc({ path, raw, hash, mode: large ? 'edit' : settings.defaultMode });
    if (large) largeFileNotices.add(doc.id);
    target.openDoc(doc);
  }
  // Not awaited: a slow store must not hold up the next file (Ruling 71).
  void recordRecent(path);
  return null;
}

/**
 * Claims `path` for this window: null once it does, else the label of the window that
 * shows the file, as Rust has asked it to. A window that had the claim but no tab lets go,
 * and then this one claims it.
 */
async function claimHere(path: string): Promise<string | null> {
  // Waiting starts before the claim, as the answer can arrive before the claim returns.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), REVEAL_ANSWER_MS);
    revealWaits.set(path, resolve);
  });
  try {
    const owner = await claimPath(path);
    if (owner === null) return null;
    if (await answer) return owner;
    return await claimPath(path);
  } finally {
    clearTimeout(timer);
    revealWaits.delete(path);
  }
}

// A hidden window is restoring its session and stays hidden (Ruling 205).
async function bringForward(label: string): Promise<void> {
  try {
    const win = await Window.getByLabel(label);
    if (!win) return;
    if (await win.isMinimized()) await win.unminimize();
    else if (!(await win.isVisible())) return;
    await win.setFocus();
  } catch (err) {
    console.error('Could not bring the window forward:', err);
  }
}

function showOpenError(text: string): Promise<unknown> {
  return message(text, { title: 'Lintel', kind: 'error' });
}

export function newUntitled(): void {
  const doc = createDoc({ path: null, raw: '', hash: '', mode: settings.defaultMode });
  requireWorkspace().openDoc(doc);
}

/** This window's Workspace. Throws before App has mounted it. */
export function requireWorkspace(): Workspace {
  if (!workspace) throw new Error('openPaths called before setWorkspace');
  return workspace;
}

// A failed release only leaves the file claimed by this window until it closes.
async function releaseQuietly(path: string): Promise<void> {
  try {
    await releasePath(path);
  } catch (err) {
    console.error(`Could not release ${path}:`, err);
  }
}

// Most Rust errors already name the path; add it only when they do not.
function openErrorText(given: string, normalised: string, err: unknown): string {
  const text = String(err);
  if (text.includes(given) || text.includes(normalised)) return text;
  return `Could not open ${given}: ${text}`;
}
