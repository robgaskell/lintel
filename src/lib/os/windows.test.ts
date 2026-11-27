import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { message } from '@tauri-apps/plugin-dialog';
import { takeStartCursor } from '../docs/cursor.svelte';
import {
  createDoc,
  docs,
  handoffsSettled,
  isDirty,
  removeDoc,
  saveDoc,
  untitledCounter,
  type DocState,
} from '../docs/store.svelte';
import {
  cancelHandoff,
  claimPath,
  completeHandoff,
  readTextFile,
  releasePath,
  transferPath,
  writeTextFile,
} from '../ipc';
import { DEFAULT_SETTINGS, settings } from '../settings/settings.svelte';
import { applyTheme } from '../theme/theme';
import { largeFileNotices, openPaths, setWorkspace } from './open';
import type { Workspace } from '../layout/workspace';
import {
  ADOPT_DOC,
  createAppWindow,
  DOC_ADOPTED,
  docWindowLabels,
  listenForAdoption,
  listenForReveal,
  openDocInNewWindow,
  REVEAL_ANSWER,
  REVEAL_DOC,
  setRestoring,
  whenAdopted,
  WINDOW_READY,
  type AdoptDocEvent,
} from './windows';

type Listener = { event: string; handler: (e: { payload: unknown }) => void; options?: unknown };

const fake = vi.hoisted(() => ({
  listeners: [] as Listener[],
  created: [] as { label: string; options: Record<string, unknown>; destroy: ReturnType<typeof vi.fn> }[],
  // What the new window does: announce itself ready, and confirm it took the doc.
  announce: true,
  acknowledge: true,
  frame: true,
  win: {
    label: 'main',
    isMinimized: vi.fn(async () => true),
    unminimize: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
    setTheme: vi.fn(async () => {}),
    scaleFactor: vi.fn(async () => 2),
    innerSize: vi.fn(),
    outerSize: vi.fn(),
    outerPosition: vi.fn(),
    currentMonitor: vi.fn(),
  },
}));

function deliver(event: string, payload: unknown, label?: string): void {
  for (const l of [...fake.listeners]) {
    const target = (l.options as { target?: { label: string } } | undefined)?.target;
    if (l.event === event && (!target || label === undefined || target.label === label)) {
      l.handler({ payload: JSON.parse(JSON.stringify(payload)) });
    }
  }
}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: Listener['handler'], options?: unknown) => {
    const listener = { event, handler, options };
    fake.listeners.push(listener);
    return () => fake.listeners.splice(fake.listeners.indexOf(listener), 1);
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: vi.fn(function (this: Record<string, unknown>, label: string, options: Record<string, unknown>) {
    const destroy = vi.fn(async () => {});
    fake.created.push({ label, options, destroy });
    this.label = label;
    this.destroy = destroy;
    this.once = async (event: string, cb: () => void) => {
      if (event !== 'tauri://created') return;
      setTimeout(() => {
        cb();
        // The new page mounts and announces itself.
        if (fake.announce) setTimeout(() => deliver(WINDOW_READY, { label }), 0);
      }, 0);
    };
  }),
  getCurrentWebviewWindow: () => ({ setBackgroundColor: async () => {} }),
  getAllWebviewWindows: async () => [{ label: 'main' }, { label: 'settings' }, { label: 'w-1' }],
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => fake.win,
  currentMonitor: () => fake.win.currentMonitor(),
}));
vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  frontendReady: vi.fn(async () => []),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => 1),
  completeHandoff: vi.fn(async () => true),
  cancelHandoff: vi.fn(async () => true),
  setWindowAppearance: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('./recent', () => ({ recordRecent: vi.fn() }));

const workspace = { openDoc: vi.fn(), activate: vi.fn(), closeDoc: vi.fn(async () => true) };

function fileDoc(text = '# a\n'): DocState {
  return createDoc({ path: '/notes/a.md', raw: text, hash: 'h0', mode: 'split' });
}

function adoptEvent(): AdoptDocEvent {
  const call = vi.mocked(emitTo).mock.calls.find(([, event]) => event === ADOPT_DOC);
  if (!call) throw new Error('no adopt-doc event sent');
  return call[2] as AdoptDocEvent;
}

// This window: 1000x700 logical inside a 1000x728 frame at 100,50, on a 1440x900 screen.
function placeThisWindow(x = 100, y = 50) {
  fake.win.innerSize.mockResolvedValue(new PhysicalSize(2000, 1400));
  fake.win.outerSize.mockResolvedValue(new PhysicalSize(2000, 1456));
  fake.win.outerPosition.mockResolvedValue(new PhysicalPosition(x * 2, y * 2));
  fake.win.currentMonitor.mockResolvedValue({
    scaleFactor: 2,
    workArea: { position: new PhysicalPosition(0, 50), size: new PhysicalSize(2880, 1700) },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  largeFileNotices.clear();
  fake.listeners.length = 0;
  fake.created.length = 0;
  fake.announce = true;
  fake.acknowledge = true;
  fake.win.label = 'main';
  vi.mocked(emit).mockClear();
  vi.mocked(emitTo).mockReset();
  vi.mocked(emitTo).mockImplementation(async (label, event, payload) => {
    const sent = payload as AdoptDocEvent;
    if (event === ADOPT_DOC && fake.acknowledge) {
      setTimeout(() => deliver(DOC_ADOPTED, { label, docId: sent.doc.id }), 0);
    }
  });
  vi.mocked(listen).mockClear();
  vi.mocked(claimPath).mockReset();
  vi.mocked(claimPath).mockResolvedValue(null);
  vi.mocked(releasePath).mockReset();
  vi.mocked(releasePath).mockResolvedValue();
  vi.mocked(transferPath).mockReset();
  vi.mocked(transferPath).mockResolvedValue(7);
  vi.mocked(completeHandoff).mockReset();
  vi.mocked(completeHandoff).mockResolvedValue(true);
  vi.mocked(cancelHandoff).mockReset();
  vi.mocked(cancelHandoff).mockResolvedValue(true);
  vi.mocked(writeTextFile).mockReset();
  vi.mocked(message).mockReset();
  workspace.openDoc.mockReset();
  workspace.activate.mockReset();
  workspace.closeDoc.mockClear();
  for (const fn of Object.values(fake.win)) if (typeof fn === 'function') fn.mockClear();
  placeThisWindow();
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  setWorkspace(workspace as unknown as Workspace);
});

describe('createAppWindow', () => {
  it('opens index.html hidden, in the theme and exact background of the app (Ruling 184)', async () => {
    settings.theme = 'dark';
    settings.palettes.dark.background = '#101418';
    applyTheme(settings);

    const win = await createAppWindow('w-1');

    expect(win.label).toBe('w-1');
    expect(fake.created[0]).toMatchObject({
      label: 'w-1',
      options: { url: '/', visible: false, theme: 'dark', backgroundColor: '#101418' },
    });
  });

  it('leaves the theme to the OS when the app follows it', async () => {
    settings.theme = 'system';
    await createAppWindow('w-1');
    expect(fake.created[0].options.theme).toBeUndefined();
  });

  it("opens at this window's size, 28 px right of and below it (Ruling 201)", async () => {
    await createAppWindow('w-1');
    expect(fake.created[0].options).toMatchObject({ x: 128, y: 78, width: 1000, height: 700 });
  });

  it('starts the cascade again at the edge of the screen, so the window stays on it', async () => {
    placeThisWindow(430, 220);
    await createAppWindow('w-1');
    expect(fake.created[0].options).toMatchObject({ x: 0, y: 25, width: 1000, height: 700 });
  });

  it("opens at 1200x800 where the OS likes when this window's frame cannot be read", async () => {
    fake.win.innerSize.mockRejectedValueOnce(new Error('no frame'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createAppWindow('w-1');

    expect(fake.created[0].options).toMatchObject({ width: 1200, height: 800 });
    expect(fake.created[0].options.x).toBeUndefined();
    logged.mockRestore();
  });
});

describe('openDocInNewWindow', () => {
  it('hands a dirty doc over whole: the unsaved buffer and the saved text', async () => {
    const doc = fileDoc('# saved\n');
    doc.text = '# saved\nnot saved yet\n';

    await openDocInNewWindow(doc.id);

    const [label, event] = vi.mocked(emitTo).mock.calls[0];
    expect(label).toMatch(/^w-[0-9a-f-]{36}$/);
    expect(fake.created[0].label).toBe(label);
    expect(event).toBe(ADOPT_DOC);
    const sent = adoptEvent().doc;
    expect(sent.text).toBe('# saved\nnot saved yet\n');
    expect(sent.savedText).toBe('# saved\n');
    expect(sent).toMatchObject({ id: doc.id, path: '/notes/a.md', title: 'a.md', mode: 'split', diskHash: 'h0' });
  });

  it('starts the hand-over in Rust and sends its id with the doc (Ruling 213)', async () => {
    const doc = fileDoc();

    await openDocInNewWindow(doc.id);

    const label = fake.created[0].label;
    expect(transferPath).toHaveBeenCalledWith('/notes/a.md', label);
    expect(adoptEvent().handoff).toBe(7);
    expect(cancelHandoff).not.toHaveBeenCalled();
    expect(vi.mocked(transferPath).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(emitTo).mock.invocationCallOrder[0],
    );
    expect(releasePath).not.toHaveBeenCalled();
  });

  it('removes the doc here without asking, before anything else can run', async () => {
    const doc = fileDoc();
    doc.text = 'dirty';

    await openDocInNewWindow(doc.id);

    expect(docs.has(doc.id)).toBe(false);
    expect(workspace.closeDoc).toHaveBeenCalledWith(doc.id);
    expect(workspace.closeDoc.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transferPath).mock.invocationCallOrder[0],
    );
    expect(message).not.toHaveBeenCalled();
  });

  it('waits for the new window to say it is ready, ignoring other windows', async () => {
    fake.announce = false;
    const doc = fileDoc();

    const moving = openDocInNewWindow(doc.id);
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    deliver(WINDOW_READY, { label: 'w-other' });
    await tick();
    expect(emitTo).not.toHaveBeenCalled();

    deliver(WINDOW_READY, { label: fake.created[0].label });
    await moving;
    expect(emitTo).toHaveBeenCalledOnce();
  });

  it('waits for a save of the doc that is running, and sends what it saved (Ruling 197)', async () => {
    const doc = fileDoc('# saved\n');
    doc.text = '# saving\n';
    let finish: (hash: string) => void = () => {};
    vi.mocked(writeTextFile).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    void saveDoc(doc.id);

    const moving = openDocInNewWindow(doc.id);
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    await tick();
    await tick();
    expect(emitTo).not.toHaveBeenCalled();
    expect(docs.has(doc.id)).toBe(true);

    finish('h1');
    await moving;
    expect(adoptEvent().doc).toMatchObject({ text: '# saving\n', savedText: '# saving\n', diskHash: 'h1' });
  });

  it('closes the new window and sends nothing when the tab closed while it started (Ruling 200)', async () => {
    fake.announce = false;
    const doc = fileDoc();

    const moving = openDocInNewWindow(doc.id);
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    removeDoc(doc.id);
    deliver(WINDOW_READY, { label: fake.created[0].label });
    await moving;

    expect(emitTo).not.toHaveBeenCalled();
    expect(fake.created[0].destroy).toHaveBeenCalled();
    expect(docs.has(doc.id)).toBe(false);
    expect(workspace.openDoc).not.toHaveBeenCalled();
  });

  it('carries the large-file notice and the cursor (Rulings 186, 201)', async () => {
    const doc = fileDoc();
    largeFileNotices.add(doc.id);

    await openDocInNewWindow(doc.id);

    expect(adoptEvent()).toMatchObject({ largeFileNotice: true, cursor: null });
  });

  it('hands an untitled doc over with no path', async () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    doc.text = 'draft';

    await openDocInNewWindow(doc.id);

    expect(transferPath).toHaveBeenCalledWith(null, fake.created[0].label);
    expect(adoptEvent().doc.text).toBe('draft');
  });

  it('does not move a doc over 10,000,000 bytes (Ruling 187)', async () => {
    const doc = fileDoc();
    doc.text = 'x'.repeat(10_000_001);

    await openDocInNewWindow(doc.id);

    expect(fake.created).toHaveLength(0);
    expect(docs.has(doc.id)).toBe(true);
  });

  it('brings the doc back, claim and all, and closes the window when the hand-over fails', async () => {
    const doc = fileDoc();
    doc.text = 'dirty';
    vi.mocked(emitTo).mockRejectedValueOnce(new Error('gone'));

    await expect(openDocInNewWindow(doc.id)).rejects.toThrow('gone');

    const back = docs.get(doc.id);
    expect(back).toMatchObject({ text: 'dirty', savedText: '# a\n', path: '/notes/a.md' });
    expect(workspace.openDoc).toHaveBeenCalledWith(back);
    expect(cancelHandoff).toHaveBeenCalledWith(7);
    expect(claimPath).toHaveBeenLastCalledWith('/notes/a.md');
    expect(fake.created[0].destroy).toHaveBeenCalled();
  });

  it('brings the doc back as an unsaved copy with no path when another window has its file now', async () => {
    const doc = fileDoc();
    vi.mocked(emitTo).mockRejectedValueOnce(new Error('gone'));
    vi.mocked(claimPath).mockResolvedValueOnce('w-3');

    await expect(openDocInNewWindow(doc.id)).rejects.toThrow('gone');

    const back = docs.get(doc.id)!;
    expect(back).toMatchObject({ path: null, title: 'a.md (moved back)', text: '# a\n' });
    expect(isDirty(back)).toBe(true);
  });

  it('leaves the doc in the new window when it took it just as time ran out (Ruling 213)', async () => {
    vi.useFakeTimers();
    try {
      fake.acknowledge = false;
      vi.mocked(cancelHandoff).mockResolvedValueOnce(false);
      const doc = fileDoc();
      const moving = openDocInNewWindow(doc.id);

      await vi.advanceTimersByTimeAsync(10_100);
      await moving;

      expect(cancelHandoff).toHaveBeenCalledWith(7);
      expect(fake.created[0].destroy).not.toHaveBeenCalled();
      expect(docs.has(doc.id)).toBe(false);
      expect(workspace.openDoc).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the doc out with no await between the snapshot and the removal (Ruling 197)', async () => {
    const doc = fileDoc();
    let stillHereAfterSnapshot: boolean | null = null;
    vi.spyOn(largeFileNotices, 'has').mockImplementationOnce(() => {
      queueMicrotask(() => (stillHereAfterSnapshot = docs.has(doc.id)));
      return false;
    });

    await openDocInNewWindow(doc.id);

    expect(stillHereAfterSnapshot).toBe(false);
  });

  it('keeps the claim of the doc it is handing over when another window asks (Ruling 213)', async () => {
    const doc = fileDoc();
    let decide: (id: number) => void = () => {};
    vi.mocked(transferPath).mockImplementationOnce(() => new Promise((resolve) => (decide = resolve)));
    listenForReveal(workspace);

    const moving = openDocInNewWindow(doc.id);
    await vi.waitFor(() => expect(transferPath).toHaveBeenCalled());
    deliver(REVEAL_DOC, { path: '/notes/a.md' }, 'main');
    await tick();

    expect(releasePath).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(REVEAL_ANSWER, { path: '/notes/a.md', shown: true });
    decide(7);
    await moving;
  });

  it('counts as running from the start, while the new window is still starting (Ruling 216)', async () => {
    fake.announce = false;
    const doc = fileDoc();
    const moving = openDocInNewWindow(doc.id);
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    let settled = false;
    const waiting = handoffsSettled().then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);

    deliver(WINDOW_READY, { label: fake.created[0].label });
    await moving;
    await waiting;
    expect(docs.has(doc.id)).toBe(false);
  });

  it('heals a stale claim on the path once the hand-over is over (Ruling 216)', async () => {
    const doc = fileDoc();
    listenForReveal(workspace);
    await openDocInNewWindow(doc.id);

    deliver(REVEAL_DOC, { path: '/notes/a.md' }, 'main');

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(REVEAL_ANSWER, { path: '/notes/a.md', shown: false }),
    );
    expect(releasePath).toHaveBeenCalledWith('/notes/a.md');
  });

  it('brings the doc back when Rust cannot be asked whether the new window took it (Ruling 216)', async () => {
    vi.useFakeTimers();
    try {
      fake.acknowledge = false;
      vi.mocked(cancelHandoff).mockRejectedValueOnce(new Error('ipc down'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const doc = fileDoc();
      const moving = openDocInNewWindow(doc.id);
      const failed = expect(moving).rejects.toThrow('The new window did not start.');

      await vi.advanceTimersByTimeAsync(10_100);
      await failed;

      expect(docs.has(doc.id)).toBe(true);
      expect(fake.created[0].destroy).toHaveBeenCalled();
      logged.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets closing and quitting wait until the hand-over has settled (Ruling 213)', async () => {
    fake.acknowledge = false;
    const doc = fileDoc();
    const moving = openDocInNewWindow(doc.id);
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalled());
    let settled = false;
    const waiting = handoffsSettled().then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);

    deliver(DOC_ADOPTED, { label: fake.created[0].label, docId: doc.id });
    await moving;
    await waiting;
    expect(settled).toBe(true);
  });

  it('brings the doc back when the new window never confirms it took it (Ruling 197)', async () => {
    vi.useFakeTimers();
    try {
      fake.acknowledge = false;
      const doc = fileDoc();
      largeFileNotices.add(doc.id);
      const moving = openDocInNewWindow(doc.id);
      const failed = expect(moving).rejects.toThrow('The new window did not start.');

      await vi.advanceTimersByTimeAsync(9_000);
      expect(fake.created[0].destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_100);
      await failed;

      expect(fake.created[0].destroy).toHaveBeenCalled();
      expect(docs.has(doc.id)).toBe(true);
      expect(largeFileNotices.has(doc.id)).toBe(true);
      expect(cancelHandoff).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up and closes the window when it never says it is ready', async () => {
    vi.useFakeTimers();
    try {
      fake.announce = false;
      const doc = fileDoc();
      const moving = openDocInNewWindow(doc.id);
      const failed = expect(moving).rejects.toThrow('The new window did not start.');

      await vi.advanceTimersByTimeAsync(10_000);
      await failed;

      expect(fake.created[0].destroy).toHaveBeenCalled();
      expect(docs.has(doc.id)).toBe(true);
      expect(transferPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Before any adoption: a new window that has taken nothing in yet behaves differently.
describe('listenForReveal', () => {
  async function listening() {
    listenForReveal(workspace);
    await vi.waitFor(() => expect(fake.listeners).toHaveLength(2));
  }

  function answers() {
    return vi.mocked(emit).mock.calls.filter(([event]) => event === REVEAL_ANSWER).map(([, p]) => p);
  }

  it('shows the tab for the path and says so, leaving the window where it is (Ruling 229)', async () => {
    const doc = fileDoc();
    await listening();
    expect(listen).toHaveBeenCalledWith(REVEAL_DOC, expect.any(Function), {
      target: { kind: 'WebviewWindow', label: 'main' },
    });

    deliver(REVEAL_DOC, { path: '/notes/a.md' }, 'main');

    expect(workspace.activate).toHaveBeenCalledWith(doc.id);
    await vi.waitFor(() => expect(answers()).toEqual([{ path: '/notes/a.md', shown: true }]));
    expect(fake.win.setFocus).not.toHaveBeenCalled();
    expect(fake.win.unminimize).not.toHaveBeenCalled();
    expect(fake.win.show).not.toHaveBeenCalled();
  });

  it('lets go of a stale claim and says so, so the asking window opens the file (Ruling 199)', async () => {
    fileDoc();
    await listening();

    deliver(REVEAL_DOC, { path: '/notes/other.md' }, 'main');

    await vi.waitFor(() => expect(answers()).toEqual([{ path: '/notes/other.md', shown: false }]));
    expect(releasePath).toHaveBeenCalledWith('/notes/other.md');
    expect(vi.mocked(releasePath).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(emit).mock.invocationCallOrder[0],
    );
    expect(workspace.activate).not.toHaveBeenCalled();
    expect(fake.win.setFocus).not.toHaveBeenCalled();
  });

  it('keeps the claim of a doc it has not taken in yet', async () => {
    fake.win.label = 'w-1';
    await listening();

    deliver(REVEAL_DOC, { path: '/notes/a.md' }, 'w-1');

    await vi.waitFor(() => expect(answers()).toEqual([{ path: '/notes/a.md', shown: true }]));
    expect(releasePath).not.toHaveBeenCalled();
  });

  it('keeps the claim of a file it is still opening (Ruling 213)', async () => {
    await listening();
    let finishRead: (r: { text: string; hash: string }) => void = () => {};
    vi.mocked(readTextFile).mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));

    const opening = openPaths(['/notes/a.md']);
    await vi.waitFor(() => expect(readTextFile).toHaveBeenCalled());
    deliver(REVEAL_DOC, { path: '/notes/a.md' }, 'main');
    await vi.waitFor(() => expect(answers()).toEqual([{ path: '/notes/a.md', shown: true }]));

    expect(releasePath).not.toHaveBeenCalled();
    finishRead({ text: '# a\n', hash: 'h' });
    await opening;
  });

  it('passes an answer on to an open in this window that waits for it (Ruling 199)', async () => {
    await listening();
    vi.mocked(readTextFile).mockResolvedValue({ text: '# a\n', hash: 'h' });
    vi.mocked(claimPath).mockResolvedValueOnce('w-1');

    const opening = openPaths(['/notes/a.md']);
    await vi.waitFor(() => expect(claimPath).toHaveBeenCalledOnce());
    deliver(REVEAL_ANSWER, { path: '/notes/a.md', shown: false });
    await opening;

    expect(claimPath).toHaveBeenCalledTimes(2);
    expect(workspace.openDoc).toHaveBeenCalledOnce();
  });
});

describe('listenForAdoption', () => {
  const handedOver: AdoptDocEvent = {
    doc: {
      id: 'moved-1',
      path: '/notes/a.md',
      title: 'a.md',
      text: 'edited',
      savedText: 'saved',
      lineEnding: '\n',
      diskHash: 'h1',
      pinned: false,
      mode: 'edit',
      external: 'none',
      diskText: null,
      lintConfigPath: null,
    },
    largeFileNotice: true,
    cursor: { line: 12, col: 5 },
    handoff: 7,
  };

  it('listens in this window only, then announces it is ready with its label', async () => {
    listenForAdoption();

    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(WINDOW_READY, { label: 'main' }));
    expect(listen).toHaveBeenCalledWith(ADOPT_DOC, expect.any(Function), {
      target: { kind: 'WebviewWindow', label: 'main' },
    });
    expect(vi.mocked(listen).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(emit).mock.invocationCallOrder[0]);
  });

  it("claims the doc's path, opens the doc as it was, then confirms it took it", async () => {
    listenForAdoption();
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());

    deliver(ADOPT_DOC, handedOver, 'main');

    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(DOC_ADOPTED, { label: 'main', docId: 'moved-1' }));
    expect(completeHandoff).toHaveBeenCalledWith(7);
    expect(vi.mocked(completeHandoff).mock.invocationCallOrder[0]).toBeLessThan(
      workspace.openDoc.mock.invocationCallOrder[0],
    );
    expect(claimPath).toHaveBeenCalledWith('/notes/a.md');
    expect(vi.mocked(claimPath).mock.invocationCallOrder[0]).toBeLessThan(
      workspace.openDoc.mock.invocationCallOrder[0],
    );
    const doc = docs.get('moved-1');
    expect(doc).toMatchObject({ text: 'edited', savedText: 'saved', diskHash: 'h1' });
    expect(workspace.openDoc).toHaveBeenCalledWith(doc);
    expect(workspace.openDoc.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(emit).mock.invocationCallOrder.at(-1)!,
    );
    expect(largeFileNotices.has('moved-1')).toBe(true);
    expect(takeStartCursor('moved-1')).toEqual({ line: 12, col: 5 });
    await whenAdopted();
  });

  it('shows nothing when the opener has taken the doc back (Ruling 213)', async () => {
    vi.mocked(completeHandoff).mockResolvedValueOnce(false);
    listenForAdoption();
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());

    deliver(ADOPT_DOC, handedOver, 'main');
    await vi.waitFor(() => expect(completeHandoff).toHaveBeenCalled());
    await tick();

    expect(docs.size).toBe(0);
    expect(workspace.openDoc).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(DOC_ADOPTED, expect.anything());
  });

  it('still opens the doc when the claim fails, so the buffer is never lost', async () => {
    vi.mocked(claimPath).mockRejectedValueOnce(new Error('ipc down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    listenForAdoption();
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());

    deliver(ADOPT_DOC, handedOver, 'main');

    await vi.waitFor(() => expect(docs.has('moved-1')).toBe(true));
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('stops listening when asked', async () => {
    const stop = listenForAdoption();
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());

    stop();
    deliver(ADOPT_DOC, handedOver, 'main');

    expect(fake.listeners).toHaveLength(0);
    expect(docs.size).toBe(0);
  });
});

describe('docWindowLabels', () => {
  it('lists the document windows, never Settings (Ruling 147)', async () => {
    expect(await docWindowLabels()).toEqual(['main', 'w-1']);
  });
});

// Last in the file: a finished restore stays finished for the module.
describe('reveal while the session restores (Ruling 205)', () => {
  function answers() {
    return vi.mocked(emit).mock.calls.filter(([event]) => event === REVEAL_ANSWER).map(([, p]) => p);
  }

  it('keeps the claim and stays hidden, even for a doc it already shows', async () => {
    fake.win.label = 'w-2';
    fileDoc();
    listenForReveal(workspace);
    await vi.waitFor(() => expect(fake.listeners).toHaveLength(2));
    setRestoring(true);

    deliver(REVEAL_DOC, { path: '/notes/a.md' }, 'w-2');
    deliver(REVEAL_DOC, { path: '/notes/other.md' }, 'w-2');

    await vi.waitFor(() => expect(answers()).toHaveLength(2));
    expect(answers()).toEqual([
      { path: '/notes/a.md', shown: true },
      { path: '/notes/other.md', shown: true },
    ]);
    expect(workspace.activate).not.toHaveBeenCalled();
    expect(fake.win.show).not.toHaveBeenCalled();
    expect(releasePath).not.toHaveBeenCalled();
    setRestoring(false);
  });

  it('once restored, a window that took in no doc lets go of a stale claim', async () => {
    // A fresh module: earlier tests have already adopted docs into this one.
    vi.resetModules();
    const fresh = await import('./windows');
    const { emit: freshEmit } = await import('@tauri-apps/api/event');
    const { releasePath: freshRelease } = await import('../ipc');
    fake.win.label = 'w-2';
    fake.listeners.length = 0;
    fresh.listenForReveal(workspace);
    await vi.waitFor(() => expect(fake.listeners).toHaveLength(2));
    fresh.setRestoring(true);
    fresh.setRestoring(false);

    deliver(REVEAL_DOC, { path: '/notes/other.md' }, 'w-2');

    await vi.waitFor(() => expect(freshRelease).toHaveBeenCalledWith('/notes/other.md'));
    const sent = vi.mocked(freshEmit).mock.calls.filter(([event]) => event === REVEAL_ANSWER);
    expect(sent.map(([, p]) => p)).toEqual([{ path: '/notes/other.md', shown: false }]);
  });
});
