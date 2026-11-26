import { message } from '@tauri-apps/plugin-dialog';
import { normalizePath, readTextFile, type ReadResult } from '../ipc';
import { createDoc, findByPath } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';
import { settings } from '../settings/settings.svelte';
import { recordRecent } from './recent';

type DocOpener = Pick<Workspace, 'openDoc' | 'activate'>;

let workspace: DocOpener | null = null;

export function setWorkspace(target: DocOpener): void {
  workspace = target;
}

/**
 * Every route that opens files ends here. Paths are normalised first, so an already-open
 * file is activated, not reopened, whichever spelling reaches it (Ruling 44).
 */
export async function openPaths(paths: string[]): Promise<void> {
  const target = requireWorkspace();
  for (const given of paths) {
    let path = given;
    let result: ReadResult;
    try {
      path = await normalizePath(given);
      const open = findByPath(path);
      if (open) {
        target.activate(open.id);
        void recordRecent(path);
        continue;
      }
      result = await readTextFile(path);
    } catch (err) {
      await message(openErrorText(given, path, err), { title: 'Lintel', kind: 'error' });
      continue;
    }
    // Another openPaths call may have opened it while this read was in flight.
    const raced = findByPath(path);
    if (raced) {
      target.activate(raced.id);
    } else {
      const { text: raw, hash } = result;
      target.openDoc(createDoc({ path, raw, hash, mode: settings.defaultMode }));
    }
    // Not awaited: a slow store must not hold up the next file (Ruling 71).
    void recordRecent(path);
  }
}

export function newUntitled(): void {
  const doc = createDoc({ path: null, raw: '', hash: '', mode: settings.defaultMode });
  requireWorkspace().openDoc(doc);
}

function requireWorkspace(): DocOpener {
  if (!workspace) throw new Error('openPaths called before setWorkspace');
  return workspace;
}

// Most Rust errors already name the path; add it only when they do not.
function openErrorText(given: string, normalised: string, err: unknown): string {
  const text = String(err);
  if (text.includes(given) || text.includes(normalised)) return text;
  return `Could not open ${given}: ${text}`;
}
