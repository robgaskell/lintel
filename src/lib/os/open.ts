import { message } from '@tauri-apps/plugin-dialog';
import { normalizePath, readTextFile, type ReadResult } from '../ipc';
import { createDoc, findByPath, type ViewMode } from '../docs/store.svelte';
import type { Workspace } from '../layout/workspace';

type DocOpener = Pick<Workspace, 'openDoc' | 'activate'>;

// M1.4 replaces this with Settings.defaultMode.
const NEW_DOC_MODE: ViewMode = 'split';

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
      continue;
    }
    const doc = createDoc({ path, raw: result.text, hash: result.hash, mode: NEW_DOC_MODE });
    target.openDoc(doc);
  }
}

export function newUntitled(): void {
  const doc = createDoc({ path: null, raw: '', hash: '', mode: NEW_DOC_MODE });
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
