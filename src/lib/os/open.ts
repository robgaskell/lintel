import { SvelteSet } from 'svelte/reactivity';
import { message } from '@tauri-apps/plugin-dialog';
import { claimPath, normalizePath, readTextFile, releasePath, type ReadResult } from '../ipc';
import { createDoc, findByPath } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import { settings } from '../settings/settings.svelte';
import { recordRecent } from './recent';

type DocOpener = Pick<Workspace, 'openDoc' | 'activate' | 'closeDoc'>;

let workspace: DocOpener | null = null;

/** Docs opened in Edit because they are large; DocPane shows the notice while an id is here. */
export const largeFileNotices: Set<string> = new SvelteSet<string>();

// Spec: above 2 MB a tab opens in Edit only (1 MB = 1,000,000 bytes, Ruling 78).
const LARGE_FILE_BYTES = 2_000_000;

export function setWorkspace(target: DocOpener): void {
  workspace = target;
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
    let claimed = false;
    let result: ReadResult;
    try {
      path = await normalizePath(given);
      const open = findByPath(path);
      if (open) {
        target.activate(open.id);
        void recordRecent(path);
        continue;
      }
      // Rust has already shown the file in the window that owns it.
      if ((await claimPath(path)) !== null) {
        void recordRecent(path);
        continue;
      }
      claimed = true;
      result = await readTextFile(path);
    } catch (err) {
      if (claimed) void releaseQuietly(path);
      await message(openErrorText(given, path, err), { title: 'Lintel', kind: 'error' });
      continue;
    }
    // Another openPaths call may have opened it while this read was in flight.
    const raced = findByPath(path);
    if (raced) {
      target.activate(raced.id);
    } else {
      const { text: raw, hash } = result;
      // raw is the file's text before newline changes, so its UTF-8 length is the file size.
      const large = new TextEncoder().encode(raw).length > LARGE_FILE_BYTES;
      const doc = createDoc({ path, raw, hash, mode: large ? 'edit' : settings.defaultMode });
      if (large) largeFileNotices.add(doc.id);
      target.openDoc(doc);
    }
    // Not awaited: a slow store must not hold up the next file (Ruling 71).
    void recordRecent(path);
  }
}

export function newUntitled(): void {
  const doc = createDoc({ path: null, raw: '', hash: '', mode: settings.defaultMode });
  requireWorkspace().openDoc(doc);
}

/** This window's Workspace. Throws before App has mounted it. */
export function requireWorkspace(): DocOpener {
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
