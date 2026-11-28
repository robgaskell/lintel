import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import { EditorView } from '@codemirror/view';
import { cursors, type Cursor } from './lib/docs/cursor.svelte';
import { listenForFileEvents, reportLiveReloadOff, setReloadNoticeShower } from './lib/docs/reload';
import { createDoc, docs, setWatchFailureReporter } from './lib/docs/store.svelte';
import { registerView, setEditorsLocked } from './lib/editor/views';
import { dropStalePrintRoot } from './lib/export/print';
import { findLintConfig } from './lib/ipc';
import { fixAll, type LintIssue } from './lib/lint/lint';
import { lintIssues } from './lib/lint/lintState.svelte';
import { outline, outlineSources } from './lib/layout/outline.svelte';
import type { Workspace } from './lib/layout/workspace';
import { setOutlineChecked, setSplitEnabled, takeAppMenu } from './lib/os/menu';
import { listenForAdoption, listenForReveal } from './lib/os/windows';
import { listenForDrops, listenForOpenFiles, openPaths, setOpenNoticeShower } from './lib/os/open';
import { listenForQuitRequests } from './lib/os/quit';
import { knownRecent, recentMayHaveChanged } from './lib/os/recent';
import { restoreAllWindows, restoreWindow, scheduleWindowSave } from './lib/os/session';
import { restartToUpdate, type UpdateState } from './lib/os/updater';
import { handleCloseRequested } from './lib/os/window';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, settings } from './lib/settings/settings.svelte';
import { eventModule } from './test/fakes';
import App from './App.svelte';

// App's own wiring is under test; everything it calls out to is faked.
const fake = vi.hoisted(() => ({
  active: null as string | null,
  activeListeners: new Set<(id: string | null) => void>(),
  layoutListeners: new Set<() => void>(),
  alone: new Set<string>(),
  focusHandler: null as ((event: { payload: boolean }) => void) | null,
  closeHandler: null as ((event: { preventDefault(): void }) => unknown) | null,
  label: 'main',
  focused: true,
  stopDrops: (() => {}) as () => void,
  fileEventsReady: Promise.resolve(),
  stopFileEvents: (() => {}) as () => void,
  realWorkspace: false,
  workspace: null as unknown,
}));

vi.mock('./lib/layout/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/layout/workspace')>();
  class FakeWorkspace {
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
  }
  return {
    // A few tests need dockview's real groups and panes beside App's own layout.
    Workspace: class {
      constructor(el: HTMLElement) {
        const ws = fake.realWorkspace ? new actual.Workspace(el) : new FakeWorkspace();
        fake.workspace = ws;
        return ws;
      }
    },
  };
});
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: fake.label,
    onCloseRequested: async (handler: (event: { preventDefault(): void }) => unknown) => {
      fake.closeHandler = handler;
      return () => {};
    },
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
  // No Settings window, so the toolbar's Split buttons act here.
  WebviewWindow: { getByLabel: async () => null },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock('./lib/os/menu', () => ({
  syncAppMenu: vi.fn(() => () => {}),
  setOutlineChecked: vi.fn(async () => {}),
  setSplitEnabled: vi.fn(async () => {}),
  setToolbarChecked: vi.fn(async () => {}),
  takeAppMenu: vi.fn(),
  runHistory: vi.fn(async () => {}),
}));
// Settings changes arrive as Rust's app-wide event, as another window's save sends it.
vi.mock('@tauri-apps/api/event', () => import('./test/fakes').then((f) => f.eventModule));
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
vi.mock('./lib/os/window', () => ({ handleCloseRequested: vi.fn(async () => {}) }));
vi.mock('./lib/editor/views', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/editor/views')>()),
  setEditorsLocked: vi.fn(),
}));
// Rust's update service, as the window hears it.
const updates = vi.hoisted(() => ({ send: (_state: UpdateState) => {} }));
vi.mock('./lib/os/updater', () => ({
  followUpdates: vi.fn((onState: (state: UpdateState) => void) => {
    updates.send = onState;
    return () => {};
  }),
  restartToUpdate: vi.fn(async () => {}),
}));
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
vi.mock('./lib/export/print', () => ({ printDoc: vi.fn(), dropStalePrintRoot: vi.fn() }));
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
  fake.realWorkspace = false;
  fake.workspace = null;
  outline.visible = true;
  outline.collapsed = false;
  outline.width = 210;
  outlineSources.clear();
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

describe('App update ready (Ruling 343)', () => {
  const ready: UpdateState = {
    status: 'ready',
    version: '0.1.1',
    error: null,
    appVersion: '0.1.0',
    lastChecked: 1,
    revision: 3,
  };

  it('shows "Update ready: restart" in the status bar, which restarts through the quit prompts', async () => {
    const a = createDoc({ path: '/a.md', raw: 'one', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { getByRole, queryByRole } = render(App);
    expect(queryByRole('button', { name: 'Update ready: restart' })).toBeNull();

    updates.send({ ...ready, status: 'downloading' });
    flushSync();
    expect(queryByRole('button', { name: 'Update ready: restart' })).toBeNull();
    updates.send(ready);
    flushSync();
    await fireEvent.click(getByRole('button', { name: 'Update ready: restart' }));

    expect(restartToUpdate).toHaveBeenCalledOnce();
  });

  it('locks every editor under an overlay while the update installs, and unlocks if it fails (Ruling 349)', () => {
    const a = createDoc({ path: '/a.md', raw: 'one', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    const { queryByText } = render(App);
    updates.send(ready);
    flushSync();
    expect(setEditorsLocked).toHaveBeenLastCalledWith(false);

    updates.send({ ...ready, status: 'installing', revision: 4 });
    flushSync();
    expect(queryByText('Installing update…')).toBeTruthy();
    expect(setEditorsLocked).toHaveBeenLastCalledWith(true);

    updates.send({ ...ready, revision: 5 });
    flushSync();
    expect(queryByText('Installing update…')).toBeNull();
    expect(setEditorsLocked).toHaveBeenLastCalledWith(false);
  });

  it('refuses to close the window while the update installs, and closes again if it fails (Ruling 353)', async () => {
    render(App);
    updates.send({ ...ready, status: 'installing', revision: 4 });
    flushSync();
    const refused = { preventDefault: vi.fn() };
    await fake.closeHandler!(refused);
    expect(refused.preventDefault).toHaveBeenCalledOnce();
    expect(handleCloseRequested).not.toHaveBeenCalled();

    updates.send({ ...ready, revision: 5 });
    flushSync();
    const allowed = { preventDefault: vi.fn() };
    await fake.closeHandler!(allowed);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(handleCloseRequested).toHaveBeenCalledWith(allowed, expect.anything());
  });

  it('shows it in the empty window too, which has no status bar', async () => {
    const { container, getByRole } = render(App);
    expect(container.querySelector('footer')).toBeNull();

    updates.send(ready);
    flushSync();
    const button = getByRole('button', { name: 'Update ready: restart' });
    expect(button.closest('footer')?.classList.contains('notice-bar')).toBe(true);
    await fireEvent.click(button);

    expect(restartToUpdate).toHaveBeenCalledOnce();
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

describe('App outline column (v0.2 items 7, 8)', () => {
  const column = (container: HTMLElement) => container.querySelector<HTMLElement>('.outline-column');
  function headings(id: string, text: string) {
    outlineSources.set(id, { headings: [{ level: 1, text, id: 'h', line: 1 }], activeLine: 1, pick: vi.fn() });
  }

  it("puts the column first in the work area, left of the dock, for the active tab's headings", () => {
    const a = createDoc({ path: '/a.md', raw: '# A\n', hash: 'h', mode: 'edit' });
    const b = createDoc({ path: '/b.md', raw: '# B\n', hash: 'h', mode: 'edit' });
    headings(a.id, 'A');
    headings(b.id, 'B');
    fake.active = a.id;
    const { container } = render(App);

    const work = container.querySelector('.work')!;
    expect(work.firstElementChild).toBe(column(container));
    expect(column(container)?.nextElementSibling?.classList.contains('dock')).toBe(true);
    expect(column(container)?.textContent).toContain('A');

    setActive(b.id);
    expect(column(container)?.textContent).toContain('B');
  });

  it('shows no column in an empty window, so the empty state stays centred (Ruling 9 of the v0.2 ledger)', async () => {
    const { container, getByRole } = render(App);
    await vi.waitFor(() => expect(getByRole('button', { name: 'Open a file' })).toBeTruthy());

    expect(column(container)).toBeNull();
  });

  it('starts at the top of the work area with the toolbar hidden too', () => {
    settings.showToolbar = false;
    const a = createDoc({ path: '/a.md', raw: '# A\n', hash: 'h', mode: 'edit' });
    headings(a.id, 'A');
    fake.active = a.id;
    const { container } = render(App);

    expect(container.querySelector('.app')?.firstElementChild?.classList.contains('work')).toBe(true);
    expect(container.querySelector('.work')?.firstElementChild).toBe(column(container));
  });

  it('keeps Outline pressed while the column is collapsed (Ruling 9 of the v0.2 ledger)', async () => {
    const a = createDoc({ path: '/a.md', raw: '# A\n', hash: 'h', mode: 'edit' });
    headings(a.id, 'A');
    fake.active = a.id;
    const { container, getByRole } = render(App);
    await vi.waitFor(() => expect(container.querySelector('[role="toolbar"][aria-label="Window"]')).not.toBeNull());

    await fireEvent.click(getByRole('button', { name: 'Collapse Outline' }));

    expect(getByRole('button', { name: 'Expand Outline' })).toBeTruthy();
    const pressed = container.querySelector('[aria-label="Window"] button[aria-label="Outline"]');
    expect(pressed?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('App outline column beside real tab groups (v0.2 items 7, 8)', () => {
  const column = () => document.querySelector<HTMLElement>('.app .outline-column');
  const link = (text: string) => [...(column()?.querySelectorAll('a') ?? [])].find((a) => a.textContent === text);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  };

  beforeEach(() => {
    fake.realWorkspace = true;
  });

  async function app() {
    const view = render(App);
    await vi.waitFor(() => expect(view.container.querySelector('[role="toolbar"][aria-label="Window"]')).not.toBeNull());
    const ws = fake.workspace as Workspace;
    return { ...view, ws };
  }

  function doc(name: string, raw = `# ${name}\n\ntext\n\n## ${name} two\n`) {
    return createDoc({ path: `/notes/${name}.md`, raw, hash: 'h', mode: 'split' });
  }

  it('after Split Down, is one outline left of the dock and below the toolbar, in no pane', async () => {
    const { container, getByRole, ws } = await app();
    const [a, b] = [doc('a'), doc('b')];
    ws.openDoc(a);
    ws.openDoc(b);
    await vi.waitFor(() => expect(getByRole('button', { name: 'Split Down' }).getAttribute('aria-disabled')).toBe('false'));

    await fireEvent.click(getByRole('button', { name: 'Split Down' }));
    await vi.waitFor(() => expect(ws.groupCount()).toBe(2));
    await vi.waitFor(() => expect(link('b two')).toBeDefined());

    const outlines = container.querySelectorAll('nav[aria-label="Outline"]');
    expect(outlines).toHaveLength(1);
    const col = outlines[0].closest('.outline-column')!;
    expect(col.parentElement?.classList.contains('work')).toBe(true);
    expect(col.nextElementSibling?.classList.contains('dock')).toBe(true);
    expect(col.parentElement?.previousElementSibling?.getAttribute('aria-label')).toBe('Window');
    expect(col.closest('[data-doc-pane], .dv-groupview')).toBeNull();
  });

  it('follows the active tab from group to group', async () => {
    const { ws } = await app();
    const [a, b] = [doc('a'), doc('b')];
    ws.openDoc(a);
    ws.openDoc(b);
    ws.split(b.id, 'right');
    await vi.waitFor(() => expect(link('b two')).toBeDefined());

    ws.activate(a.id);
    await vi.waitFor(() => expect(link('a two')).toBeDefined());
    expect(link('b two')).toBeUndefined();

    ws.activate(b.id);
    await vi.waitFor(() => expect(link('b two')).toBeDefined());
  });

  // Without Ruling 195's guards: the column is outside every group, so dockview never sees these.
  it('picks a heading in the active doc and leaves the active group alone', async () => {
    const { ws } = await app();
    const [a, b] = [doc('a'), doc('b')];
    ws.openDoc(a);
    ws.openDoc(b);
    ws.split(b.id, 'right');
    await vi.waitFor(() => expect(link('b two')).toBeDefined());
    const target = link('b two')!;

    // As a browser does: a press focuses the link unless its mousedown is cancelled.
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    target.dispatchEvent(down);
    if (!down.defaultPrevented) target.focus();
    await settle();
    (link('b two') ?? target).click();
    await settle();

    expect(ws.activeDocId()).toBe(b.id);
    const editor = document.querySelector(`[data-doc-pane="${b.id}"] .cm-editor`) as HTMLElement;
    const view = EditorView.findFromDOM(editor)!;
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it('leaves the active group alone when the keyboard moves into the column', async () => {
    const { ws } = await app();
    const [a, b] = [doc('a'), doc('b')];
    ws.openDoc(a);
    ws.openDoc(b);
    ws.split(b.id, 'right');
    await vi.waitFor(() => expect(link('b two')).toBeDefined());

    link('b two')!.focus();
    await settle();

    expect(ws.activeDocId()).toBe(b.id);
    expect(link('b two')).toBeDefined();
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

describe('App window toolbar (v0.2 items 5, 6)', () => {
  const toolbar = (container: HTMLElement) => container.querySelector('[role="toolbar"][aria-label="Window"]');
  const button = (container: HTMLElement, name: string) =>
    toolbar(container)?.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement | null;
  function layoutChanged() {
    for (const cb of fake.layoutListeners) cb();
    flushSync();
  }

  it('puts the toolbar in its own row above the tab groups', async () => {
    const { container } = render(App);

    await vi.waitFor(() => expect(toolbar(container)).not.toBeNull());
    expect(container.querySelector('.app')?.firstElementChild).toBe(toolbar(container));
    expect(toolbar(container)?.nextElementSibling?.classList.contains('work')).toBe(true);
  });

  it('greys out the split buttons exactly when View > Split Right and Split Down are', async () => {
    const a = createDoc({ path: '/a.md', raw: '', hash: 'h', mode: 'edit' });
    fake.active = a.id;
    fake.alone.add(a.id);
    const { container } = render(App);
    await vi.waitFor(() => expect(toolbar(container)).not.toBeNull());
    const splitsEnabled = () => [button(container, 'Split Right')!, button(container, 'Split Down')!].map((b) => b.getAttribute('aria-disabled') !== 'true');

    expect(setSplitEnabled).toHaveBeenLastCalledWith(false);
    expect(splitsEnabled()).toEqual([false, false]);

    fake.alone.clear();
    layoutChanged();
    expect(setSplitEnabled).toHaveBeenLastCalledWith(true);
    expect(splitsEnabled()).toEqual([true, true]);

    fake.active = null;
    layoutChanged();
    expect(setSplitEnabled).toHaveBeenLastCalledWith(false);
    expect(splitsEnabled()).toEqual([false, false]);
  });

  it('presses Outline while this window shows its outline', async () => {
    const { container } = render(App);
    await vi.waitFor(() => expect(toolbar(container)).not.toBeNull());
    expect(button(container, 'Outline')?.getAttribute('aria-pressed')).toBe('true');

    outline.visible = false;
    flushSync();
    expect(button(container, 'Outline')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('hides the toolbar while Show Toolbar is off, and follows a change saved in another window', async () => {
    const actual = await vi.importActual<typeof import('./lib/settings/settings.svelte')>(
      './lib/settings/settings.svelte',
    );
    vi.mocked(onSettingsChanged).mockImplementation(actual.onSettingsChanged);
    onTestFinished(() => {
      vi.mocked(onSettingsChanged).mockImplementation(() => () => {});
    });
    const { container } = render(App);
    await vi.waitFor(() => expect(toolbar(container)).not.toBeNull());
    await vi.waitFor(() => expect(onSettingsChanged).toHaveBeenCalled());
    let revision = 1_000_000 + Date.now();

    await eventModule.emit('lintel://settings-changed', { revision: ++revision, changes: { showToolbar: false } });
    await vi.waitFor(() => expect(toolbar(container)).toBeNull());
    expect(settings.showToolbar).toBe(false);

    await eventModule.emit('lintel://settings-changed', { revision: ++revision, changes: { showToolbar: true } });
    await vi.waitFor(() => expect(toolbar(container)).not.toBeNull());
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

  it('saves the session after a layout, pin, mode or outline change, collapse and width included', () => {
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
    outline.collapsed = true;
    flushSync();
    expect(save).toHaveBeenCalledTimes(5);
    outline.width = 300;
    flushSync();
    expect(save).toHaveBeenCalledTimes(6);
    a.text = 'typing is not a session change';
    flushSync();
    expect(save).toHaveBeenCalledTimes(6);
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
  it('checks the print root against the active doc on a tab change or an edit (Ruling 302)', () => {
    const a = createDoc({ path: '/a.md', raw: 'a', hash: 'h', mode: 'read' });
    const b = createDoc({ path: '/b.md', raw: 'b', hash: 'h', mode: 'read' });
    fake.active = a.id;
    render(App);
    expect(dropStalePrintRoot).toHaveBeenLastCalledWith({ id: a.id, text: 'a' });

    a.text = 'a, edited';
    flushSync();
    expect(dropStalePrintRoot).toHaveBeenLastCalledWith({ id: a.id, text: 'a, edited' });

    setActive(b.id);
    expect(dropStalePrintRoot).toHaveBeenLastCalledWith({ id: b.id, text: 'b' });

    docs.delete(b.id);
    setActive(null);
    expect(dropStalePrintRoot).toHaveBeenLastCalledWith(undefined);
  });
});
