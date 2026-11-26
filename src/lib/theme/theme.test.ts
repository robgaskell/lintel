import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { DEFAULT_SETTINGS, type Palette, type Settings } from '../settings/settings.svelte';
import {
  applyTheme,
  contrastRatio,
  cssVariables,
  DEFAULT_PALETTES,
  followTheme,
  resolvedTheme,
  resolveTheme,
} from './theme';

const fake = vi.hoisted(() => ({ settingsChanged: null as ((s: Settings) => void) | null }));
vi.mock('../settings/settings.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings/settings.svelte')>()),
  onSettingsChanged: (cb: (s: Settings) => void) => {
    fake.settingsChanged = cb;
    return () => (fake.settingsChanged = null);
  },
}));

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...patch } as Settings;
}

const root = document.documentElement;
const SEPIA: Palette = { background: '#F4ECD8', text: '#3B3024', accent: '#2563EB', link: '#2563EB', codeBackground: '#EDE4D1' };
const NAVY: Palette = { background: '#0B1B33', text: '#D8E1F0', accent: '#8AB4FF', link: '#8AB4FF', codeBackground: '#132744' };

describe('resolveTheme', () => {
  it('follows the OS only for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('contrastRatio', () => {
  it('measures WCAG contrast either way round', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(contrastRatio('#2563EB', '#FFFFFF')).toBeCloseTo(5.17, 2);
  });

  it('keeps text and link at 4.5:1 or better on each default background', () => {
    for (const palette of [DEFAULT_PALETTES.light, DEFAULT_PALETTES.dark]) {
      expect(contrastRatio(palette.text, palette.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.link, palette.background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('DEFAULT_PALETTES', () => {
  it('is the settings defaults, not a copy (Ruling 127)', () => {
    expect(DEFAULT_PALETTES).toBe(DEFAULT_SETTINGS.palettes);
  });
});

describe('cssVariables', () => {
  it('maps fontSize 18 to 18px reading and 16px editor text', () => {
    const vars = cssVariables(settingsWith({ fontSize: 18 }), 'light');
    expect(vars['--size-read']).toBe('18px');
    expect(vars['--size-edit']).toBe('16px');
  });

  it('takes the five palette colours from the resolved theme', () => {
    const vars = cssVariables(settingsWith({}), 'dark');
    expect(vars['--bg']).toBe('#181817');
    expect(vars['--text']).toBe('#ECECEA');
    expect(vars['--accent']).toBe('#8AB4FF');
    expect(vars['--link']).toBe('#8AB4FF');
    expect(vars['--code-bg']).toBe('#1F1F1E');
  });

  it('derives chrome, border and muted from the background (Ruling 129)', () => {
    expect(cssVariables(settingsWith({}), 'light')).toMatchObject({
      '--chrome': '#F6F6F6', // 4% toward text
      '--border': '#E0E0E0', // 14% toward text
      '--muted': '#70706F', // 64% of text: the first mix at 4.5:1
    });
    expect(cssVariables(settingsWith({}), 'dark')).toMatchObject({
      '--chrome': '#151514', // 12% toward black
      '--border': '#363635',
      '--muted': '#828281', // 50% already passes
    });
  });

  it('keeps muted at 4.5:1 on chrome and background for default and custom palettes', () => {
    const cases: [Palette, 'light' | 'dark'][] = [
      [DEFAULT_PALETTES.light, 'light'],
      [DEFAULT_PALETTES.dark, 'dark'],
      [SEPIA, 'light'],
      [NAVY, 'dark'],
    ];
    for (const [palette, resolved] of cases) {
      const s = settingsWith({ palettes: { ...DEFAULT_SETTINGS.palettes, [resolved]: palette } });
      const vars = cssVariables(s, resolved);
      expect(vars['--chrome']).not.toBe(palette.background);
      expect(contrastRatio(vars['--muted'], vars['--chrome'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(vars['--muted'], vars['--bg'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('falls back to the text colour when no lighter mix reaches 4.5:1', () => {
    const faint: Palette = { ...SEPIA, background: '#FFFFFF', text: '#8A8A8A' };
    const s = settingsWith({ palettes: { ...DEFAULT_SETTINGS.palettes, light: faint } });
    expect(cssVariables(s, 'light')['--muted']).toBe('#8A8A8A');
  });

  it('uses the system font stacks for empty fonts and passes others through', () => {
    const system = cssVariables(settingsWith({}), 'light');
    expect(system['--font-read']).toContain('system-ui');
    expect(system['--font-edit']).toContain('monospace');

    const custom = cssVariables(settingsWith({ readingFont: 'Georgia, serif', editorFont: "'JetBrains Mono'" }), 'light');
    expect(custom['--font-read']).toBe('Georgia, serif');
    expect(custom['--font-edit']).toBe("'JetBrains Mono'");
  });

  it('sets exactly the twelve keys', () => {
    expect(Object.keys(cssVariables(settingsWith({}), 'light')).sort()).toEqual(
      [
        '--bg',
        '--text',
        '--accent',
        '--link',
        '--code-bg',
        '--chrome',
        '--border',
        '--muted',
        '--font-read',
        '--font-edit',
        '--size-read',
        '--size-edit',
      ].sort(),
    );
  });
});

// A stand-in for the webview's prefers-color-scheme query.
let osDark = false;
const osListeners = new Set<() => void>();
function setOsDark(dark: boolean) {
  osDark = dark;
  for (const listener of osListeners) listener();
}

beforeEach(() => {
  osDark = false;
  osListeners.clear();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    () =>
      ({
        get matches() {
          return osDark;
        },
        addEventListener: (_: string, fn: () => void) => osListeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => osListeners.delete(fn),
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  root.removeAttribute('style');
  delete root.dataset.theme;
});

describe('applyTheme', () => {
  it('sets the variables, data-theme, color-scheme and resolvedTheme', () => {
    applyTheme(settingsWith({ theme: 'dark' }));

    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(root.style.getPropertyValue('--bg')).toBe('#181817');
    expect(root.style.getPropertyValue('--muted')).toBe('#828281');
    expect(get(resolvedTheme)).toBe('dark');

    applyTheme(settingsWith({ theme: 'light' }));
    expect(root.dataset.theme).toBe('light');
    expect(root.style.getPropertyValue('--bg')).toBe('#FFFFFF');
    expect(get(resolvedTheme)).toBe('light');
  });

  it('reads the OS for system', () => {
    osDark = true;
    applyTheme(settingsWith({ theme: 'system' }));
    expect(root.dataset.theme).toBe('dark');
  });

  it('enlarges reading and editor text together when fontSize changes (Ruling 134)', () => {
    applyTheme(settingsWith({ fontSize: 16 }));
    applyTheme(settingsWith({ fontSize: 20 }));

    expect(root.style.getPropertyValue('--size-read')).toBe('20px');
    expect(root.style.getPropertyValue('--size-edit')).toBe('18px');
  });
});

describe('followTheme', () => {
  it('applies now, then on an OS appearance change and on a settings change', () => {
    const current = settingsWith({ theme: 'system' });
    const stop = followTheme(() => current);
    expect(root.dataset.theme).toBe('light');

    setOsDark(true);
    expect(root.dataset.theme).toBe('dark');
    expect(get(resolvedTheme)).toBe('dark');

    fake.settingsChanged!(settingsWith({ theme: 'light', fontSize: 22 }));
    expect(root.dataset.theme).toBe('light');
    expect(root.style.getPropertyValue('--size-read')).toBe('22px');

    stop();
    expect(osListeners.size).toBe(0);
    expect(fake.settingsChanged).toBeNull();
  });
});
