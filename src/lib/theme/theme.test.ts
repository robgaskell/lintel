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
  restoreTheme,
} from './theme';

const fake = vi.hoisted(() => ({
  settingsChanged: null as ((s: Settings) => void) | null,
  setTheme: vi.fn(async (_theme: string | null) => {}),
}));
vi.mock('../settings/settings.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings/settings.svelte')>()),
  onSettingsChanged: (cb: (s: Settings) => void) => {
    fake.settingsChanged = cb;
    return () => (fake.settingsChanged = null);
  },
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: fake.setTheme }) }));

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...patch } as Settings;
}

function withPalette(resolved: 'light' | 'dark', palette: Palette): Settings {
  return settingsWith({ theme: resolved, palettes: { ...structuredClone(DEFAULT_SETTINGS.palettes), [resolved]: palette } });
}

const root = document.documentElement;
// Read from disk: vitest hands CSS imports over empty, and the project has no Node types.
const { readFileSync } = (await import(/* @vite-ignore */ 'node:fs' as string)) as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const appCss = readFileSync('src/app.css', 'utf8');
const toolbarSource = readFileSync('src/lib/ui/Toolbar.svelte', 'utf8');
const source = (path: string) => readFileSync(path, 'utf8');
const SEPIA: Palette = { background: '#F4ECD8', text: '#3B3024', accent: '#0F766E', link: '#0F766E', codeBackground: '#EDE4D1' };
const NAVY: Palette = { background: '#0B1B33', text: '#D8E1F0', accent: '#8AB4FF', link: '#8AB4FF', codeBackground: '#132744' };
const BLACK: Palette = { background: '#000000', text: '#E0E0E0', accent: '#8AB4FF', link: '#8AB4FF', codeBackground: '#111111' };

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

  it('reads #RGB as well as #RRGGBB, in either case (Ruling 152)', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#25e', '#2255EE')).toBeCloseTo(1, 5);
  });

  it('throws on anything that is not #RGB or #RRGGBB', () => {
    for (const bad of ['red', '#12345', '#GGGGGG', 'rgb(0,0,0)', '', '#1234567']) {
      expect(() => contrastRatio(bad, '#FFFFFF'), bad).toThrow(/#RGB or #RRGGBB/);
    }
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

  it('cannot be changed by a caller (Ruling 152)', () => {
    expect(() => ((DEFAULT_PALETTES.dark as Palette).background = '#000000')).toThrow(TypeError);
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

  it('derives chrome, border, active line and muted from the palette (Rulings 129, 148, 149)', () => {
    expect(cssVariables(settingsWith({}), 'light')).toMatchObject({
      '--chrome': '#F6F6F6', // 4% toward text
      '--border': '#E0E0E0', // 14% toward text
      '--active-line': '#F4F7FE', // 5% toward accent
      '--muted': '#70706F', // 64% of text: the first mix at 4.5:1 on every surface
    });
    expect(cssVariables(settingsWith({}), 'dark')).toMatchObject({
      '--chrome': '#151514', // 12% toward black
      '--border': '#363635',
      '--active-line': '#21242A', // 8% toward accent
      '--muted': '#8A8A89', // the active line needs more than 50%
    });
  });

  it('keeps default dark markdown marks on the cursor line at 4.5:1 (Ruling 149)', () => {
    const vars = cssVariables(settingsWith({}), 'dark');
    expect(contrastRatio(vars['--muted'], vars['--active-line'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps muted at 4.5:1 on chrome, background and active line when the palette allows it', () => {
    const cases: [Palette, 'light' | 'dark'][] = [
      [DEFAULT_PALETTES.light, 'light'],
      [DEFAULT_PALETTES.dark, 'dark'],
      [SEPIA, 'light'],
      [NAVY, 'dark'],
      [BLACK, 'dark'],
    ];
    for (const [palette, resolved] of cases) {
      const vars = cssVariables(withPalette(resolved, palette), resolved);
      for (const surface of ['--chrome', '--bg', '--active-line']) {
        expect(contrastRatio(vars['--muted'], vars[surface]), `${palette.background} ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // Palettes where one surface alone decides muted, so dropping it from the check shows.
  it('checks muted against the background itself (Ruling 155)', () => {
    const bgBound: Palette = { background: '#151515', text: '#8A8A8A', accent: '#000000', link: '#8A8A8A', codeBackground: '#151515' };
    const vars = cssVariables(withPalette('dark', bgBound), 'dark');
    expect(vars['--muted']).toBe('#7F7F7F');
    expect(contrastRatio(vars['--muted'], vars['--bg'])).toBeGreaterThanOrEqual(4.5);
  });

  it('checks muted against the chrome itself (Ruling 155)', () => {
    const chromeBound: Palette = { background: '#000000', text: '#787878', accent: '#FF0000', link: '#787878', codeBackground: '#000000' };
    const vars = cssVariables(withPalette('light', chromeBound), 'light');
    expect(vars['--muted']).toBe('#777777');
    expect(contrastRatio(vars['--muted'], vars['--chrome'])).toBeGreaterThanOrEqual(4.5);
  });

  it('uses the text colour itself, the most it can do, when no mix reaches 4.5:1', () => {
    // Text on this background is only 3.45:1, so nothing lighter can reach 4.5:1 either.
    const faint: Palette = { ...SEPIA, background: '#FFFFFF', text: '#8A8A8A' };
    const vars = cssVariables(withPalette('light', faint), 'light');

    expect(vars['--muted']).toBe('#8A8A8A');
    expect(contrastRatio(vars['--muted'], vars['--bg'])).toBeLessThan(4.5);
  });

  it('derives the chrome-family surfaces from a custom palette, not fixed greys (Ruling 148)', () => {
    const sepia = cssVariables(withPalette('light', SEPIA), 'light');
    const plain = cssVariables(settingsWith({}), 'light');
    for (const key of ['--chrome', '--border', '--active-line', '--accent-tint', '--inset', '--selection', '--search-match']) {
      expect(sepia[key], key).not.toBe(plain[key]);
    }
    // Text on the accent-tinted rows and toggles stays readable.
    expect(contrastRatio(sepia['--text'], sepia['--accent-tint'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(plain['--muted-strong'], plain['--inset'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps dark chrome visibly apart from a near-black background (Ruling 152)', () => {
    const vars = cssVariables(withPalette('dark', BLACK), 'dark');
    expect(vars['--chrome']).not.toBe('#000000');
    expect(contrastRatio(vars['--chrome'], vars['--bg'])).toBeGreaterThan(1.05);
  });

  it('puts the system font stack after a chosen font and alone for an empty one', () => {
    const system = cssVariables(settingsWith({}), 'light');
    expect(system['--font-read']).toBe("-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif");
    expect(system['--font-edit']).toBe("ui-monospace, 'SF Mono', Menlo, Consolas, monospace");

    const custom = cssVariables(settingsWith({ readingFont: 'Georgia, serif', editorFont: "'JetBrains Mono'" }), 'light');
    expect(custom['--font-read']).toBe(`Georgia, serif, ${system['--font-read']}`);
    expect(custom['--font-edit']).toBe(`'JetBrains Mono', ${system['--font-edit']}`);
  });

  it('uses the system stack for a font value that is not a font-family list (Ruling 152)', () => {
    const vars = cssVariables(settingsWith({ editorFont: 'Menlo; color: red' }), 'light');
    expect(vars['--font-edit']).toBe("ui-monospace, 'SF Mono', Menlo, Consolas, monospace");
  });

  it('includes the twelve keys of the plan', () => {
    const keys = Object.keys(cssVariables(settingsWith({}), 'light'));
    for (const key of ['--bg', '--text', '--accent', '--link', '--code-bg', '--chrome', '--border', '--muted', '--font-read', '--font-edit', '--size-read', '--size-edit']) {
      expect(keys).toContain(key);
    }
  });
});

// The fixed tokens app.css may still define: syntax colours and a shadow (Ruling 148).
const FIXED = ['--preview-code-keyword', '--preview-code-string', '--preview-code-title', '--preview-code-comment', '--editor-code', '--lint-warning', '--mode-selected-shadow'];

function blocks(css: string): { selector: string; media: string | null; decls: Record<string, string> }[] {
  const out: { selector: string; media: string | null; decls: Record<string, string> }[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /(@media[^{]+)\{\s*([^{}]+)\{([^{}]*)\}\s*\}|([^{}@]+)\{([^{}]*)\}/g;
  for (const m of clean.matchAll(rule)) {
    const [media, selector, body] = m[1] ? [m[1].trim(), m[2], m[3]] : [null, m[4], m[5]];
    const decls: Record<string, string> = {};
    for (const decl of body.split(';')) {
      const at = decl.indexOf(':');
      if (at > 0) decls[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
    out.push({ selector: selector.trim(), media, decls });
  }
  return out;
}

describe('scroll containers (Ruling 154)', () => {
  it('carry the resolved color-scheme, so their scrollbars match the theme', () => {
    expect(cssVariables(settingsWith({}), 'dark')['--scheme']).toBe('dark');
    expect(cssVariables(settingsWith({}), 'light')['--scheme']).toBe('light');
    const rules: [string, RegExp][] = [
      ['src/lib/ui/Preview.svelte', /\.preview \{[^}]*color-scheme: var\(--scheme\)/],
      ['src/lib/ui/Outline.svelte', /\.outline \{[^}]*color-scheme: var\(--scheme\)/],
      ['src/settings/SettingsApp.svelte', /\n  nav \{[^}]*color-scheme: var\(--scheme\)/],
      ['src/settings/SettingsApp.svelte', /\n  main \{[^}]*color-scheme: var\(--scheme\)/],
      ['src/App.svelte', /\.dv-tabs-container\) \{[^}]*color-scheme: var\(--scheme\)/],
      ['src/lib/theme/editorTheme.ts', /'\.cm-scroller': \{[^}]*colorScheme: 'var\(--scheme\)'/],
    ];
    for (const [file, rule] of rules) expect(source(file), `${file} ${rule}`).toMatch(rule);
  });
});

describe('app.css', () => {
  const all = blocks(appCss);
  const fallback = (media: string | null) =>
    all.find((b) => b.selector === ':root:not([data-theme])' && b.media === media)!.decls;

  it('has first-launch fallbacks equal to the default light and dark variables (Ruling 150)', () => {
    const vars = (resolved: 'light' | 'dark') =>
      Object.entries(cssVariables(settingsWith({}), resolved)).map(([k, v]) => [k, v.toLowerCase()]);
    const lower = (decls: Record<string, string>) =>
      Object.fromEntries(Object.entries(decls).filter(([k]) => k.startsWith('--')).map(([k, v]) => [k, v.toLowerCase()]));

    expect(lower(fallback(null))).toEqual(Object.fromEntries(vars('light')));
    expect(lower(fallback('@media (prefers-color-scheme: dark)'))).toEqual(Object.fromEntries(vars('dark')));
  });

  it('uses prefers-color-scheme only for the first-launch fallback (Ruling 131)', () => {
    for (const b of all.filter((b) => b.media !== null)) {
      expect(b.selector).toBe(':root:not([data-theme])');
    }
  });

  it('keeps fixed colours only for syntax and shadows; every other token is a variable (Ruling 148)', () => {
    for (const b of all.filter((b) => b.selector.startsWith(':root') && !b.selector.includes(':not('))) {
      for (const [name, value] of Object.entries(b.decls)) {
        if (!name.startsWith('--') || FIXED.includes(name)) continue;
        expect(value, `${b.selector} ${name}`).toMatch(/^var\(--[a-z-]+\)$/);
      }
    }
  });

  it('puts the tab strip, outline, toolbar and status bar on the chrome tone', () => {
    const tokens = all.find((b) => b.selector === ':root')!.decls;
    expect(tokens['--tab-strip']).toBe('var(--chrome)');
    expect(tokens['--outline-bg']).toBe('var(--chrome)');
    expect(tokens['--outline-active']).toBe('var(--accent-tint)');
    expect(tokens['--mode-selected-bg']).toBe('var(--accent-tint)');
    expect(tokens['--toolbar-border']).toBe('var(--border)');
    expect(toolbarSource).toMatch(/\.toolbar \{[^}]*background: var\(--chrome\)/);
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
  localStorage.clear();
  fake.setTheme.mockClear();
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
    expect(root.style.getPropertyValue('--muted')).toBe('#8A8A89');
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

  it('sets the window theme for a forced choice and clears it for system (Ruling 151)', () => {
    applyTheme(settingsWith({ theme: 'dark' }));
    expect(fake.setTheme).toHaveBeenLastCalledWith('dark');
    applyTheme(settingsWith({ theme: 'light' }));
    expect(fake.setTheme).toHaveBeenLastCalledWith('light');
    applyTheme(settingsWith({ theme: 'system' }));
    expect(fake.setTheme).toHaveBeenLastCalledWith(null);

    // An OS change or a font change needs no new call.
    fake.setTheme.mockClear();
    applyTheme(settingsWith({ theme: 'system', fontSize: 20 }));
    expect(fake.setTheme).not.toHaveBeenCalled();
  });
});

describe('restoreTheme (Ruling 150)', () => {
  it('puts back the theme the last applyTheme left, before any settings load', () => {
    applyTheme(withPalette('dark', NAVY));
    root.removeAttribute('style');
    delete root.dataset.theme;
    fake.setTheme.mockClear();

    restoreTheme();

    expect(fake.setTheme).toHaveBeenCalledWith('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(root.style.getPropertyValue('--bg')).toBe('#0B1B33');
    expect(get(resolvedTheme)).toBe('dark');
  });

  it('does nothing on the very first launch or with a damaged record', () => {
    restoreTheme();
    expect(root.dataset.theme).toBeUndefined();

    for (const junk of ['not json', 'null', '{"theme":"dark","choice":"dark"}']) {
      localStorage.setItem('lintel:theme', junk);
      restoreTheme();
      expect(root.dataset.theme, junk).toBeUndefined();
      expect(root.getAttribute('style'), junk).toBeNull();
    }
  });

  // A good record with one field changed; every value is checked by its kind (Ruling 155).
  function saved(change: { theme?: unknown; choice?: unknown; vars?: Record<string, unknown> }): string {
    const vars = { ...cssVariables(settingsWith({ theme: 'dark' }), 'dark'), ...change.vars };
    return JSON.stringify({ theme: change.theme ?? 'dark', choice: change.choice ?? 'dark', vars });
  }

  it('restores a record that passes every check', () => {
    localStorage.setItem('lintel:theme', saved({}));
    restoreTheme();
    expect(root.dataset.theme).toBe('dark');
  });

  it('refuses a record with any value of the wrong kind', () => {
    const bad: [string, Parameters<typeof saved>[0]][] = [
      ['theme', { theme: 'blue' }],
      ['choice', { choice: 'blue' }],
      ['unknown key', { vars: { color: '#FFFFFF' } }],
      ['missing key', { vars: { '--bg': undefined } }],
      ['colour name', { vars: { '--bg': 'red' } }],
      ['url in a colour', { vars: { '--bg': 'url(https://example.com/x)' } }],
      ['brace {', { vars: { '--chrome': '#FFF{' } }],
      ['brace }', { vars: { '--chrome': '}#FFF' } }],
      ['angle <', { vars: { '--accent': '<#FFF' } }],
      ['angle >', { vars: { '--accent': '#FFF>' } }],
      ['semicolon', { vars: { '--text': '#FFF; color: red' } }],
      ['not a number', { vars: { '--muted': 42 } }],
      ['hover', { vars: { '--hover': 'rgba(0, 0, 0, 0.1); x' } }],
      ['hover image', { vars: { '--hover': 'url(x)' } }],
      ['font', { vars: { '--font-read': 'Georgia; x' } }],
      ['font url', { vars: { '--font-edit': 'url(x)' } }],
      ['size unit', { vars: { '--size-read': '16em' } }],
      ['size too big', { vars: { '--size-read': '99px' } }],
      ['size fraction', { vars: { '--size-edit': '14.5px' } }],
      ['editor size too small', { vars: { '--size-edit': '9px' } }],
    ];
    for (const [why, change] of bad) {
      localStorage.setItem('lintel:theme', saved(change));
      restoreTheme();
      expect(root.dataset.theme, why).toBeUndefined();
      expect(root.getAttribute('style'), why).toBeNull();
    }
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
