import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import { cursors, type Cursor } from './lib/docs/cursor.svelte';
import { createDoc, docs } from './lib/docs/store.svelte';
import { outline } from './lib/layout/outline.svelte';
import { setOutlineChecked, setSplitEnabled, takeAppMenu } from './lib/os/menu';
import { listenForAdoption, listenForReveal } from './lib/os/windows';
import { openPaths } from './lib/os/open';
import { listenForQuitRequests } from './lib/os/quit';
import { knownRecent, recentMayHaveChanged } from './lib/os/recent';
import { restoreAllWindows, restoreWindow, scheduleWindowSave } from './lib/os/session';
import { DEFAULT_SETTINGS, loadSettings, settings } from './lib/settings/settings.svelte';
import App from './App.svelte';

// App's own wiring is under test; everything it calls out to is faked.
const fake = vi.hoisted(() => ({
  active: null as string | null,
  activeListeners: new Set<(id: string | null) => void>(),
  layoutListeners: new Set<() => void>(),
  alone: new Set<string>(),
  focusHandler: null as ((event: { payload: boolean }) => void) | null,
  label: 'main',
  focused: true,
}));

vi.mock('./lib/layout/workspace', () => ({
  Workspace: class {
    activeDocId = () => fake.active;
    onActiveChange(cb: (id: string | null) => void) {
      fake.activeListeners.add(cb);
      return () => fake.activeListeners.delete(cb);
    }
    onLayoutChange(cb: () => void) {
      fake.layoutListeners.add(cb);
      return () => fake.layoutListeners.delete(cb);
    }
    isAloneInGroup = (id: string) => fake.alone.has(id);
    dispose() {}
  },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: fake.label,
    onCloseRequested: async () => () => {},
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      fake.focusHandler = handler;
      return () => {};
    },
    setTheme: async () => {},
    isFocused: async () => fake.focused,
  }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ setBackgroundColor: async () => {} }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock('./lib/os/menu', () => ({
  syncAppMenu: vi.fn(() => () => {}),
  setOutlineChecked: vi.fn(async () => {}),
  setSplitEnabled: vi.fn(async () => {}),
  takeAppMenu: vi.fn(),
}));
vi.mock('./lib/os/windows', () => ({
  listenForAdoption: vi.fn(() => () => {}),
  listenForReveal: vi.fn(() => () => {}),
}));
vi.mock('./lib/os/open', () => ({
  setWorkspace: vi.fn(),
  openPaths: vi.fn(async () => {}),
  newUntitled: vi.fn(),
  largeFileNotices: new Set(),
}));
vi.mock('./lib/os/quit', () => ({ listenForQuitRequests: vi.fn(() => () => {}), quitApp: vi.fn() }));
vi.mock('./lib/os/session', async (importOriginal) => ({
  missingNotice: (await importOriginal<typeof import('./lib/os/session')>()).missingNotice,
  restoreWindow: vi.fn(async () => ({ restored: 0, missing: [] })),
  restoreAllWindows: vi.fn(async () => {}),
  scheduleWindowSave: vi.fn(),
  listenForForgets: vi.fn(() => () => {}),
}));
vi.mock('./lib/os/recent', () => ({
  knownRecent: vi.fn(async () => ['/notes/a.md', '/notes/b.md']),
  getRecent: vi.fn(async () => ['/notes/a.md', '/notes/b.md']),
  onRecentChanged: () => () => {},
  recentMayHaveChanged: vi.fn(),
  recordRecent: vi.fn(),
  clearRecent: vi.fn(),
}));
vi.mock('./lib/settings/settings.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/settings/settings.svelte')>()),
  loadSettings: vi.fn(async () => {}),
  onSettingsChanged: vi.fn(() => () => {}),
}));

function setActive(id: string | null) {
  fake.active = id;
  for (const cb of fake.activeListeners) cb(id);
  flushSync();
}

function setCursor(id: string, cursor: Cursor) {
  (cursors as Map<string, Cursor>).set(id, cursor);
  flushSync();
}

const statusText = (container: HTMLElement) =>
  container.querySelector('footer')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

beforeEach(() => {
  docs.clear();
  (cursors as Map<string, Cursor>).clear();
  fake.active = null;
  fake.activeListeners.clear();
  fake.layoutListeners.clear();
  fake.alone.clear();
  fake.focusHandler = null;
  fake.label = 'main';
  fake.focused = true;
  outline.visible = true;
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.theme;
  vi.clearAllMocks();
});

afterEach(() => vi.useRealTimers());

describe('App status bar (Ruling 120)', () => {
  it('shows the active doc at mount and follows tab changes', () => {
    const a = createDoc({ path: '/a.md', raw: 'one two', hash: 'h', mode: 'edit' });
    const b = createDoc({ path: null, raw: 'x y z', hash: '', mode: 'edit' });
    setCursor(a.id, { line: 3, col: 4 });
    fake.active = a.id;
    const { container } = render(App);

    expect(statusText(container)).toContain('Ln 3, Col 4 · 2 words · Saved');

    setActive(b.id);
    expect(statusText(container)).toContain('Ln 1, Col 1 · 3 words · Not saved yet');

    b.text = 'x y z w';
    flushSync();
    expect(statusText(container)).toContain('Unsaved');
  });

  it('counts words after the debounce on edit, and at once on a tab switch', () => {
    vi.useFakeTimers();
    const a = createDoc({ path: '/a.md', raw: 'one two', hash: 'h', mode: 'edit' });
    const b = createDoc({ path: '/b.md', raw: 'solo', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { container } = render(App);

    a.text = 'one two three';
    flushSync();
    vi.advanceTimersByTime(149);
    flushSync();
    expect(statusText(container)).toContain('2 words');
    vi.advanceTimersByTime(1);
    flushSync();
    expect(statusText(container)).toContain('3 words');

    setActive(b.id);
    expect(statusText(container)).toContain('1 word ·');
  });

  it('shows reading time in Read mode', () => {
    const a = createDoc({ path: '/a.md', raw: 'one two', hash: 'h', mode: 'read' });
    fake.active = a.id;
    const { container } = render(App);

    expect(statusText(container)).toContain('2 words · 1 min read');
    expect(statusText(container)).not.toContain('Ln');
  });
});

describe('App empty state (Ruling 120)', () => {
  it('shows Open, New and recent files when there are no tabs, and no status bar', async () => {
    const { container, findByRole, queryByText } = render(App);

    const recent = await findByRole('button', { name: /^b\.md/ });
    expect(knownRecent).toHaveBeenCalledWith(5);
    expect(container.querySelector('footer')).toBeNull();

    await fireEvent.click(recent);
    await vi.waitFor(() => expect(openPaths).toHaveBeenCalledWith(['/notes/b.md']));
    // Through the menu's handler, which also refreshes the recent list.
    await vi.waitFor(() => expect(recentMayHaveChanged).toHaveBeenCalled());

    createDoc({ path: '/c.md', raw: '', hash: 'h', mode: 'edit' });
    flushSync();
    expect(queryByText('Recent')).toBeNull();
  });
});

describe('App outline tick (Ruling 120)', () => {
  it('ticks Show Outline to match this window when it gains focus', async () => {
    render(App);
    await vi.waitFor(() => expect(fake.focusHandler).not.toBeNull());

    outline.visible = false;
    fake.focusHandler!({ payload: false });
    expect(setOutlineChecked).not.toHaveBeenCalled();

    fake.focusHandler!({ payload: true });
    expect(setOutlineChecked).toHaveBeenCalledWith(false);
  });
});

describe('App with several windows (M4.3)', () => {
  it('listens for moved docs and for reveals once the workspace is mounted', () => {
    render(App);

    expect(listenForAdoption).toHaveBeenCalledOnce();
    expect(listenForReveal).toHaveBeenCalledOnce();
    expect(vi.mocked(listenForReveal).mock.calls[0][0]).toHaveProperty('activeDocId');
  });

  it('takes the app menu when the window gains focus, not when it loses it (Ruling 188)', async () => {
    render(App);
    await vi.waitFor(() => expect(fake.focusHandler).not.toBeNull());

    fake.focusHandler!({ payload: false });
    expect(takeAppMenu).not.toHaveBeenCalled();
    fake.focusHandler!({ payload: true });
    expect(takeAppMenu).toHaveBeenCalledOnce();
  });
});

describe('App outline (Rulings 181, 191)', () => {
  it('leaves the outline to the panes, with none beside the dock', () => {
    const a = createDoc({ path: '/a.md', raw: '# A\n', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { container } = render(App);

    expect(container.querySelector('.work > nav')).toBeNull();
    expect(container.querySelector('.work')?.firstElementChild?.classList.contains('dock')).toBe(true);
  });
});

describe('App View > Split (Ruling 192)', () => {
  function layoutChanged() {
    for (const cb of fake.layoutListeners) cb();
  }

  it('greys out Split Right and Split Down while the active tab is alone in its group', () => {
    const a = createDoc({ path: '/a.md', raw: '', hash: 'h', mode: 'edit' });
    const b = createDoc({ path: '/b.md', raw: '', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    fake.alone.add(a.id);
    render(App);
    expect(setSplitEnabled).toHaveBeenLastCalledWith(false);

    fake.alone.clear();
    layoutChanged();
    expect(setSplitEnabled).toHaveBeenLastCalledWith(true);

    fake.active = b.id;
    fake.alone.add(b.id);
    layoutChanged();
    expect(setSplitEnabled).toHaveBeenLastCalledWith(false);
  });

  it('greys them out with no tab open, and sets them again when the window gains focus', async () => {
    render(App);
    expect(setSplitEnabled).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(fake.focusHandler).not.toBeNull());
    vi.mocked(setSplitEnabled).mockClear();

    fake.focusHandler!({ payload: true });
    expect(setSplitEnabled).toHaveBeenCalledWith(false);
  });
});

describe('App theme (Ruling 128)', () => {
  it('leaves the restored theme alone until the stored settings load, then applies them (Ruling 150)', async () => {
    let finishLoad = () => {};
    vi.mocked(loadSettings).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = () => {
            settings.theme = 'dark';
            settings.fontSize = 20;
            resolve(settings);
          };
        }),
    );
    render(App);
    const root = document.documentElement;
    // No defaults painted over what main.ts restored: a forced theme would flash.
    expect(root.dataset.theme).toBeUndefined();
    expect(root.style.getPropertyValue('--size-read')).toBe('');

    finishLoad();

    await vi.waitFor(() => expect(root.dataset.theme).toBe('dark'));
    expect(root.style.getPropertyValue('--bg')).toBe('#181817');
    expect(root.style.getPropertyValue('--size-edit')).toBe('18px');
  });
});

describe('App session (Rulings 205, 209, 212)', () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockImplementation(async () => settings);
  });

  it('restores this window after the settings load, and main reopens the other windows', async () => {
    let finishLoad = () => {};
    vi.mocked(loadSettings).mockImplementation(() => new Promise((resolve) => (finishLoad = () => resolve(settings))));
    render(App);
    expect(restoreWindow).not.toHaveBeenCalled();

    finishLoad();

    await vi.waitFor(() => expect(restoreAllWindows).toHaveBeenCalled());
    expect(restoreWindow).toHaveBeenCalledWith('main');
    expect(listenForQuitRequests).toHaveBeenCalled();
  });

  it('reopens no other windows from a second window', async () => {
    fake.label = 'w-1';
    render(App);
    await vi.waitFor(() => expect(restoreWindow).toHaveBeenCalledWith('w-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restoreAllWindows).not.toHaveBeenCalled();
  });

  it('shows how many files were not found until the next key, in the status bar', async () => {
    vi.mocked(restoreWindow).mockResolvedValueOnce({ restored: 1, missing: ['/gone.md'] });
    const a = createDoc({ path: '/a.md', raw: 'one', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { container } = render(App);

    await vi.waitFor(() => expect(statusText(container)).toContain('1 file from last session was not found'));
    await fireEvent.keyDown(window, { key: 'a' });
    expect(statusText(container)).not.toContain('not found');
  });

  it('clears the notice after 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(restoreWindow).mockResolvedValueOnce({ restored: 1, missing: ['/x.md', '/y.md'] });
    const a = createDoc({ path: '/a.md', raw: 'one', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { container } = render(App);
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(statusText(container)).toContain('2 files from last session were not found');

    await vi.advanceTimersByTimeAsync(10_000);
    flushSync();
    expect(statusText(container)).not.toContain('not found');
  });

  it('saves the session after a layout, pin, mode or outline change', () => {
    const a = createDoc({ path: '/a.md', raw: 'one', hash: 'h', mode: 'edit' });
    render(App);
    flushSync();
    const save = vi.mocked(scheduleWindowSave);
    save.mockClear();

    for (const cb of fake.layoutListeners) cb();
    expect(save).toHaveBeenCalledTimes(1);
    a.pinned = true;
    flushSync();
    expect(save).toHaveBeenCalledTimes(2);
    a.mode = 'read';
    flushSync();
    expect(save).toHaveBeenCalledTimes(3);
    outline.visible = false;
    flushSync();
    expect(save).toHaveBeenCalledTimes(4);
    a.text = 'typing is not a session change';
    flushSync();
    expect(save).toHaveBeenCalledTimes(4);
    expect(save).toHaveBeenLastCalledWith('main');
  });
});

describe('App after a restore (Ruling 235)', () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockImplementation(async () => settings);
  });

  it('shows the not-found notice in an empty window, where there is no status bar', async () => {
    vi.mocked(restoreWindow).mockResolvedValueOnce({ restored: 0, missing: ['/gone.md'] });
    const { container } = render(App);

    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        '1 file from last session was not found',
      ),
    );
  });

  it('ticks View > Show Outline with the outline the restore brought back', async () => {
    vi.mocked(restoreWindow).mockImplementationOnce(async () => {
      outline.visible = false;
      return { restored: 1, missing: [] };
    });
    render(App);

    await vi.waitFor(() => expect(setOutlineChecked).toHaveBeenLastCalledWith(false));
  });

  it('leaves the tick to the focused window when this one is in the background', async () => {
    fake.focused = false;
    vi.mocked(restoreWindow).mockImplementationOnce(async () => {
      outline.visible = false;
      return { restored: 1, missing: [] };
    });
    render(App);
    await vi.waitFor(() => expect(restoreWindow).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setOutlineChecked).not.toHaveBeenCalledWith(false);
  });
});
