import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import { cursors, type Cursor } from './lib/docs/cursor.svelte';
import { listenForFileEvents, reportLiveReloadOff, setReloadNoticeShower } from './lib/docs/reload';
import { createDoc, docs, setWatchFailureReporter } from './lib/docs/store.svelte';
import { registerView } from './lib/editor/views';
import { dropPrintRootUnlessOpen } from './lib/export/print';
import { findLintConfig } from './lib/ipc';
import { fixAll, type LintIssue } from './lib/lint/lint';
import { lintIssues } from './lib/lint/lintState.svelte';
import { outline } from './lib/layout/outline.svelte';
import { setOutlineChecked, setSplitEnabled, takeAppMenu } from './lib/os/menu';
import { listenForAdoption, listenForReveal } from './lib/os/windows';
import { listenForDrops, listenForOpenFiles, openPaths, setOpenNoticeShower } from './lib/os/open';
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
  stopDrops: (() => {}) as () => void,
  fileEventsReady: Promise.resolve(),
  stopFileEvents: (() => {}) as () => void,
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
    isVisible = (id: string) => id === fake.active;
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
  listenForOpenFiles: vi.fn(),
  listenForDrops: vi.fn(() => fake.stopDrops),
  setOpenNoticeShower: vi.fn(),
  openPaths: vi.fn(async () => {}),
  newUntitled: vi.fn(),
  largeFileNotices: new Set(),
}));
vi.mock('./lib/docs/store.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/docs/store.svelte')>()),
  setWatchFailureReporter: vi.fn(),
}));
vi.mock('./lib/docs/reload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/docs/reload')>()),
  listenForFileEvents: vi.fn(() => ({ ready: fake.fileEventsReady, stop: fake.stopFileEvents })),
  setReloadNoticeShower: vi.fn(),
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
vi.mock('./lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/ipc')>()),
  findLintConfig: vi.fn(async () => null),
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
}));
// Fix all reaches markdownlint only through this module; the lint source is stubbed (Ruling 275).
vi.mock('./lib/lint/lint', () => ({ fixAll: vi.fn() }));
vi.mock('./lib/export/print', () => ({ printDoc: vi.fn(), dropPrintRootUnlessOpen: vi.fn() }));
vi.mock('./lib/lint/lintExtension', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/lint/lintExtension')>()),
  lintExtension: vi.fn(() => []),
  relint: vi.fn(),
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
  (lintIssues as Map<string, LintIssue[] | null>).clear();
  fake.active = null;
  fake.activeListeners.clear();
  fake.layoutListeners.clear();
  fake.alone.clear();
  fake.focusHandler = null;
  fake.label = 'main';
  fake.focused = true;
  fake.fileEventsReady = Promise.resolve();
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

describe('App lint count (M6.1)', () => {
  const issue = (fixable: boolean) => ({ rule: 'MD004', fixable }) as LintIssue;
  const setIssues = (id: string, issues: LintIssue[] | null) => {
    (lintIssues as Map<string, LintIssue[] | null>).set(id, issues);
    flushSync();
  };

  it("shows the active doc's warnings, with Fix all only when one is fixable", () => {
    const a = createDoc({ path: '/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    const b = createDoc({ path: '/b.md', raw: 'y', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { container, queryByRole } = render(App);
    expect(statusText(container)).not.toContain('lint');

    setIssues(a.id, [issue(true), issue(false)]);
    expect(statusText(container)).toContain('2 lint warnings');
    expect(queryByRole('button', { name: 'Fix all' })).not.toBeNull();

    setIssues(b.id, [issue(false)]);
    setActive(b.id);
    expect(statusText(container)).toContain('1 lint warning');
    expect(queryByRole('button', { name: 'Fix all' })).toBeNull();

    setIssues(b.id, null);
    expect(statusText(container)).not.toContain('lint');
  });

  it("fixes the active doc's issues in its own editor, linting again if they are stale", async () => {
    const a = createDoc({ path: '/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    const view = { dispatch: vi.fn() } as unknown as Parameters<typeof registerView>[1];
    const stop = registerView(a.id, view);
    fake.active = a.id;
    const { getByRole } = render(App);
    const issues = [issue(true)];
    setIssues(a.id, issues);

    await fireEvent.click(getByRole('button', { name: 'Fix all' }));

    await vi.waitFor(() => expect(fixAll).toHaveBeenCalledWith(view, issues, { default: true }));
    stop();
  });

  const repoConfig = (text: string) => ({ path: '/repo/.markdownlint.json', format: 'json' as const, text, hash: `hash of ${text}` });

  it("lints a stale Fix all again with the doc's config file (Ruling 282)", async () => {
    vi.mocked(findLintConfig).mockResolvedValue(repoConfig('{ "MD004": { "style": "asterisk" } }'));
    const a = createDoc({ path: '/repo/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    const view = { dispatch: vi.fn() } as unknown as Parameters<typeof registerView>[1];
    const stop = registerView(a.id, view);
    fake.active = a.id;
    const { getByRole } = render(App);
    await vi.waitFor(() => expect(a.lintConfigPath).toBe('/repo/.markdownlint.json'));
    const issues = [issue(true)];
    setIssues(a.id, issues);

    await fireEvent.click(getByRole('button', { name: 'Fix all' }));

    await vi.waitFor(() => expect(fixAll).toHaveBeenCalledWith(view, issues, { MD004: { style: 'asterisk' } }));
    stop();
  });

  it('shows a broken config file in the status bar, with the error on hover (Ruling 287)', async () => {
    vi.mocked(findLintConfig).mockResolvedValue(repoConfig('{ "MD004": }'));
    const a = createDoc({ path: '/repo/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { findByText } = render(App);

    const status = await findByText('Lint config error: .markdownlint.json');
    expect(status.title).toBe('Value expected on line 1.');
  });

  it('looks for config files again when the window gains focus (Ruling 284)', async () => {
    const a = createDoc({ path: '/repo/a.md', raw: 'x', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    render(App);
    await vi.waitFor(() => expect(fake.focusHandler).not.toBeNull());
    vi.mocked(findLintConfig).mockClear();

    fake.focusHandler!({ payload: false });
    expect(findLintConfig).not.toHaveBeenCalled();
    fake.focusHandler!({ payload: true });
    fake.focusHandler!({ payload: true });

    // The second focus is within 5 s of the first (Ruling 298).
    expect(findLintConfig).toHaveBeenCalledExactlyOnceWith('/repo/a.md');
  });

  it("looks up the config of each doc that arrives after the window opened", async () => {
    render(App);
    vi.mocked(findLintConfig).mockClear();

    createDoc({ path: '/repo/new.md', raw: 'x', hash: 'h', mode: 'edit' });

    expect(findLintConfig).toHaveBeenCalledExactlyOnceWith('/repo/new.md');
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

  it('takes files opened from outside once this window has restored, before the other windows open (Ruling 230)', async () => {
    render(App);

    await vi.waitFor(() => expect(restoreAllWindows).toHaveBeenCalled());
    expect(listenForOpenFiles).toHaveBeenCalledOnce();
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0];
    expect(order(restoreWindow)).toBeLessThan(order(listenForOpenFiles));
    expect(order(listenForOpenFiles)).toBeLessThan(order(restoreAllWindows));
  });

  it('takes files opened from outside even when the restore fails', async () => {
    vi.mocked(restoreWindow).mockRejectedValueOnce(new Error('store gone'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(App);

    await vi.waitFor(() => expect(listenForOpenFiles).toHaveBeenCalledOnce());
    quiet.mockRestore();
  });

  it('takes files opened from outside after 2 s when the restore never settles (Ruling 242)', async () => {
    vi.useFakeTimers();
    vi.mocked(restoreWindow).mockReturnValueOnce(new Promise(() => {}));
    render(App);
    await vi.advanceTimersByTimeAsync(1999);
    expect(listenForOpenFiles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(listenForOpenFiles).toHaveBeenCalledOnce();
  });

  it('shows files from outside that did not open in the status bar, with the reasons on hover (Ruling 238)', () => {
    const a = createDoc({ path: '/a.md', raw: '', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { container } = render(App);
    const show = vi.mocked(setOpenNoticeShower).mock.calls[0][0];

    show({ text: 'Could not open 1 file: b.bin', details: 'Could not open /b.bin: not UTF-8' });
    flushSync();

    const status = container.querySelector('footer [role="status"]');
    expect(status?.textContent).toBe('Could not open 1 file: b.bin');
    expect(status?.getAttribute('title')).toBe('Could not open /b.bin: not UTF-8');
  });

  it('shows them with no tab open too', () => {
    const { container } = render(App);
    vi.mocked(setOpenNoticeShower).mock.calls[0][0]({ text: 'Could not open 1 file: b.bin', details: 'why' });
    flushSync();

    expect(container.querySelector('.notice-bar [role="status"]')?.getAttribute('title')).toBe('why');
  });

  it('opens dropped files, and stops listening when the window goes', () => {
    fake.stopDrops = vi.fn();
    const { unmount } = render(App);
    expect(listenForDrops).toHaveBeenCalledOnce();

    unmount();
    expect(fake.stopDrops).toHaveBeenCalledOnce();
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

describe('App live reload (M5.3)', () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockImplementation(async () => settings);
  });

  it("listens for this window's file changes before it restores any doc, and stops when it goes", async () => {
    let listening = () => {};
    fake.fileEventsReady = new Promise((resolve) => (listening = resolve));
    fake.stopFileEvents = vi.fn();
    fake.label = 'w-1';
    const { unmount } = render(App);
    expect(listenForFileEvents).toHaveBeenCalledWith('w-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restoreWindow).not.toHaveBeenCalled();

    listening();
    await vi.waitFor(() => expect(restoreWindow).toHaveBeenCalledWith('w-1'));
    unmount();
    expect(fake.stopFileEvents).toHaveBeenCalledOnce();
  });

  it('shows "<name> reloaded from disk" in the status bar', () => {
    const a = createDoc({ path: '/a.md', raw: '', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { container } = render(App);

    vi.mocked(setReloadNoticeShower).mock.calls[0][0]('a.md reloaded from disk');
    flushSync();

    const status = container.querySelector('footer [role="status"]');
    expect(status?.textContent).toBe('a.md reloaded from disk');
    expect(status?.hasAttribute('title')).toBe(false);
  });

  it('clears the Updated mark of the tab that becomes active', () => {
    const a = createDoc({ path: '/a.md', raw: '', hash: 'h', mode: 'edit' });
    a.external = 'updated';
    render(App);

    setActive(a.id);

    expect(a.external).toBe('none');
  });
});

describe('App live reload switched off (Ruling 265)', () => {
  it('hands the store the reporter, and announces the window once the file listeners are ready', () => {
    render(App);

    expect(setWatchFailureReporter).toHaveBeenCalledWith(reportLiveReloadOff);
    expect(listenForAdoption).toHaveBeenCalledWith(fake.fileEventsReady);
  });
});

describe('App print root', () => {
  it('drops the print root when its doc leaves the window (Ruling 294)', () => {
    const a = createDoc({ path: '/a.md', raw: 'a', hash: 'h', mode: 'read' });
    const b = createDoc({ path: '/b.md', raw: 'b', hash: 'h', mode: 'read' });
    render(App);
    expect(dropPrintRootUnlessOpen).toHaveBeenLastCalledWith(new Set([a.id, b.id]));

    docs.delete(a.id);
    flushSync();
    expect(dropPrintRootUnlessOpen).toHaveBeenLastCalledWith(new Set([b.id]));
  });
});
