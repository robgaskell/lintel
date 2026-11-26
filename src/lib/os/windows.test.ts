import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
import { takeStartLine } from '../docs/cursor.svelte';
import { createDoc, docs, untitledCounter, type DocState } from '../docs/store.svelte';
import { claimPath, releasePath } from '../ipc';
import { DEFAULT_SETTINGS, settings } from '../settings/settings.svelte';
import { largeFileNotices, setWorkspace } from './open';
import {
  ADOPT_DOC,
  createAppWindow,
  listenForAdoption,
  listenForReveal,
  openDocInNewWindow,
  REVEAL_DOC,
  whenAdopted,
  WINDOW_READY,
  type AdoptDocEvent,
} from './windows';

type Listener = { event: string; handler: (e: { payload: unknown }) => void; options?: unknown };

const fake = vi.hoisted(() => ({
  listeners: [] as Listener[],
  created: [] as { label: string; options: Record<string, unknown>; destroy: ReturnType<typeof vi.fn> }[],
  // What the next window does once created: announce itself ready, or stay silent.
  announce: true,
  win: {
    label: 'main',
    isMinimized: vi.fn(async () => true),
    unminimize: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
    setTheme: vi.fn(async () => {}),
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
  emitTo: vi.fn(async () => {}),
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
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => fake.win }));
vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
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

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  largeFileNotices.clear();
  fake.listeners.length = 0;
  fake.created.length = 0;
  fake.announce = true;
  vi.mocked(emit).mockClear();
  vi.mocked(emitTo).mockReset();
  vi.mocked(emitTo).mockResolvedValue();
  vi.mocked(listen).mockClear();
  vi.mocked(claimPath).mockReset();
  vi.mocked(claimPath).mockResolvedValue(null);
  vi.mocked(releasePath).mockReset();
  vi.mocked(releasePath).mockResolvedValue();
  vi.mocked(message).mockReset();
  workspace.openDoc.mockReset();
  workspace.activate.mockReset();
  workspace.closeDoc.mockClear();
  for (const fn of Object.values(fake.win)) if (typeof fn === 'function') fn.mockClear();
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  setWorkspace(workspace);
});

describe('createAppWindow', () => {
  it('opens index.html at 1200x800, hidden, in the theme and background of the app (Ruling 184)', async () => {
    settings.theme = 'dark';
    settings.palettes.dark.background = '#101418';

    const win = await createAppWindow('w-1');

    expect(win.label).toBe('w-1');
    expect(fake.created[0]).toMatchObject({
      label: 'w-1',
      options: { url: '/', width: 1200, height: 800, visible: false, theme: 'dark' },
    });
    expect(typeof fake.created[0].options.backgroundColor).toBe('string');
  });

  it('leaves the theme to the OS when the app follows it', async () => {
    settings.theme = 'system';
    await createAppWindow('w-1');
    expect(fake.created[0].options.theme).toBeUndefined();
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

  it('releases the path before handing the doc over', async () => {
    const doc = fileDoc();

    await openDocInNewWindow(doc.id);

    expect(releasePath).toHaveBeenCalledWith('/notes/a.md');
    expect(vi.mocked(releasePath).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(emitTo).mock.invocationCallOrder[0],
    );
  });

  it('removes the doc here without asking, once it is handed over', async () => {
    const doc = fileDoc();
    doc.text = 'dirty';

    await openDocInNewWindow(doc.id);

    expect(docs.has(doc.id)).toBe(false);
    expect(workspace.closeDoc).toHaveBeenCalledWith(doc.id);
    expect(vi.mocked(emitTo).mock.invocationCallOrder[0]).toBeLessThan(
      workspace.closeDoc.mock.invocationCallOrder[0],
    );
    expect(message).not.toHaveBeenCalled();
  });

  it('waits for the new window to say it is ready, ignoring other windows', async () => {
    fake.announce = false;
    const doc = fileDoc();

    const moving = openDocInNewWindow(doc.id);
    await vi.waitFor(() => expect(fake.created).toHaveLength(1));
    deliver(WINDOW_READY, { label: 'w-other' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitTo).not.toHaveBeenCalled();

    deliver(WINDOW_READY, { label: fake.created[0].label });
    await moving;
    expect(emitTo).toHaveBeenCalledOnce();
  });

  it('carries the large-file notice and the cursor line (Ruling 186)', async () => {
    const doc = fileDoc();
    largeFileNotices.add(doc.id);

    await openDocInNewWindow(doc.id);

    expect(adoptEvent()).toMatchObject({ largeFileNotice: true, cursorLine: null });
  });

  it('releases nothing for an untitled doc', async () => {
    const doc = createDoc({ path: null, raw: '', hash: '', mode: 'edit' });
    doc.text = 'draft';

    await openDocInNewWindow(doc.id);

    expect(releasePath).not.toHaveBeenCalled();
    expect(adoptEvent().doc.text).toBe('draft');
  });

  it('does not move a doc over 10,000,000 bytes (Ruling 187)', async () => {
    const doc = fileDoc();
    doc.text = 'x'.repeat(10_000_001);

    await openDocInNewWindow(doc.id);

    expect(fake.created).toHaveLength(0);
    expect(docs.has(doc.id)).toBe(true);
  });

  it('keeps the doc and closes the window when the hand-over fails', async () => {
    const doc = fileDoc();
    vi.mocked(emitTo).mockRejectedValueOnce(new Error('gone'));

    await expect(openDocInNewWindow(doc.id)).rejects.toThrow('gone');

    expect(docs.has(doc.id)).toBe(true);
    expect(claimPath).toHaveBeenCalledWith('/notes/a.md');
    expect(fake.created[0].destroy).toHaveBeenCalled();
    expect(workspace.closeDoc).not.toHaveBeenCalled();
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
      expect(releasePath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
    cursorLine: 12,
  };

  it('listens in this window only, then announces it is ready with its label', async () => {
    listenForAdoption();

    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(WINDOW_READY, { label: 'main' }));
    expect(listen).toHaveBeenCalledWith(ADOPT_DOC, expect.any(Function), {
      target: { kind: 'WebviewWindow', label: 'main' },
    });
    expect(vi.mocked(listen).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(emit).mock.invocationCallOrder[0]);
  });

  it("claims the doc's path, then opens the doc as it was", async () => {
    listenForAdoption();
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());

    deliver(ADOPT_DOC, handedOver, 'main');

    await vi.waitFor(() => expect(workspace.openDoc).toHaveBeenCalledOnce());
    expect(claimPath).toHaveBeenCalledWith('/notes/a.md');
    expect(vi.mocked(claimPath).mock.invocationCallOrder[0]).toBeLessThan(
      workspace.openDoc.mock.invocationCallOrder[0],
    );
    const doc = docs.get('moved-1');
    expect(doc).toMatchObject({ text: 'edited', savedText: 'saved', diskHash: 'h1' });
    expect(workspace.openDoc).toHaveBeenCalledWith(doc);
    expect(largeFileNotices.has('moved-1')).toBe(true);
    expect(takeStartLine('moved-1')).toBe(12);
    await whenAdopted();
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

describe('listenForReveal', () => {
  it('shows the tab for the path and brings this window forward', async () => {
    const doc = fileDoc();
    listenForReveal(workspace);
    await vi.waitFor(() => expect(fake.listeners).toHaveLength(1));
    expect(listen).toHaveBeenCalledWith(REVEAL_DOC, expect.any(Function), {
      target: { kind: 'WebviewWindow', label: 'main' },
    });

    deliver(REVEAL_DOC, { path: '/notes/a.md' }, 'main');

    expect(workspace.activate).toHaveBeenCalledWith(doc.id);
    await vi.waitFor(() => expect(fake.win.setFocus).toHaveBeenCalled());
    expect(fake.win.unminimize).toHaveBeenCalled();
    expect(fake.win.show).toHaveBeenCalled();
  });

  it('does nothing for a path this window does not have open', async () => {
    fileDoc();
    listenForReveal(workspace);
    await vi.waitFor(() => expect(fake.listeners).toHaveLength(1));

    deliver(REVEAL_DOC, { path: '/notes/other.md' }, 'main');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(workspace.activate).not.toHaveBeenCalled();
    expect(fake.win.setFocus).not.toHaveBeenCalled();
  });
});
