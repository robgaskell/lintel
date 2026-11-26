import { load, type Store } from '@tauri-apps/plugin-store';
import { pathsExist } from '../ipc';

/** Persisted in recent.json. */
export interface RecentFiles {
  version: 1;
  paths: string[]; // newest first, no duplicates, at most 20
}

const FILE = 'recent.json';
const MAX_STORED = 20;

/**
 * Moves `path` to the top of the list. Never rejects: the open or save that called it
 * has already succeeded, so a store failure is only logged (Ruling 49).
 */
export async function recordRecent(path: string): Promise<void> {
  try {
    await oneAtATime(async () => {
      const paths = await readPaths();
      await writePaths([path, ...paths.filter((p) => p !== path)].slice(0, MAX_STORED));
    });
  } catch (err) {
    console.error(`Could not add ${path} to Open Recent:`, err);
    return;
  }
  notify();
}

/** The newest `limit` paths whose files still exist. Missing ones are dropped for good. */
export async function getRecent(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  return oneAtATime(async () => {
    const paths = await readPaths();
    const found = await pathsExist(paths);
    const present = paths.filter((_, i) => found[i]);
    if (present.length < paths.length) await writePaths(present);
    return present.slice(0, limit);
  });
}

export async function clearRecent(): Promise<void> {
  await oneAtATime(() => writePaths([]));
  notify();
}

const listeners = new Set<() => void>();

/** Calls `cb` after each change to the list. Returns an unsubscribe. */
export function onRecentChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(): void {
  for (const cb of listeners) cb();
}

let queue: Promise<unknown> = Promise.resolve();

// Each change reads, then writes the list; overlapping ones would drop each other's paths.
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function readPaths(): Promise<string[]> {
  const store = await recentStore();
  if ((await store.get('version')) !== 1) return [];
  const paths = await store.get<unknown>('paths');
  return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
}

async function writePaths(paths: string[]): Promise<void> {
  const store = await recentStore();
  await store.set('version', 1);
  await store.set('paths', paths);
  await store.save();
}

let opened: Promise<Store> | null = null;

// One store instance per file is shared by every window, so it is never closed.
function recentStore(): Promise<Store> {
  opened ??= load(FILE, { autoSave: false }).catch((err) => {
    opened = null;
    throw err;
  });
  return opened;
}
