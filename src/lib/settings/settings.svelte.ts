import { emit, listen } from '@tauri-apps/api/event';
import { appDataDir, join } from '@tauri-apps/api/path';
import { load, type Store } from '@tauri-apps/plugin-store';
import type { ViewMode } from '../docs/store.svelte';
import { writeTextFile } from '../ipc';

export type ThemeChoice = 'light' | 'dark' | 'system';

export interface Palette {
  background: string; // #RRGGBB
  text: string;
  accent: string;
  link: string;
  codeBackground: string;
}

/** Persisted in settings.json, one top-level key per field. */
export interface Settings {
  version: 1;
  theme: ThemeChoice;
  palettes: { light: Palette; dark: Palette };
  readingFont: string; // '' = system UI font
  editorFont: string; // '' = system monospace
  fontSize: number; // 12–24, reading text in px
  defaultMode: ViewMode;
  recentLimit: number; // 0–20; 0 hides Open Recent
  lint: { enabled: boolean; rules: Record<string, boolean | object> };
  updates: { autoCheck: boolean };
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1,
  theme: 'system',
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
  readingFont: '',
  editorFont: '',
  fontSize: 16,
  defaultMode: 'split',
  recentLimit: 5,
  lint: { enabled: true, rules: { default: true } },
  updates: { autoCheck: true },
});

const FILE = 'settings.json';
const CHANGED = 'lintel://settings-changed';

/** The settings in force. Holds the defaults until `loadSettings` resolves. */
export const settings: Settings = $state(structuredClone(DEFAULT_SETTINGS) as Settings);

/**
 * Reads settings.json into `settings`. A file with an unknown `version` is copied to
 * settings.json.bak and emptied, and the defaults are used (Ruling 52).
 */
export async function loadSettings(): Promise<Settings> {
  const store = await settingsStore();
  const stored = new Map(await store.entries<unknown>());
  const next = structuredClone(DEFAULT_SETTINGS) as Settings;
  if (stored.size > 0 && stored.get('version') !== 1) {
    await keepBackup(Object.fromEntries(stored));
    await store.clear();
    await store.save();
  } else {
    for (const key of Object.keys(next) as (keyof Settings)[]) {
      const value = stored.get(key);
      if (sameShape(value, next[key])) (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  Object.assign(settings, next);
  return structuredClone(next);
}

/** Saves the patched settings to settings.json, then tells every window. */
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const next: Settings = { ...$state.snapshot(settings), ...patch, version: 1 };
  const store = await settingsStore();
  // Every key is written, so the file is whole even if it started empty.
  for (const [key, value] of Object.entries(next)) await store.set(key, value);
  await store.save();
  Object.assign(settings, next);
  await emit(CHANGED, next);
}

/** Calls `cb` after any window changes settings, this one included. Returns an unsubscribe. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  let active = true;
  const unlisten = listen<Settings>(CHANGED, ({ payload }) => {
    if (!active) return;
    Object.assign(settings, payload);
    cb(payload);
  });
  return () => {
    active = false;
    unlisten.then((stop) => stop());
  };
}

let opened: Promise<Store> | null = null;

// One store instance per file is shared by every window, so it is never closed.
function settingsStore(): Promise<Store> {
  opened ??= load(FILE, { autoSave: false }).catch((err) => {
    opened = null;
    throw err;
  });
  return opened;
}

async function keepBackup(entries: Record<string, unknown>): Promise<void> {
  const path = await join(await appDataDir(), `${FILE}.bak`);
  await writeTextFile(path, JSON.stringify(entries, null, 2));
}

function sameShape(value: unknown, fallback: unknown): boolean {
  if (value === undefined || typeof value !== typeof fallback) return false;
  if (typeof value !== 'object') return true;
  return value !== null && !Array.isArray(value);
}
