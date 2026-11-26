import { readonly, writable } from 'svelte/store';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  DEFAULT_SETTINGS,
  isFontFamily,
  onSettingsChanged,
  type Palette,
  type Settings,
  type ThemeChoice,
} from '../settings/settings.svelte';

export type ResolvedTheme = 'light' | 'dark';

/** One source for the defaults (Ruling 127); deep-frozen in settings. */
export const DEFAULT_PALETTES: Readonly<{ light: Palette; dark: Palette }> = DEFAULT_SETTINGS.palettes;

const SYSTEM_READ_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const SYSTEM_EDIT_FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const MIN_CONTRAST = 4.5;
const SEARCH_AMBER = '#FBBF24';
const STORAGE_KEY = 'lintel:theme';

const current = writable<ResolvedTheme>('light');
/** The theme last applied. Previews redraw their diagrams when it changes. */
export const resolvedTheme = readonly(current);

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

/** WCAG 2 contrast ratio of two #RGB or #RRGGBB colours, from 1 to 21. Throws on other values. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The theme variables for the palette of `resolved`: the plan's twelve keys plus the
 * surfaces derived from them (Rulings 129, 148, 149). Every colour is #RRGGBB except `--hover`;
 * `--scheme` is the resolved theme, for scroll containers' color-scheme.
 */
export function cssVariables(s: Settings, resolved: ResolvedTheme): Record<string, string> {
  const p = s.palettes[resolved];
  const dark = resolved === 'dark';
  const chrome = chromeFor(p, dark);
  const activeLine = mix(p.background, p.accent, dark ? 0.08 : 0.05);
  const muted = mutedFor(p.background, p.text, [chrome, p.background, activeLine]);
  return {
    '--bg': p.background,
    '--text': p.text,
    '--accent': p.accent,
    '--link': p.link,
    '--code-bg': p.codeBackground,
    '--chrome': chrome,
    '--border': mix(p.background, p.text, 0.14),
    '--muted': muted,
    '--font-read': fontStack(s.readingFont, SYSTEM_READ_FONT),
    '--font-edit': fontStack(s.editorFont, SYSTEM_EDIT_FONT),
    '--size-read': `${s.fontSize}px`,
    '--size-edit': `${s.fontSize - 2}px`,
    '--active-line': activeLine,
    '--muted-strong': mix(muted, p.text, 0.5),
    '--inset': mix(chrome, p.text, 0.06),
    '--accent-tint': accentTint(chrome, p, dark ? 0.2 : 0.12),
    '--hover': rgba(p.text, dark ? 0.08 : 0.06),
    '--selection': mix(p.background, p.accent, dark ? 0.3 : 0.2),
    '--selection-unfocused': mix(p.background, p.text, 0.1),
    '--search-match': mix(p.background, SEARCH_AMBER, dark ? 0.3 : 0.55),
    '--search-match-current': mix(p.background, SEARCH_AMBER, dark ? 0.45 : 0.9),
    '--scheme': resolved,
  };
}

/**
 * Sets the variables, `data-theme` and `color-scheme` on <html>, then `resolvedTheme`,
 * and remembers them so the next launch starts in the same theme (Ruling 150).
 */
export function applyTheme(s: Settings): void {
  const resolved = resolveTheme(s.theme, systemQuery().matches);
  const vars = cssVariables(s, resolved);
  paint(resolved, vars);
  setWindowTheme(s.theme);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: resolved, choice: s.theme, vars }));
  } catch {
    // Storage can be full or blocked; the next launch then starts from the CSS fallbacks.
  }
}

/** Puts back the theme the last `applyTheme` saved. Call before mounting the app. */
export function restoreTheme(): void {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return;
  }
  if (!isSavedTheme(saved)) return;
  paint(saved.theme, saved.vars);
  setWindowTheme(saved.choice, true);
}

/**
 * Applies the theme now, then again on a settings change in any window and on an OS
 * appearance change. Returns a stop function.
 */
export function followTheme(getSettings: () => Settings): () => void {
  applyTheme(getSettings());
  const query = systemQuery();
  const onSystemChange = () => applyTheme(getSettings());
  query.addEventListener('change', onSystemChange);
  const stopSettings = onSettingsChanged(applyTheme);
  return () => {
    query.removeEventListener('change', onSystemChange);
    stopSettings();
  };
}

function paint(resolved: ResolvedTheme, vars: Record<string, string>): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  current.set(resolved);
}

let windowTheme: ThemeChoice | null = null;

// Native menus, dialogs and the title bar follow this; null lets them follow the OS (Ruling 151).
function setWindowTheme(choice: ThemeChoice, always = false): void {
  if (choice === windowTheme && !always) return;
  windowTheme = choice;
  getCurrentWindow()
    .setTheme(choice === 'system' ? null : choice)
    .catch((err) => console.error('Could not set the window theme:', err));
}

function systemQuery(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

interface SavedTheme {
  theme: ResolvedTheme;
  choice: ThemeChoice;
  vars: Record<string, string>;
}

// The saved record is checked value by value against the kind each variable holds, so a
// tampered record can never put anything else on <html> (Ruling 155).
const HOVER = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (0|1|0?\.\d+)\)$/;
const PX = /^(\d{1,2})px$/;

function isSavedValue(name: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  switch (name) {
    case '--font-read':
    case '--font-edit':
      return isFontFamily(value);
    case '--size-read':
      return pxIn(value, 12, 24);
    case '--size-edit':
      return pxIn(value, 10, 22);
    case '--scheme':
      return value === 'light' || value === 'dark';
    case '--hover': {
      const m = HOVER.exec(value);
      return m !== null && m.slice(1, 4).every((c) => Number(c) <= 255);
    }
    default:
      return isColour(value);
  }
}

function pxIn(value: string, min: number, max: number): boolean {
  const m = PX.exec(value);
  return m !== null && Number(m[1]) >= min && Number(m[1]) <= max;
}

function isColour(value: string): boolean {
  try {
    channels(value);
    return true;
  } catch {
    return false;
  }
}

function isSavedTheme(value: unknown): value is SavedTheme {
  if (typeof value !== 'object' || value === null) return false;
  const { theme, choice, vars } = value as Partial<Record<keyof SavedTheme, unknown>>;
  if (theme !== 'light' && theme !== 'dark') return false;
  if (choice !== 'light' && choice !== 'dark' && choice !== 'system') return false;
  if (typeof vars !== 'object' || vars === null) return false;
  const known = Object.keys(cssVariables(DEFAULT_SETTINGS as Settings, theme));
  const saved = vars as Record<string, unknown>;
  return (
    Object.keys(saved).length === known.length &&
    known.every((name) => isSavedValue(name, saved[name]))
  );
}

// Light chrome is a shade toward the text; dark chrome a shade toward black, unless the
// background is too dark for that to show, when it moves toward the text instead.
function chromeFor(p: Palette, dark: boolean): string {
  if (!dark) return mix(p.background, p.text, 0.04);
  const deeper = mix(p.background, '#000000', 0.12);
  return contrastRatio(deeper, p.background) >= 1.02 ? deeper : mix(p.background, p.text, 0.06);
}

// The faintest text-into-background mix from 50% up that reads at 4.5:1 on every surface
// muted text sits on. When even the text colour cannot, muted is the text colour: the
// most contrast the palette has, still below 4.5:1 (the palette editor warns, Ruling 149).
function mutedFor(background: string, text: string, surfaces: string[]): string {
  for (let percent = 50; percent < 100; percent++) {
    const candidate = mix(background, text, percent / 100);
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= MIN_CONTRAST)) return candidate;
  }
  return text;
}

// The strongest accent tint up to `most` that keeps text on it at 4.5:1.
function accentTint(surface: string, p: Palette, most: number): string {
  for (let percent = Math.round(most * 100); percent > 0; percent--) {
    const tint = mix(surface, p.accent, percent / 100);
    if (contrastRatio(p.text, tint) >= MIN_CONTRAST) return tint;
  }
  return surface;
}

function fontStack(chosen: string, system: string): string {
  return chosen.trim() !== '' && isFontFamily(chosen) ? `${chosen.trim()}, ${system}` : system;
}

/** `from` moved `amount` (0-1) of the way toward `to`, as #RRGGBB. */
function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return `#${a
    .map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

function rgba(hex: string, alpha: number): string {
  return `rgba(${channels(hex).join(', ')}, ${alpha})`;
}

function channels(hex: string): [number, number, number] {
  const m = /^#(?:([0-9a-f]{6})|([0-9a-f]{3}))$/i.exec(hex);
  if (!m) throw new Error(`Not a #RGB or #RRGGBB colour: ${JSON.stringify(hex)}`);
  const full = m[1] ?? [...m[2]].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
