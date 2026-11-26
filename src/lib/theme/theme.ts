import { readonly, writable } from 'svelte/store';
import {
  DEFAULT_SETTINGS,
  onSettingsChanged,
  type Palette,
  type Settings,
  type ThemeChoice,
} from '../settings/settings.svelte';

export type ResolvedTheme = 'light' | 'dark';

/** One source for the defaults (Ruling 127). */
export const DEFAULT_PALETTES: Readonly<{ light: Palette; dark: Palette }> = DEFAULT_SETTINGS.palettes;

const SYSTEM_READ_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const SYSTEM_EDIT_FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const MIN_CONTRAST = 4.5;

const current = writable<ResolvedTheme>('light');
/** The theme last applied. Previews redraw their diagrams when it changes. */
export const resolvedTheme = readonly(current);

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

/** WCAG 2 contrast ratio of two #RRGGBB colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The twelve theme variables for the palette of `resolved` (Ruling 129). */
export function cssVariables(s: Settings, resolved: ResolvedTheme): Record<string, string> {
  const p = s.palettes[resolved];
  const chrome =
    resolved === 'light' ? mix(p.background, p.text, 0.04) : mix(p.background, '#000000', 0.12);
  return {
    '--bg': p.background,
    '--text': p.text,
    '--accent': p.accent,
    '--link': p.link,
    '--code-bg': p.codeBackground,
    '--chrome': chrome,
    '--border': mix(p.background, p.text, 0.14),
    '--muted': mutedFor(p.background, p.text, chrome),
    '--font-read': s.readingFont.trim() || SYSTEM_READ_FONT,
    '--font-edit': s.editorFont.trim() || SYSTEM_EDIT_FONT,
    '--size-read': `${s.fontSize}px`,
    '--size-edit': `${s.fontSize - 2}px`,
  };
}

/** Sets the variables, `data-theme` and `color-scheme` on <html>, then `resolvedTheme`. */
export function applyTheme(s: Settings): void {
  const resolved = resolveTheme(s.theme, systemQuery().matches);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(cssVariables(s, resolved))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  current.set(resolved);
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

function systemQuery(): MediaQueryList {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

// The faintest text-into-background mix from 50% up that stays readable on both the
// chrome and the background, so a custom palette cannot make muted text unreadable.
function mutedFor(background: string, text: string, chrome: string): string {
  for (let percent = 50; percent < 100; percent++) {
    const candidate = mix(background, text, percent / 100);
    if (
      contrastRatio(candidate, chrome) >= MIN_CONTRAST &&
      contrastRatio(candidate, background) >= MIN_CONTRAST
    ) {
      return candidate;
    }
  }
  return text;
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

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
