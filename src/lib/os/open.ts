import { SvelteSet } from 'svelte/reactivity';
import { message } from '@tauri-apps/plugin-dialog';
import { claimPath, normalizePath, readTextFile, releasePath, type ReadResult } from '../ipc';
import { createDoc, findByPath, isLargeFile, opening, setTabShower } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import { settings } from '../settings/settings.svelte';
import { recordRecent } from './recent';

type DocOpener = Pick<Workspace, 'openDoc' | 'activate' | 'closeDoc'>;

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
export async function openPaths(paths: string[]): Promise<void> {
  const target = requireWorkspace();
  for (const given of paths) {
    let path = given;
    try {
      await openOne(target, given, (normalised) => {
        path = normalised;
        opening.add(path);
      });
    } finally {
      opening.delete(path);
    }
  }
}

// `claiming` names the path before it is claimed, so the claim stays while no tab has it.
async function openOne(
  target: DocOpener,
  given: string,
  claiming: (path: string) => void,
): Promise<void> {
  let path = given;
  let claimed = false;
  let result: ReadResult;
  try {
    path = await normalizePath(given);
    const open = findByPath(path);
    if (open) {
      target.activate(open.id);
      void recordRecent(path);
      return;
    }
    claiming(path);
    if (!(await claimHere(path))) {
      void recordRecent(path);
      return;
    }
    claimed = true;
    result = await readTextFile(path);
  } catch (err) {
    if (claimed) void releaseQuietly(path);
    await message(openErrorText(given, path, err), { title: 'Lintel', kind: 'error' });
    return;
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
}

/**
 * Claims `path` for this window. False when another window shows the file: Rust has shown
 * it there. A window that had the claim but no tab lets go, and then this one claims it.
 */
async function claimHere(path: string): Promise<boolean> {
  // Waiting starts before the claim, as the answer can arrive before the claim returns.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), REVEAL_ANSWER_MS);
    revealWaits.set(path, resolve);
  });
  try {
    if ((await claimPath(path)) === null) return true;
    if (await answer) return false;
    return (await claimPath(path)) === null;
  } finally {
    clearTimeout(timer);
    revealWaits.delete(path);
  }
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
