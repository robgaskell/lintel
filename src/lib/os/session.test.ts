import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTopLine } from '../docs/cursor.svelte';
import { createDoc, docs, untitledCounter } from '../docs/store.svelte';
import { claimPath, pathsExist, readTextFile } from '../ipc';
import { outline } from '../layout/outline.svelte';
import { Workspace } from '../layout/workspace';
import { calls, fakeStore, resetFakes } from '../../test/fakes';
import { setWorkspace } from './open';
import {
  forgetWindowSession,
  missingNotice,
  restoreAllWindows,
  restoreWindow,
  saveWindowSession,
  scheduleWindowSave,
  toWindowSession,
  type WindowSession,
} from './session';
import { createAppWindow, docWindowLabels, setRestoring } from './windows';

vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule));
vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  pathsExist: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  setWindowAppearance: vi.fn(async () => {}),
}));
vi.mock('./windows', () => ({
  createAppWindow: vi.fn(async () => ({})),
  docWindowLabels: vi.fn(async () => ['main']),
  setRestoring: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', setTheme: async () => {} }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ setBackgroundColor: async () => {} }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));

const store = () => fakeStore('session.json');
const fakeLayout = { grid: 'saved' };
const workspace = {
  toJSON: vi.fn(() => fakeLayout),
  fromJSON: vi.fn(),
  docIdsInOrder: vi.fn(() => [...docs.keys()]),
};

function fileDoc(path: string) {
  return createDoc({ path, raw: `# ${path}\n`, hash: 'h', mode: 'split' });
}

function session(tabs: WindowSession['tabs'], extra: Partial<WindowSession> = {}): WindowSession {
  return { label: 'main', layout: fakeLayout, tabs, outlineVisible: true, ...extra };
}

beforeEach(() => {
  resetFakes();
  docs.clear();
  untitledCounter.n = 0;
  outline.visible = true;
  vi.clearAllMocks();
  vi.mocked(pathsExist).mockImplementation(async (paths) => paths.map(() => true));
  vi.mocked(readTextFile).mockImplementation(async (path) => ({ text: `# ${path}\n`, hash: `h-${path}` }));
  vi.mocked(claimPath).mockResolvedValue(null);
  setWorkspace(workspace as unknown as Workspace);
});

afterEach(() => vi.useRealTimers());

describe('toWindowSession', () => {
  it('leaves out untitled docs and keeps pin, mode, topLine and outline visibility', () => {
    const a = fileDoc('/notes/a.md');
    a.pinned = true;
    a.mode = 'read';
    setTopLine(a.id, 42);
    createDoc({ path: null, raw: '', hash: '', mode: 'edit' });

    const saved = toWindowSession(workspace as unknown as Workspace, false, 'w-1');

    expect(saved).toEqual({
      label: 'w-1',
      layout: fakeLayout,
      tabs: { [a.id]: { path: '/notes/a.md', pinned: true, mode: 'read', topLine: 42 } },
      outlineVisible: false,
    });
  });

  it('saves a fractional scroll line as a whole 1-based line', () => {
    const a = fileDoc('/notes/a.md');
    setTopLine(a.id, 7.6);
    expect(toWindowSession(workspace, true, 'main').tabs[a.id].topLine).toBe(7);
  });
});

describe('saveWindowSession', () => {
  it("writes key window:w-1 and touches no other key", async () => {
    store().data.set('version', 1);
    store().data.set('window:main', { keep: true });
    await restoreWindow('w-1');
    fileDoc('/notes/a.md');
    calls.length = 0;

    await saveWindowSession('w-1');

    expect(calls).toEqual(['set session.json window:w-1', 'save session.json']);
    expect(store().data.get('window:main')).toEqual({ keep: true });
    expect(store().data.get('window:w-1')).toMatchObject({ label: 'w-1', layout: fakeLayout });
  });

  it('rewrites a session of another version as version 1 (Ruling 210)', async () => {
    store().data.set('version', 2);
    store().data.set('window:old', { shape: 'unknown' });
    await restoreWindow('w-2');

    await saveWindowSession('w-2');

    expect(store().data.get('version')).toBe(1);
    expect(store().data.has('window:old')).toBe(false);
    expect(store().data.has('window:w-2')).toBe(true);
  });

  it('writes nothing before the window has restored, so the saved session stays', async () => {
    store().data.set('version', 1);
    store().data.set('window:w-3', session({}, { label: 'w-3' }));

    await saveWindowSession('w-3');

    expect(calls).toEqual([]);
  });

  it('saves 1 s after the last change, once (Ruling 209)', async () => {
    await restoreWindow('w-4');
    vi.useFakeTimers();
    scheduleWindowSave('w-4');
    await vi.advanceTimersByTimeAsync(600);
    scheduleWindowSave('w-4');
    await vi.advanceTimersByTimeAsync(999);
    expect(store().saves).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(store().saves).toBe(1);
    expect(store().data.has('window:w-4')).toBe(true);
  });
});

describe('forgetWindowSession', () => {
  it('deletes only its own key and cancels a pending save', async () => {
    store().data.set('version', 1);
    store().data.set('window:main', { keep: true });
    await restoreWindow('w-5');
    await saveWindowSession('w-5');
    vi.useFakeTimers();
    scheduleWindowSave('w-5');

    await forgetWindowSession('w-5');
    await vi.advanceTimersByTimeAsync(2000);
    await saveWindowSession('w-5');

    expect(store().data.has('window:w-5')).toBe(false);
    expect(store().data.get('window:main')).toEqual({ keep: true });
  });
});

describe('restoreWindow', () => {
  it('reopens each tab under its saved id, with pin, mode and line, then lays them out', async () => {
    store().data.set('version', 1);
    store().data.set(
      'window:w-6',
      session({ 'id-a': { path: '/a.md', pinned: true, mode: 'read', topLine: 12 } }, { outlineVisible: false }),
    );

    const result = await restoreWindow('w-6');

    expect(result).toEqual({ restored: 1, missing: [] });
    const a = docs.get('id-a');
    expect(a).toMatchObject({ path: '/a.md', pinned: true, mode: 'read', text: '# /a.md\n' });
    expect(workspace.fromJSON).toHaveBeenCalledWith(fakeLayout);
    expect(outline.visible).toBe(false);
    expect(toWindowSession(workspace, false, 'w-6').tabs['id-a'].topLine).toBe(12);
    expect(vi.mocked(setRestoring).mock.calls).toEqual([[true], [false]]);
  });

  it('restores the rest when a file is gone, and returns the gone one in missing', async () => {
    store().data.set('version', 1);
    store().data.set(
      'window:w-7',
      session({
        'id-a': { path: '/a.md', pinned: false, mode: 'split', topLine: 1 },
        'id-gone': { path: '/gone.md', pinned: false, mode: 'split', topLine: 1 },
        'id-c': { path: '/c.md', pinned: false, mode: 'edit', topLine: 3 },
      }),
    );
    vi.mocked(pathsExist).mockImplementation(async (paths) => paths.map((p) => p !== '/gone.md'));

    const result = await restoreWindow('w-7');

    expect(result).toEqual({ restored: 2, missing: ['/gone.md'] });
    expect([...docs.keys()].sort()).toEqual(['id-a', 'id-c']);
    expect(readTextFile).not.toHaveBeenCalledWith('/gone.md');
  });

  it('ignores a store with version 2 (fresh start) without throwing', async () => {
    store().data.set('version', 2);
    store().data.set('window:w-8', session({ 'id-a': { path: '/a.md', pinned: false, mode: 'split', topLine: 1 } }));

    await expect(restoreWindow('w-8')).resolves.toEqual({ restored: 0, missing: [] });
    await expect(restoreAllWindows()).resolves.toBeUndefined();

    expect(docs.size).toBe(0);
    expect(workspace.fromJSON).not.toHaveBeenCalled();
    expect(createAppWindow).not.toHaveBeenCalled();
  });

  it('leaves a file another window already shows to that window', async () => {
    store().data.set('version', 1);
    store().data.set('window:w-9', session({ 'id-a': { path: '/a.md', pinned: false, mode: 'split', topLine: 1 } }));
    vi.mocked(claimPath).mockResolvedValue('main');

    expect(await restoreWindow('w-9')).toEqual({ restored: 0, missing: [] });
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('never records restored files in Open Recent and shows no dialog', async () => {
    const { message } = await import('@tauri-apps/plugin-dialog');
    store().data.set('version', 1);
    store().data.set('window:w-10', session({ 'id-a': { path: '/a.md', pinned: false, mode: 'split', topLine: 1 } }));
    vi.mocked(readTextFile).mockRejectedValue(new Error('not UTF-8'));

    expect(await restoreWindow('w-10')).toEqual({ restored: 0, missing: ['/a.md'] });
    expect(message).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.includes('recent.json'))).toEqual([]);
  });
});

describe('restoreAllWindows', () => {
  it('opens every saved window but main and Settings', async () => {
    store().data.set('version', 1);
    for (const label of ['main', 'w-1', 'w-2', 'settings']) store().data.set(`window:${label}`, session({}));
    vi.mocked(docWindowLabels).mockResolvedValue(['main', 'w-2']);

    await restoreAllWindows();

    expect(vi.mocked(createAppWindow).mock.calls).toEqual([['w-1']]);
  });
});

describe('missingNotice', () => {
  it('counts the files in words (Ruling 212)', () => {
    expect(missingNotice(1)).toBe('1 file from last session was not found');
    expect(missingNotice(3)).toBe('3 files from last session were not found');
  });
});

describe('a real Workspace round trip', () => {
  let host: HTMLElement;
  let ws: Workspace;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    ws = new Workspace(host);
    setWorkspace(ws);
  });

  afterEach(() => {
    ws.dispose();
    host.remove();
  });

  it('brings back every tab and split, untitled left out', async () => {
    const a = fileDoc('/a.md');
    const b = fileDoc('/b.md');
    const c = fileDoc('/c.md');
    const untitled = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    for (const doc of [a, b, c, untitled]) ws.openDoc(doc);
    ws.split(b.id, 'right');
    await restoreWindow('w-11');
    await saveWindowSession('w-11');
    const order = ws.docIdsInOrder().filter((id) => id !== untitled.id);

    // Relaunch: a fresh window with no docs.
    ws.dispose();
    docs.clear();
    ws = new Workspace(host);
    setWorkspace(ws);
    await restoreWindow('w-11');

    expect(ws.groupCount()).toBe(2);
    expect(ws.docIdsInOrder()).toEqual(order);
    expect(docs.has(untitled.id)).toBe(false);
  });
});
