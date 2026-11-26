import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTextFile } from '../ipc';
import { calls, fakeStore, resetFakes } from '../../test/fakes';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  settings,
  updateSettings,
} from './settings.svelte';

vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/data/com.robgaskell.lintel',
  join: async (...parts: string[]) => parts.join('/'),
}));
vi.mock('../ipc', async () => {
  const { calls } = await import('../../test/fakes');
  return {
    writeTextFile: vi.fn(async (path: string) => {
      calls.push(`write ${path}`);
      return 'hash';
    }),
  };
});

const store = () => fakeStore('settings.json');

beforeEach(async () => {
  resetFakes();
  vi.mocked(writeTextFile).mockClear();
  await loadSettings();
});

describe('loadSettings', () => {
  it('returns the defaults when the store is empty', async () => {
    const loaded = await loadSettings();

    expect(loaded).toEqual(DEFAULT_SETTINGS);
    expect(loaded).toMatchObject({
      version: 1,
      theme: 'system',
      fontSize: 16,
      recentLimit: 5,
      defaultMode: 'split',
      lint: { enabled: true, rules: { default: true } },
    });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('uses the values Ruling 54 sets for fonts, palettes and updates', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      readingFont: '',
      editorFont: '',
      updates: { autoCheck: true },
      palettes: {
        light: {
          background: '#FFFFFF',
          text: '#1F1F1E',
          accent: '#2563EB',
          link: '#2563EB',
          codeBackground: '#F4F4F3',
        },
        dark: {
          background: '#181817',
          text: '#ECECEA',
          accent: '#8AB4FF',
          link: '#8AB4FF',
          codeBackground: '#1F1F1E',
        },
      },
    });
  });

  it('applies stored values over the defaults and into `settings`', async () => {
    store().data.set('version', 1);
    store().data.set('fontSize', 18);
    store().data.set('defaultMode', 'read');

    const loaded = await loadSettings();

    expect(loaded.fontSize).toBe(18);
    expect(loaded.recentLimit).toBe(5);
    expect(settings.defaultMode).toBe('read');
  });

  it('ignores a stored value of the wrong type', async () => {
    store().data.set('version', 1);
    store().data.set('fontSize', 'huge');

    expect((await loadSettings()).fontSize).toBe(16);
  });

  it('keeps a .bak of an unknown version, then falls back to the defaults', async () => {
    store().data.set('version', 2);
    store().data.set('fontSize', 20);

    const loaded = await loadSettings();

    expect(loaded).toEqual(DEFAULT_SETTINGS);
    expect(writeTextFile).toHaveBeenCalledWith(
      '/data/com.robgaskell.lintel/settings.json.bak',
      expect.any(String),
    );
    const bak = JSON.parse(vi.mocked(writeTextFile).mock.calls[0][1]);
    expect(bak).toEqual({ version: 2, fontSize: 20 });
    // The copy is written before anything touches the store.
    const firstChange = calls.findIndex((c) => /^(set|clear) settings\.json/.test(c));
    expect(firstChange).toBeGreaterThan(calls.indexOf('write /data/com.robgaskell.lintel/settings.json.bak'));
    expect(await store().length()).toBe(0);
  });
});

describe('updateSettings', () => {
  it('saves the whole settings object, then tells every window', async () => {
    const seen = vi.fn();
    onSettingsChanged(seen);
    await Promise.resolve();

    await updateSettings({ recentLimit: 0 });

    expect(settings.recentLimit).toBe(0);
    expect(await store().get('recentLimit')).toBe(0);
    expect(await store().get('version')).toBe(1);
    expect(await store().get('theme')).toBe('system');
    expect(store().saves).toBe(1);
    expect(calls.indexOf('save settings.json')).toBeLessThan(
      calls.indexOf('emit lintel://settings-changed'),
    );
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ recentLimit: 0, fontSize: 16 }));
  });

  it('is loaded back by the next loadSettings', async () => {
    await updateSettings({ theme: 'dark', fontSize: 14 });
    settings.theme = 'light';

    const loaded = await loadSettings();

    expect(loaded.theme).toBe('dark');
    expect(loaded.fontSize).toBe(14);
  });
});

describe('onSettingsChanged', () => {
  it('stops calling back once unsubscribed', async () => {
    const seen = vi.fn();
    const stop = onSettingsChanged(seen);
    await Promise.resolve();
    stop();
    await Promise.resolve();

    await updateSettings({ fontSize: 20 });

    expect(seen).not.toHaveBeenCalled();
  });
});
