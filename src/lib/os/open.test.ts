import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { Window } from '@tauri-apps/api/window';
import { message } from '@tauri-apps/plugin-dialog';
import { claimPath, frontendReady, normalizePath, pathsExist, readTextFile, releasePath } from '../ipc';
import { docs, untitledCounter } from '../docs/store.svelte';
import { settings } from '../settings/settings.svelte';
import {
  largeFileNotices,
  listenForDrops,
  listenForOpenFiles,
  newUntitled,
  OPEN_FILES,
  openPaths,
  revealAnswered,
  setWorkspace,
} from './open';
import type { Workspace } from '../layout/workspace';
import { recordRecent } from './recent';

type Handler = (e: { payload: unknown }) => void;

const fake = vi.hoisted(() => ({
  listeners: new Map<string, Handler>(),
  drop: null as Handler | null,
  owner: {
    isMinimized: vi.fn(async () => false),
    isVisible: vi.fn(async () => true),
    unminimize: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
  },
}));

vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => 1),
  completeHandoff: vi.fn(async () => true),
  cancelHandoff: vi.fn(async () => true),
  frontendReady: vi.fn(async () => []),
  pathsExist: vi.fn(async (paths: string[]) => paths.map(() => true)),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    fake.listeners.set(event, handler);
    return () => fake.listeners.delete(event);
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main' }),
  Window: { getByLabel: vi.fn(async () => fake.owner) },
}));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: Handler) => {
      fake.drop = handler;
      return () => {};
    },
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn(),
  save: vi.fn(),
}));
vi.mock('./recent', () => ({ recordRecent: vi.fn() }));

const read = vi.mocked(readTextFile);
const normalize = vi.mocked(normalizePath);
const messageDialog = vi.mocked(message);
const workspace = { openDoc: vi.fn(), activate: vi.fn(), closeDoc: vi.fn(async () => true) };

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  normalize.mockReset();
  normalize.mockImplementation(async (path) => path);
  read.mockReset();
  read.mockImplementation(async (path) => ({ text: `# ${path}\n`, hash: `hash-${path}` }));
  messageDialog.mockReset();
  workspace.openDoc.mockReset();
  workspace.activate.mockReset();
  vi.mocked(recordRecent).mockReset();
  settings.defaultMode = 'split';
  largeFileNotices.clear();
  vi.mocked(claimPath).mockReset();
  vi.mocked(claimPath).mockResolvedValue(null);
  vi.mocked(releasePath).mockReset();
  vi.mocked(releasePath).mockResolvedValue();
  vi.mocked(frontendReady).mockReset();
  vi.mocked(frontendReady).mockResolvedValue([]);
  vi.mocked(pathsExist).mockReset();
  vi.mocked(pathsExist).mockImplementation(async (paths) => paths.map(() => true));
  vi.mocked(Window.getByLabel).mockClear();
  for (const fn of Object.values(fake.owner)) fn.mockClear();
  fake.owner.isMinimized.mockResolvedValue(false);
  fake.owner.isVisible.mockResolvedValue(true);
  fake.listeners.clear();
  fake.drop = null;
  setWorkspace(workspace as unknown as Workspace);
});

// The next claim finds the file in w-1, whose window answers whether it shows it.
function ownedElsewhere(shown: boolean | null) {
  vi.mocked(claimPath).mockImplementationOnce(async (path) => {
    if (shown !== null) setTimeout(() => revealAnswered(path, shown), 0);
    return 'w-1';
  });
}

describe('openPaths and the path registry', () => {
  it('opens the file here when its owner has no tab for it, after the owner lets go (Ruling 199)', async () => {
    ownedElsewhere(false);

    await openPaths(['/a.md']);

    expect(claimPath).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith('/a.md');
    expect(docs.size).toBe(1);
  });

  it('opens nothing when the file is claimed again before this window can', async () => {
    ownedElsewhere(false);
    vi.mocked(claimPath).mockResolvedValueOnce('w-2');

    await openPaths(['/a.md']);

    expect(read).not.toHaveBeenCalled();
    expect(docs.size).toBe(0);
  });

  it('stops waiting for an answer after a second and opens nothing', async () => {
    vi.useFakeTimers();
    try {
      ownedElsewhere(null);
      const opening = openPaths(['/a.md']);
      await vi.advanceTimersByTimeAsync(1000);
      await opening;
      expect(claimPath).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims the normalised path before reading the file', async () => {
    normalize.mockImplementation(async (path) => `/real${path}`);

    await openPaths(['/a.md']);

    expect(claimPath).toHaveBeenCalledWith('/real/a.md');
    expect(vi.mocked(claimPath).mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  });

  it('does not read a file another window owns, and opens nothing here', async () => {
    ownedElsewhere(true);

    await openPaths(['/a.md', '/b.md']);

    expect(read).not.toHaveBeenCalledWith('/a.md');
    expect(read).toHaveBeenCalledWith('/b.md');
    expect(docs.size).toBe(1);
    expect(workspace.openDoc).toHaveBeenCalledTimes(1);
    expect(messageDialog).not.toHaveBeenCalled();
  });

  it('asks nothing of the registry for a doc already open in this window', async () => {
    await openPaths(['/a.md']);
    vi.mocked(claimPath).mockClear();

    await openPaths(['/a.md']);

    expect(claimPath).not.toHaveBeenCalled();
  });

  it('releases the claim when the read fails', async () => {
    read.mockRejectedValueOnce('Lintel opens UTF-8 text files only.');

    await openPaths(['/a.md']);

    expect(releasePath).toHaveBeenCalledWith('/a.md');
    expect(messageDialog).toHaveBeenCalledOnce();
  });

  it('releases nothing when the path cannot be normalised, as nothing was claimed', async () => {
    normalize.mockRejectedValueOnce('No such file: /a.md');

    await openPaths(['/a.md']);

    expect(claimPath).not.toHaveBeenCalled();
    expect(releasePath).not.toHaveBeenCalled();
  });
});

describe('openPaths', () => {
  it('creates one doc when the same path is given twice', async () => {
    await openPaths(['/a.md', '/a.md']);

    expect(docs.size).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(workspace.openDoc).toHaveBeenCalledTimes(1);
  });

  it('activates an already-open doc without reading the file again', async () => {
    await openPaths(['/a.md']);
    const [doc] = docs.values();
    read.mockClear();
    workspace.openDoc.mockClear();

    await openPaths(['/a.md']);

    expect(read).not.toHaveBeenCalled();
    expect(workspace.openDoc).not.toHaveBeenCalled();
    expect(workspace.activate).toHaveBeenCalledWith(doc.id);
  });

  it('opens new docs in split mode with the file text and hash', async () => {
    await openPaths(['/notes/b.md']);

    const [doc] = docs.values();
    expect(doc.path).toBe('/notes/b.md');
    expect(doc.title).toBe('b.md');
    expect(doc.text).toBe('# /notes/b.md\n');
    expect(doc.diskHash).toBe('hash-/notes/b.md');
    expect(doc.mode).toBe('split');
    expect(workspace.openDoc).toHaveBeenCalledWith(doc);
  });

  it('reports an unreadable file and still opens the rest', async () => {
    read.mockImplementation(async (path) => {
      if (path === '/bad.md') throw 'Lintel opens UTF-8 text files only.';
      return { text: 'ok', hash: 'h' };
    });

    await openPaths(['/bad.md', '/good.md']);

    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(messageDialog.mock.calls[0][0]).toContain('bad.md');
    expect(messageDialog.mock.calls[0][0]).toContain('Lintel opens UTF-8 text files only.');
    expect(messageDialog.mock.calls[0][1]).toMatchObject({ kind: 'error' });
    expect([...docs.values()].map((d) => d.path)).toEqual(['/good.md']);
    expect(recordRecent).toHaveBeenCalledOnce();
    expect(recordRecent).toHaveBeenCalledWith('/good.md');
  });

  it('opens new docs in the mode Settings names', async () => {
    settings.defaultMode = 'read';

    await openPaths(['/a.md']);

    expect([...docs.values()][0].mode).toBe('read');
  });
});

describe('openPaths large-file guard', () => {
  it('opens a 2,000,001-byte file in Edit whatever defaultMode says, with the notice', async () => {
    for (const mode of ['split', 'read'] as const) {
      docs.clear();
      settings.defaultMode = mode;
      read.mockResolvedValue({ text: 'a'.repeat(2_000_001), hash: 'h' });

      await openPaths(['/big.md']);

      const [doc] = docs.values();
      expect(doc.mode).toBe('edit');
      expect(largeFileNotices.has(doc.id)).toBe(true);
    }
  });

  it('opens a file of exactly 2,000,000 bytes in the default mode, with no notice', async () => {
    read.mockResolvedValue({ text: 'a'.repeat(2_000_000), hash: 'h' });

    await openPaths(['/edge.md']);

    const [doc] = docs.values();
    expect(doc.mode).toBe('split');
    expect(largeFileNotices.has(doc.id)).toBe(false);
  });

  it('counts UTF-8 bytes, not characters', async () => {
    // 1,000,001 characters of two bytes each.
    read.mockResolvedValue({ text: 'é'.repeat(1_000_001), hash: 'h' });

    await openPaths(['/accents.md']);

    expect([...docs.values()][0].mode).toBe('edit');
  });
});

describe('openPaths and Open Recent', () => {
  it('records each opened file under its normalised path', async () => {
    normalize.mockImplementation(async (path) => path.replace('/./', '/'));

    await openPaths(['/x/./a.md', '/b.md']);

    expect(vi.mocked(recordRecent).mock.calls).toEqual([['/x/a.md'], ['/b.md']]);
  });

  it('does not wait for the record, so a slow store never holds up the next file', async () => {
    vi.mocked(recordRecent).mockReturnValue(new Promise(() => {}));

    const done = await Promise.race([
      openPaths(['/a.md', '/b.md']).then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 100)),
    ]);

    expect(done).toBe('done');
    expect(docs.size).toBe(2);
  });

  it('records a file that was already open, so it moves to the top', async () => {
    await openPaths(['/a.md']);
    vi.mocked(recordRecent).mockClear();

    await openPaths(['/a.md']);

    expect(recordRecent).toHaveBeenCalledWith('/a.md');
  });
});

describe('openPaths with path spellings', () => {
  it('opens one doc for two spellings of the same file, under the normalised path', async () => {
    normalize.mockImplementation(async (path) => path.replace('/./', '/'));

    await openPaths(['/x/./a.md']);
    await openPaths(['/x/a.md']);

    expect(docs.size).toBe(1);
    const [doc] = docs.values();
    expect(doc.path).toBe('/x/a.md');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('/x/a.md');
    expect(workspace.activate).toHaveBeenCalledWith(doc.id);
  });

  it('reports a path that cannot be normalised and still opens the rest', async () => {
    normalize.mockImplementation(async (path) => {
      if (path === '/gone.md') throw 'Could not open /gone.md: No such file or directory';
      return path;
    });

    await openPaths(['/gone.md', '/good.md']);

    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(messageDialog.mock.calls[0][0]).toContain('No such file');
    expect([...docs.values()].map((d) => d.path)).toEqual(['/good.md']);
  });

  it('names the path only once in the error text', async () => {
    read.mockRejectedValue('Could not read /x.md: Permission denied');

    await openPaths(['/x.md']);

    const text = String(messageDialog.mock.calls[0][0]);
    expect(text.split('/x.md').length - 1).toBe(1);
    expect(text).toContain('Permission denied');
  });

  it('creates one doc when two calls open the same path at once', async () => {
    await Promise.all([openPaths(['/a.md']), openPaths(['/a.md'])]);

    expect(docs.size).toBe(1);
    expect(workspace.openDoc).toHaveBeenCalledTimes(1);
  });
});

describe('openPaths and focus (Ruling 229)', () => {
  it('brings the window that shows the file forward, for an open from inside Lintel', async () => {
    ownedElsewhere(true);

    await openPaths(['/a.md']);

    expect(Window.getByLabel).toHaveBeenCalledWith('w-1');
    await vi.waitFor(() => expect(fake.owner.setFocus).toHaveBeenCalled());
  });

  it('leaves every window where it is for an open from outside Lintel', async () => {
    ownedElsewhere(true);

    await openPaths(['/a.md'], { fromOutside: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(Window.getByLabel).not.toHaveBeenCalled();
    expect(fake.owner.setFocus).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('unminimises a minimised owner before focusing it', async () => {
    fake.owner.isMinimized.mockResolvedValue(true);
    fake.owner.isVisible.mockResolvedValue(false);
    ownedElsewhere(true);

    await openPaths(['/a.md']);

    await vi.waitFor(() => expect(fake.owner.setFocus).toHaveBeenCalled());
    expect(fake.owner.unminimize).toHaveBeenCalled();
  });

  it('keeps a hidden owner hidden, as it is still restoring (Ruling 205)', async () => {
    fake.owner.isVisible.mockResolvedValue(false);
    ownedElsewhere(true);

    await openPaths(['/a.md']);
    await vi.waitFor(() => expect(fake.owner.isVisible).toHaveBeenCalled());

    expect(fake.owner.setFocus).not.toHaveBeenCalled();
    expect(fake.owner.show).not.toHaveBeenCalled();
  });
});

describe('listenForOpenFiles (Ruling 230)', () => {
  it('listens to this window before it reports ready, then opens the files sent before', async () => {
    vi.mocked(frontendReady).mockResolvedValue(['/queued.md']);

    listenForOpenFiles();

    await vi.waitFor(() => expect(docs.size).toBe(1));
    expect(listen).toHaveBeenCalledWith(OPEN_FILES, expect.any(Function), {
      target: { kind: 'WebviewWindow', label: 'main' },
    });
    expect(vi.mocked(listen).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(frontendReady).mock.invocationCallOrder[0],
    );
    expect([...docs.values()][0].path).toBe('/queued.md');
  });

  it('opens the files Rust sends later, without bringing any window forward', async () => {
    listenForOpenFiles();
    await vi.waitFor(() => expect(frontendReady).toHaveBeenCalled());
    ownedElsewhere(true);

    fake.listeners.get(OPEN_FILES)!({ payload: { paths: ['/a.md', '/b.md'] } });

    await vi.waitFor(() => expect(docs.size).toBe(1));
    expect([...docs.values()][0].path).toBe('/b.md');
    expect(Window.getByLabel).not.toHaveBeenCalled();
  });
});

describe('listenForDrops (Ruling 232)', () => {
  function drop(payload: unknown) {
    fake.drop!({ payload });
  }

  it('opens dropped files and skips folders', async () => {
    vi.mocked(pathsExist).mockResolvedValue([true, false, true]);
    listenForDrops();
    await vi.waitFor(() => expect(fake.drop).not.toBeNull());

    drop({ type: 'drop', paths: ['/a.md', '/folder', '/notes.txt'], position: { x: 0, y: 0 } });

    await vi.waitFor(() => expect(docs.size).toBe(2));
    expect(pathsExist).toHaveBeenCalledWith(['/a.md', '/folder', '/notes.txt']);
    expect([...docs.values()].map((d) => d.path)).toEqual(['/a.md', '/notes.txt']);
    expect(read).not.toHaveBeenCalledWith('/folder');
  });

  it('reports every file of a drop that failed in one dialog', async () => {
    read.mockImplementation(async (path) => {
      if (path !== '/good.md') throw 'Lintel opens UTF-8 text files only.';
      return { text: 'ok', hash: 'h' };
    });
    listenForDrops();
    await vi.waitFor(() => expect(fake.drop).not.toBeNull());

    drop({ type: 'drop', paths: ['/one.png', '/good.md', '/two.bin'], position: { x: 0, y: 0 } });

    await vi.waitFor(() => expect(messageDialog).toHaveBeenCalled());
    expect(messageDialog).toHaveBeenCalledOnce();
    expect(messageDialog.mock.calls[0][0]).toContain('one.png');
    expect(messageDialog.mock.calls[0][0]).toContain('two.bin');
    expect(docs.size).toBe(1);
  });

  it('does nothing while files are only dragged over the window', async () => {
    listenForDrops();
    await vi.waitFor(() => expect(fake.drop).not.toBeNull());

    drop({ type: 'enter', paths: ['/a.md'], position: { x: 0, y: 0 } });
    drop({ type: 'over', position: { x: 0, y: 0 } });
    drop({ type: 'leave' });
    drop({ type: 'drop', paths: [], position: { x: 0, y: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pathsExist).not.toHaveBeenCalled();
    expect(docs.size).toBe(0);
  });
});

describe('newUntitled', () => {
  it('makes Untitled-1 first, in split mode, and opens it', () => {
    newUntitled();

    const [doc] = docs.values();
    expect(doc.title).toBe('Untitled-1');
    expect(doc.path).toBeNull();
    expect(doc.mode).toBe('split');
    expect(untitledCounter.n).toBe(1);
    expect(workspace.openDoc).toHaveBeenCalledWith(doc);
  });

  it('numbers the next one Untitled-2', () => {
    newUntitled();
    newUntitled();

    expect([...docs.values()].map((d) => d.title)).toEqual(['Untitled-1', 'Untitled-2']);
  });

  it('uses the mode Settings names', () => {
    settings.defaultMode = 'edit';

    newUntitled();

    expect([...docs.values()][0].mode).toBe('edit');
    expect(recordRecent).not.toHaveBeenCalled();
  });
});
