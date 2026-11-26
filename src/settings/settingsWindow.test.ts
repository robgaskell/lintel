import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTo } from '@tauri-apps/api/event';
import { settings } from '../lib/settings/settings.svelte';
import { focusedSettingsWindow, openSettingsWindow } from './settingsWindow';

const tauri = vi.hoisted(() => {
  type Handler = (event: { payload: unknown }) => void;
  class FakeWindow {
    handlers = new Map<string, Handler>();
    minimized = false;
    focused = false;
    isMinimized = vi.fn(async () => this.minimized);
    unminimize = vi.fn(async () => {});
    show = vi.fn(async () => {});
    setFocus = vi.fn(async () => {});
    isFocused = vi.fn(async () => this.focused);
    visible = false;
    isVisible = vi.fn(async () => this.visible);

    constructor(
      readonly label: string,
      readonly options: Record<string, unknown> = {},
    ) {
      tauri.constructed.push(this);
      // Created by IPC after the constructor returns, as in @tauri-apps/api.
      setTimeout(() => {
        if (tauri.failNext) {
          const error = tauri.failNext;
          tauri.failNext = null;
          this.handlers.get('tauri://error')?.({ payload: error });
          return;
        }
        tauri.windows.set(label, this);
        this.handlers.get('tauri://created')?.({ payload: null });
      }, 0);
    }

    async once(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return () => {};
    }

    static async getByLabel(label: string) {
      return tauri.windows.get(label) ?? null;
    }
  }
  return {
    FakeWindow,
    windows: new Map<string, FakeWindow>(),
    constructed: [] as FakeWindow[],
    failNext: null as string | null,
  };
});

vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: tauri.FakeWindow }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(async () => {}) }));
vi.mock('../lib/theme/theme', async () => {
  const { readable } = await import('svelte/store');
  return { resolvedTheme: readable('dark') };
});

beforeEach(() => {
  tauri.windows.clear();
  tauri.constructed.length = 0;
  tauri.failNext = null;
  vi.mocked(emitTo).mockClear();
});

describe('openSettingsWindow', () => {
  it('opens hidden, in the app theme, and is shown after 2 s if its page has not shown it (Ruling 154)', async () => {
    settings.theme = 'dark';
    try {
      vi.useFakeTimers();
      const opened = openSettingsWindow();
      await vi.advanceTimersByTimeAsync(0);
      await opened;
      const [win] = tauri.constructed;
      expect(win.options).toMatchObject({ visible: false, theme: 'dark', backgroundColor: '#181817' });

      await vi.advanceTimersByTimeAsync(1999);
      expect(win.show).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(win.show).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      settings.theme = 'system';
    }
  });

  it('leaves the window alone after 2 s when its page already showed it', async () => {
    vi.useFakeTimers();
    try {
      const opened = openSettingsWindow();
      await vi.advanceTimersByTimeAsync(0);
      await opened;
      const [win] = tauri.constructed;
      expect(win.options.theme).toBeUndefined();
      win.visible = true;

      await vi.advanceTimersByTimeAsync(2000);
      expect(win.show).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens one 900×640 resizable window labelled settings on the settings view', async () => {
    await openSettingsWindow();

    expect(tauri.constructed).toHaveLength(1);
    const [win] = tauri.constructed;
    expect(win.label).toBe('settings');
    expect(win.options).toMatchObject({
      url: '/?view=settings',
      title: 'Settings',
      width: 900,
      height: 640,
      resizable: true,
    });
  });

  it('asks a new window for a section through the query (Ruling 144)', async () => {
    await openSettingsWindow('files');

    expect(tauri.constructed[0].options.url).toBe('/?view=settings&section=files');
  });

  it('brings an open window forward instead of opening another, and sends it the section', async () => {
    await openSettingsWindow();
    const [win] = tauri.constructed;
    win.minimized = true;

    await openSettingsWindow('editor');

    expect(tauri.constructed).toHaveLength(1);
    expect(win.unminimize).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.setFocus).toHaveBeenCalledOnce();
    expect(emitTo).toHaveBeenCalledWith('settings', 'lintel://settings-section', 'editor');
  });

  it('only focuses an open window when no section is asked for', async () => {
    await openSettingsWindow();
    await openSettingsWindow();

    expect(tauri.constructed[0].unminimize).not.toHaveBeenCalled();
    expect(tauri.constructed[0].setFocus).toHaveBeenCalledOnce();
    expect(emitTo).not.toHaveBeenCalled();
  });

  it('opens one window for two quick requests', async () => {
    await Promise.all([openSettingsWindow(), openSettingsWindow()]);

    expect(tauri.constructed).toHaveLength(1);
    expect(tauri.constructed[0].setFocus).toHaveBeenCalledOnce();
  });

  it('rejects when the window cannot be created, and the next request tries again', async () => {
    tauri.failNext = 'webview failed';

    await expect(openSettingsWindow()).rejects.toBe('webview failed');
    await openSettingsWindow();

    expect(tauri.constructed).toHaveLength(2);
    expect(tauri.windows.get('settings')).toBe(tauri.constructed[1]);
  });
});

describe('focusedSettingsWindow', () => {
  it('is null when Settings is closed or not focused, and the window when it is', async () => {
    expect(await focusedSettingsWindow()).toBeNull();
    await openSettingsWindow();
    expect(await focusedSettingsWindow()).toBeNull();

    tauri.constructed[0].focused = true;

    expect(await focusedSettingsWindow()).toBe(tauri.constructed[0]);
  });

  it('is null when the check fails, so menu commands still reach the main window', async () => {
    await openSettingsWindow();
    tauri.constructed[0].isFocused.mockRejectedValueOnce(new Error('ipc down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await focusedSettingsWindow()).toBeNull();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
