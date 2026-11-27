import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeTextFile } from '../ipc';
import * as fakes from '../../test/fakes';
import { calls, eventModule, events, fakeStore, loads, resetFakes } from '../../test/fakes';
import {
  DEFAULT_SETTINGS,
  isFontFamily,
  loadSettings,
  onSettingsChanged,
  settings,
  updateSettings,
} from './settings.svelte';

vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/core', () => import('../../test/fakes').then((f) => f.coreModule));
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
    claimPath: vi.fn(async () => null),
    frontendReady: vi.fn(async () => []),
    releasePath: vi.fn(async () => {}),
    transferPath: vi.fn(async () => 1),
    completeHandoff: vi.fn(async () => true),
    cancelHandoff: vi.fn(async () => true),
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
      remoteImages: 'ask',
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
    store().data.set('remoteImages', 'always');

    const loaded = await loadSettings();

    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, fontSize: 24, recentLimit: 0, readingFont: 'Georgia' });
    expect(loaded.remoteImages).toBe('ask');
  });

  it('keeps each valid remote images choice', async () => {
    store().data.set('version', 1);
    for (const choice of ['ask', 'load', 'block'] as const) {
      store().data.set('remoteImages', choice);
      expect((await loadSettings()).remoteImages).toBe(choice);
    }
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

    expect((await loadSettings()).lint).toEqual({ enabled: false, rules: { 'line-length': false } });
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
  it('saves only the patched keys and the version, then tells every window (Ruling 140)', async () => {
    const seen = vi.fn();
    onSettingsChanged(seen);
    await Promise.resolve();

    await updateSettings({ recentLimit: 0 });

    expect(settings.recentLimit).toBe(0);
    expect(await store().get('recentLimit')).toBe(0);
    expect(await store().get('version')).toBe(1);
    expect([...store().data.keys()].sort()).toEqual(['recentLimit', 'version']);
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

describe('two windows (Ruling 140)', () => {
  // A second module instance is a second window's JS context, sharing the store and events.
  async function otherWindow() {
    vi.resetModules();
    vi.doMock('@tauri-apps/plugin-store', () => fakes.storeModule);
    vi.doMock('@tauri-apps/api/event', () => fakes.eventModule);
    vi.doMock('@tauri-apps/api/core', () => fakes.coreModule);
    const instance = await import('./settings.svelte');
    await instance.loadSettings();
    return instance;
  }

  it("keeps one window's change when the other, holding stale settings, changes another key", async () => {
    const settingsWindow = await otherWindow();
    await settingsWindow.updateSettings({ theme: 'dark' });
    expect(settings.theme).toBe('system');

    await updateSettings({ remoteImages: 'load' });

    expect(await store().get('theme')).toBe('dark');
    expect(await store().get('remoteImages')).toBe('load');
    expect((await (await otherWindow()).loadSettings())).toMatchObject({ theme: 'dark', remoteImages: 'load' });
  });

  it("sends only the change, so a listening window keeps its newer values", async () => {
    const settingsWindow = await otherWindow();
    const seen = vi.fn();
    settingsWindow.onSettingsChanged(seen);
    await Promise.resolve();
    await settingsWindow.updateSettings({ fontSize: 20 });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));

    await updateSettings({ remoteImages: 'block' });

    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 20, remoteImages: 'block' }));
    expect(settingsWindow.settings).toMatchObject({ fontSize: 20, remoteImages: 'block' });
  });

  it('keeps both of two rule changes made in two windows at once (Rulings 169, 271)', async () => {
    const settingsWindow = await otherWindow();

    await Promise.all([
      updateSettings({ lint: { rules: { 'ul-style': false } } }),
      settingsWindow.updateSettings({ lint: { rules: { 'line-length': false } } }),
    ]);

    expect(await store().get('lint')).toEqual({
      enabled: true,
      rules: { default: true, 'ul-style': false, 'line-length': false },
    });
  });

  it('takes the stored settings back from a save, other windows\' changes included', async () => {
    const settingsWindow = await otherWindow();
    await settingsWindow.updateSettings({ theme: 'dark' });

    await updateSettings({ fontSize: 20 });

    expect(settings).toMatchObject({ theme: 'dark', fontSize: 20 });
  });
});

describe('nested settings (Ruling 159)', () => {
  const light = DEFAULT_SETTINGS.palettes.light;
  const dark = DEFAULT_SETTINGS.palettes.dark;

  it('patches one colour by key path, keeping the rest of both palettes', async () => {
    await updateSettings({ palettes: { light: { text: '#111111' } } });

    expect(await store().get('palettes')).toEqual({ light: { ...light, text: '#111111' }, dark });
    expect(settings.palettes).toEqual({ light: { ...light, text: '#111111' }, dark });
  });

  it('keeps both of two colour edits made at once', async () => {
    await Promise.all([
      updateSettings({ palettes: { light: { text: '#111111' } } }),
      updateSettings({ palettes: { dark: { link: '#222222' } } }),
    ]);

    expect(await store().get('palettes')).toEqual({
      light: { ...light, text: '#111111' },
      dark: { ...dark, link: '#222222' },
    });
  });

  it('builds on the stored value, not on a stale copy in this window', async () => {
    store().data.set('palettes', { light: { ...light, accent: '#0F766E' }, dark });

    await updateSettings({ palettes: { dark: { accent: '#5EEAD4' } } });

    expect(await store().get('palettes')).toEqual({
      light: { ...light, accent: '#0F766E' },
      dark: { ...dark, accent: '#5EEAD4' },
    });
  });

  it('deletes a rule key patched with null (Ruling 270)', async () => {
    store().data.set('lint', { enabled: true, rules: { default: true, MD004: false } });

    await updateSettings({ lint: { rules: { 'ul-style': false, MD004: null } } });

    expect(await store().get('lint')).toEqual({ enabled: true, rules: { default: true, 'ul-style': false } });
    expect(settings.lint.rules).toEqual({ default: true, 'ul-style': false });
  });

  it('patches lint and updates the same way', async () => {
    store().data.set('lint', { enabled: true, rules: { default: true, MD013: false } });

    await updateSettings({ lint: { enabled: false } });

    // The ID key is also written back under its alias (Rulings 270, 280).
    expect(await store().get('lint')).toEqual({ enabled: false, rules: { default: true, 'line-length': false } });
  });
});

describe('after a failed load (Ruling 159)', () => {
  it('refuses to save, so a file of another version is not relabelled', async () => {
    store().data.set('version', 2);
    vi.mocked(writeTextFile).mockRejectedValueOnce('disk full');
    await expect(loadSettings()).rejects.toBe('disk full');

    await expect(updateSettings({ remoteImages: 'load' })).rejects.toThrow(
      'Settings could not be loaded',
    );

    expect(store().data.get('version')).toBe(2);
    expect(store().data.has('remoteImages')).toBe(false);
  });

  it('saves again once a later load succeeds', async () => {
    store().data.set('version', 2);
    vi.mocked(writeTextFile).mockRejectedValueOnce('disk full');
    await expect(loadSettings()).rejects.toBe('disk full');
    await loadSettings();

    await updateSettings({ remoteImages: 'load' });

    expect(await store().get('remoteImages')).toBe('load');
  });
});

describe('lint rules (Ruling 270)', () => {
  it('loads a rule named by its ID or in another case under its first alias', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: true, rules: { default: true, MD004: false, 'Line-Length': { line_length: 100 }, 'single-h1': false } });

    expect((await loadSettings()).lint.rules).toEqual({
      default: true,
      'ul-style': false,
      'line-length': { line_length: 100 },
      'single-title': false,
    });
  });

  it('prefers the first alias when the rule is named twice', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: true, rules: { 'ul-style': false, MD004: true } });

    expect((await loadSettings()).lint.rules).toEqual({ 'ul-style': false });
  });

  it('keeps a rule set to "error" or "warning" as written (Ruling 281)', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: true, rules: { default: false, MD004: 'warning', MD013: 'error', MD009: 'loud' } });

    expect((await loadSettings()).lint.rules).toEqual({ default: false, 'ul-style': 'warning', 'line-length': 'error' });
  });

  it('keeps keys that name no rule, such as tags, and drops values of the wrong type', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: true, rules: { default: true, headings: false, MD013: 7 } });

    expect((await loadSettings()).lint.rules).toEqual({ default: true, headings: false });
  });
});

// A second window's settings module, sharing the fake store and events.
async function otherWindowModule() {
  vi.resetModules();
  vi.doMock('@tauri-apps/plugin-store', () => fakes.storeModule);
  vi.doMock('@tauri-apps/api/event', () => fakes.eventModule);
  vi.doMock('@tauri-apps/api/core', () => fakes.coreModule);
  return import('./settings.svelte');
}

describe('self-repair (Ruling 280)', () => {
  it('repairs a lint value it cannot read at load, so a rule toggle then takes effect', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: 'yes', rules: { default: true } });
    await loadSettings();

    await updateSettings({ lint: { rules: { 'ul-style': false } } });

    expect(settings.lint).toEqual({ enabled: true, rules: { default: true, 'ul-style': false } });
    expect(await store().get('lint')).toEqual({ enabled: true, rules: { default: true, 'ul-style': false } });
  });

  it('repairs a palette with a short colour at load, so a dark accent edit then takes effect', async () => {
    store().data.set('version', 1);
    store().data.set('palettes', {
      light: { ...DEFAULT_SETTINGS.palettes.light, text: '#FFF' },
      dark: DEFAULT_SETTINGS.palettes.dark,
    });
    await loadSettings();

    await updateSettings({ palettes: { dark: { accent: '#5EEAD4' } } });

    expect(settings.palettes.dark.accent).toBe('#5EEAD4');
    expect(settings.palettes.light.text).toBe(DEFAULT_SETTINGS.palettes.light.text);
  });

  it('repairs a value spoiled after load, then applies the change again', async () => {
    store().data.set('lint', { enabled: 'yes', rules: { default: true } });

    await updateSettings({ lint: { rules: { 'ul-style': false } } });

    expect(settings.lint.rules).toEqual({ default: true, 'ul-style': false });
    expect(await store().get('lint')).toEqual({ enabled: true, rules: { default: true, 'ul-style': false } });
  });

  it('writes back a value its reader altered, and writes nothing when all is readable', async () => {
    store().data.set('version', 1);
    store().data.set('fontSize', 3.4);
    store().data.set('lint', { enabled: true, rules: { MD004: false } });
    await loadSettings();

    expect(await store().get('fontSize')).toBe(12);
    expect(await store().get('lint')).toEqual({ enabled: true, rules: { 'ul-style': false } });
    const saves = store().saves;
    await loadSettings();
    expect(store().saves).toBe(saves);
  });

  it('repairs a bad value heard from another window', async () => {
    onSettingsChanged(() => {});
    await Promise.resolve();
    store().data.set('fontSize', 'huge');

    await eventModule.emit('lintel://settings-changed', { revision: 5, changes: { fontSize: 'huge' } });

    await vi.waitFor(async () => expect(await store().get('fontSize')).toBe(16));
  });

  it('leaves a key alone that changed again before the repair', async () => {
    onSettingsChanged(() => {});
    await Promise.resolve();
    store().data.set('fontSize', 20);

    await eventModule.emit('lintel://settings-changed', { revision: 5, changes: { fontSize: 'huge' } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await store().get('fontSize')).toBe(20);
  });
});

describe('self-repair, round 2 (Ruling 290)', () => {
  it("keeps another window's write made while its load repair was saving", async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: 'yes', rules: { default: true } });
    const other = await otherWindowModule();
    onSettingsChanged(() => {});
    await Promise.resolve();
    const real = fakes.coreModule.invoke;
    const invoke = vi.spyOn(fakes.coreModule, 'invoke').mockImplementationOnce(async (command, args) => {
      await other.updateSettings({ fontSize: 20 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return real(command, args);
    });

    await loadSettings();
    invoke.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await store().get('fontSize')).toBe(20);
    expect(settings.fontSize).toBe(20);
    expect(settings.lint).toEqual({ enabled: true, rules: { default: true } });
  });

  it('writes nothing for a value that only comes back with its keys in another order', async () => {
    await store().set('version', 1);
    await store().set('palettes', structuredClone(DEFAULT_SETTINGS.palettes));
    await store().set('lint', { rules: { default: true }, enabled: true });
    const saves = store().saves;

    await loadSettings();
    await loadSettings();

    expect(store().saves).toBe(saves);
  });

  it('ignores a change it heard that is no newer than what it holds', async () => {
    onSettingsChanged(() => {});
    await Promise.resolve();
    await updateSettings({ fontSize: 20 });

    await eventModule.emit('lintel://settings-changed', {
      revision: fakes.settingsRevision.value,
      changes: { fontSize: 12 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settings.fontSize).toBe(20);
  });

  it('repairs nothing it hears while its own load has failed', async () => {
    store().data.set('version', 2);
    store().data.set('fontSize', 'huge');
    vi.mocked(writeTextFile).mockRejectedValueOnce('disk full');
    await expect(loadSettings()).rejects.toBe('disk full');
    onSettingsChanged(() => {});
    await Promise.resolve();
    const saves = store().saves;

    await eventModule.emit('lintel://settings-changed', { revision: 1e9, changes: { fontSize: 'huge' } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store().saves).toBe(saves);
    expect(store().data.get('version')).toBe(2);
  });
});

describe('ordering (Ruling 281)', () => {
  it("does not let its own save's snapshot undo a newer change from another window", async () => {
    vi.resetModules();
    vi.doMock('@tauri-apps/plugin-store', () => fakes.storeModule);
    vi.doMock('@tauri-apps/api/event', () => fakes.eventModule);
    vi.doMock('@tauri-apps/api/core', () => fakes.coreModule);
    const other = await import('./settings.svelte');
    await other.loadSettings();
    onSettingsChanged(() => {});
    await Promise.resolve();
    const real = fakes.coreModule.invoke;
    const invoke = vi.spyOn(fakes.coreModule, 'invoke').mockImplementationOnce(async (command, args) => {
      const snapshot = await real(command, args);
      await other.updateSettings({ fontSize: 20 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return snapshot;
    });

    await updateSettings({ theme: 'dark' });

    expect(settings).toMatchObject({ theme: 'dark', fontSize: 20 });
    invoke.mockRestore();
  });
});

describe('onSettingsChanged', () => {
  it('reads changes as loadSettings does, so another window cannot hand it a bad value', async () => {
    const seen = vi.fn();
    onSettingsChanged(seen);
    await Promise.resolve();

    // As another window would have saved them.
    store().data.set('fontSize', 'huge');
    store().data.set('lint', { enabled: true, rules: { MD004: false } });
    await eventModule.emit('lintel://settings-changed', {
      revision: 1,
      changes: { fontSize: 'huge', lint: { enabled: true, rules: { MD004: false } } },
    });

    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
    expect(settings.fontSize).toBe(16);
    expect(settings.lint.rules).toEqual({ 'ul-style': false });
  });

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

describe('font settings (Ruling 152)', () => {
  it('keeps a CSS font-family list and drops anything else to the system font', async () => {
    store().data.set('version', 1);
    store().data.set('readingFont', `"Iowan Old Style", Georgia, serif`);
    store().data.set('editorFont', 'x; } body { display: none');

    const loaded = await loadSettings();

    expect(loaded.readingFont).toBe(`"Iowan Old Style", Georgia, serif`);
    expect(loaded.editorFont).toBe('');
  });

  it('tells a font-family list from other CSS', () => {
    for (const ok of ['Georgia', 'Georgia, serif', "'SF Mono', ui-monospace", '"A, B" , C', 'Source Code Pro']) {
      expect(isFontFamily(ok), ok).toBe(true);
    }
    for (const bad of ['', '  ', 'Georgia;', 'a !important', ')', 'url(x)', 'A,', ',B', '"open', 'a{b}']) {
      expect(isFontFamily(bad), bad).toBe(false);
    }
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('is frozen all the way down, so no caller can change the defaults', () => {
    const palette = DEFAULT_SETTINGS.palettes.light as { text: string };
    expect(() => (palette.text = '#000000')).toThrow(TypeError);
    expect(() => ((DEFAULT_SETTINGS.lint as { enabled: boolean }).enabled = false)).toThrow(TypeError);
    expect(DEFAULT_SETTINGS.palettes.light.text).toBe('#1F1F1E');
  });
});
