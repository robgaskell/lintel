import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTextFile } from '../ipc';
import { calls, events, fakeStore, loads, resetFakes } from '../../test/fakes';
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

  it('opens settings.json with autoSave off, since every change saves itself', () => {
    expect(loads).toContainEqual({ path: 'settings.json', options: { autoSave: false } });
  });

  it('falls back field by field for values out of range or of the wrong shape', async () => {
    store().data.set('version', 1);
    store().data.set('theme', 'blue');
    store().data.set('defaultMode', 'bogus');
    store().data.set('fontSize', 999);
    store().data.set('recentLimit', -3);
    store().data.set('palettes', {});
    store().data.set('lint', {});
    store().data.set('updates', { autoCheck: 'yes' });
    store().data.set('readingFont', 'Georgia');

    const loaded = await loadSettings();

    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, fontSize: 24, recentLimit: 0, readingFont: 'Georgia' });
  });

  it('rounds and clamps numbers into their ranges', async () => {
    store().data.set('version', 1);
    store().data.set('fontSize', 3.4);
    store().data.set('recentLimit', 12.6);

    const loaded = await loadSettings();

    expect(loaded.fontSize).toBe(12);
    expect(loaded.recentLimit).toBe(13);
  });

  it('rejects a palette with a colour that is not #RRGGBB', async () => {
    store().data.set('version', 1);
    store().data.set('palettes', {
      light: { ...DEFAULT_SETTINGS.palettes.light, accent: 'red' },
      dark: DEFAULT_SETTINGS.palettes.dark,
    });

    expect((await loadSettings()).palettes).toEqual(DEFAULT_SETTINGS.palettes);
  });

  it('keeps a valid nested value', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: false, rules: { MD013: false } });

    expect((await loadSettings()).lint).toEqual({ enabled: false, rules: { MD013: false } });
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
    expect(store().saves).toBe(1);
  });

  it('leaves an unknown version untouched when the .bak cannot be written', async () => {
    store().data.set('version', 2);
    store().data.set('fontSize', 20);
    settings.fontSize = 20;
    vi.mocked(writeTextFile).mockRejectedValueOnce('Could not save settings.json.bak: disk full');

    await expect(loadSettings()).rejects.toBe('Could not save settings.json.bak: disk full');

    expect(store().data.get('version')).toBe(2);
    expect(store().data.get('fontSize')).toBe(20);
    expect(store().saves).toBe(0);
    expect(settings.fontSize).toBe(16);
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
    await vi.waitFor(() =>
      expect(seen).toHaveBeenCalledWith(expect.objectContaining({ recentLimit: 0, fontSize: 16 })),
    );
  });

  it('keeps both of two updates made at once', async () => {
    await Promise.all([updateSettings({ theme: 'dark' }), updateSettings({ fontSize: 18 })]);

    expect(settings.theme).toBe('dark');
    expect(settings.fontSize).toBe(18);
    expect(await store().get('theme')).toBe('dark');
    expect(await store().get('fontSize')).toBe(18);
  });

  it('skips a field patched with undefined instead of failing part-way', async () => {
    await updateSettings({ fontSize: undefined, theme: 'light' });

    expect(settings.fontSize).toBe(16);
    expect(await store().get('theme')).toBe('light');
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
  it('reports a listener that could not be registered', async () => {
    events.failNextListen = new Error('event plugin down');
    const onError = vi.fn();

    onSettingsChanged(vi.fn(), onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(new Error('event plugin down')));
  });

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
