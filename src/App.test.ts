import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import { cursors, type Cursor } from './lib/docs/cursor.svelte';
import { createDoc, docs } from './lib/docs/store.svelte';
import { outline } from './lib/layout/outline.svelte';
import { setOutlineChecked, setSplitEnabled } from './lib/os/menu';
import { openPaths } from './lib/os/open';
import { knownRecent, recentMayHaveChanged } from './lib/os/recent';
import { DEFAULT_SETTINGS, loadSettings, settings } from './lib/settings/settings.svelte';
import App from './App.svelte';

// App's own wiring is under test; everything it calls out to is faked.
const fake = vi.hoisted(() => ({
  active: null as string | null,
  activeListeners: new Set<(id: string | null) => void>(),
  layoutListeners: new Set<() => void>(),
  alone: new Set<string>(),
  focusHandler: null as ((event: { payload: boolean }) => void) | null,
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
    onCloseRequested: async () => () => {},
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      fake.focusHandler = handler;
      return () => {};
    },
    setTheme: async () => {},
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock('./lib/os/menu', () => ({
  syncAppMenu: vi.fn(() => () => {}),
  setOutlineChecked: vi.fn(async () => {}),
  setSplitEnabled: vi.fn(async () => {}),
}));
vi.mock('./lib/os/open', () => ({
  setWorkspace: vi.fn(),
  openPaths: vi.fn(async () => {}),
  newUntitled: vi.fn(),
  largeFileNotices: new Set(),
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
