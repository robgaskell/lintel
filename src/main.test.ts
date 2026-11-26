import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { restoreTheme } from './lib/theme/theme';

vi.mock('svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('svelte')>()),
  mount: vi.fn(() => ({})),
}));
vi.mock('./App.svelte', () => ({ default: 'App' }));
vi.mock('./settings/SettingsApp.svelte', () => ({ default: 'SettingsApp' }));
vi.mock('./lib/theme/theme', () => ({ restoreTheme: vi.fn() }));
const win = vi.hoisted(() => ({ show: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));

// Frames run only when the test says so.
let frames: FrameRequestCallback[] = [];
function nextFrame() {
  const due = frames;
  frames = [];
  for (const cb of due) cb(performance.now());
}

async function start(search: string) {
  history.replaceState(null, '', `/${search}`);
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  vi.mocked(mount).mockClear();
  vi.mocked(restoreTheme).mockClear();
  win.show.mockClear();
  frames = [];
  // main.ts sets a show timer; fake timers keep one test's timer out of the next.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
  await import('./main');
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
