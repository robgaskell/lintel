import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { restoreTheme, setsWindowAppearance } from './lib/theme/theme';

vi.mock('svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('svelte')>()),
  mount: vi.fn(() => ({})),
}));
vi.mock('./App.svelte', () => ({ default: 'App' }));
vi.mock('./settings/SettingsApp.svelte', () => ({ default: 'SettingsApp' }));
vi.mock('./lib/theme/theme', () => ({ restoreTheme: vi.fn(), setsWindowAppearance: vi.fn() }));
const win = vi.hoisted(() => ({ label: 'main', show: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));
const adoption = vi.hoisted(() => ({ resolve: () => {}, promise: Promise.resolve() }));
vi.mock('./lib/os/windows', () => ({ whenAdopted: () => adoption.promise }));
const restoration = vi.hoisted(() => ({ resolve: () => {}, promise: Promise.resolve() }));
vi.mock('./lib/os/session', () => ({ whenRestored: () => restoration.promise }));

// Frames run only when the test says so.
let frames: FrameRequestCallback[] = [];
function nextFrame() {
  const due = frames;
  frames = [];
  for (const cb of due) cb(performance.now());
}

// `restored`: main and restored windows show once their session is back (Ruling 205).
async function start(search: string, label = 'main', { restored = label === 'main' } = {}) {
  win.label = label;
  adoption.promise = new Promise<void>((resolve) => (adoption.resolve = resolve));
  restoration.promise = new Promise<void>((resolve) => (restoration.resolve = resolve));
  if (restored) restoration.resolve();
  history.replaceState(null, '', `/${search}`);
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  vi.mocked(mount).mockClear();
  vi.mocked(restoreTheme).mockClear();
  vi.mocked(setsWindowAppearance).mockClear();
  win.show.mockClear();
  frames = [];
  // main.ts sets a show timer; fake timers keep one test's timer out of the next.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
  await import('./main');
  await vi.advanceTimersByTimeAsync(0);
  return vi.mocked(mount).mock.calls[0][0] as unknown;
}

afterEach(() => {
  vi.useRealTimers();
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('main', () => {
  it('mounts the editor app by default', async () => {
    expect(await start('')).toBe('App');
  });

  it('mounts Settings in the window opened with ?view=settings', async () => {
    expect(await start('?view=settings&section=files')).toBe('SettingsApp');
  });

  it('restores the saved theme before the first render (Ruling 150)', async () => {
    await start('');
    expect(restoreTheme).toHaveBeenCalledOnce();
    expect(vi.mocked(restoreTheme).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(mount).mock.invocationCallOrder[0]);
  });

  it('restores the Settings window with the default palette (Ruling 158)', async () => {
    await start('?view=settings');
    expect(restoreTheme).toHaveBeenCalledWith({ defaultPalettes: true });

    await start('');
    expect(restoreTheme).toHaveBeenCalledWith({ defaultPalettes: false });
  });

  it('leaves window appearance to the document windows in Settings, before restoring (Rulings 160, 195)', async () => {
    await start('?view=settings');
    expect(setsWindowAppearance).toHaveBeenCalledWith(false);
    const [set] = vi.mocked(setsWindowAppearance).mock.invocationCallOrder;
    expect(set).toBeLessThan(vi.mocked(restoreTheme).mock.invocationCallOrder[0]);

    await start('');
    expect(setsWindowAppearance).not.toHaveBeenCalled();
  });

  it('shows the hidden window two frames after the theme is restored (Ruling 154)', async () => {
    await start('');
    expect(win.show).not.toHaveBeenCalled();

    nextFrame();
    expect(win.show).not.toHaveBeenCalled();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();
    expect(vi.mocked(restoreTheme).mock.invocationCallOrder[0]).toBeLessThan(win.show.mock.invocationCallOrder[0]);
  });

  it('shows the Settings window the same way', async () => {
    await start('?view=settings');
    nextFrame();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();
  });

  it('shows the window after 100 ms if a hidden window gets no frames, and only once', async () => {
    await start('');
    vi.advanceTimersByTime(99);
    expect(win.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.show).toHaveBeenCalledOnce();

    nextFrame();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();
  });
});

describe('main in a new document window (Ruling 184)', () => {
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('stays hidden until its doc arrives, then shows two frames later', async () => {
    await start('', 'w-1');
    nextFrame();
    nextFrame();
    await vi.advanceTimersByTimeAsync(1999);
    expect(win.show).not.toHaveBeenCalled();

    adoption.resolve();
    await flush();
    nextFrame();
    expect(win.show).not.toHaveBeenCalled();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();
  });

  it('shows anyway 2 s on when no doc arrives', async () => {
    await start('', 'w-1');

    await vi.advanceTimersByTimeAsync(1999);
    expect(win.show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    nextFrame();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();

    adoption.resolve();
    await flush();
    nextFrame();
    nextFrame();
    await vi.advanceTimersByTimeAsync(100);
    expect(win.show).toHaveBeenCalledOnce();
  });

  it('falls back to the 100 ms timer once the doc has arrived', async () => {
    await start('', 'w-1');
    adoption.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(win.show).toHaveBeenCalledOnce();
  });
});

describe('main while the session restores (Ruling 205)', () => {
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('keeps the main window hidden until its restore is done, so no empty state shows first', async () => {
    await start('', 'main', { restored: false });
    nextFrame();
    nextFrame();
    await vi.advanceTimersByTimeAsync(1999);
    expect(win.show).not.toHaveBeenCalled();

    restoration.resolve();
    await flush();
    nextFrame();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();
  });

  it('shows the main window anyway 2 s on when the restore hangs', async () => {
    await start('', 'main', { restored: false });
    await vi.advanceTimersByTimeAsync(2000);
    nextFrame();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();
  });

  it('shows a restored document window once its restore is done', async () => {
    await start('', 'w-1', { restored: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(win.show).not.toHaveBeenCalled();

    restoration.resolve();
    await flush();
    nextFrame();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();
  });

  it('never holds the Settings window for a restore', async () => {
    await start('?view=settings', 'settings', { restored: false });
    nextFrame();
    nextFrame();
    expect(win.show).toHaveBeenCalledOnce();
  });
});
