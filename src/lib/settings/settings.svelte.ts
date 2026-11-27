import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appDataDir, join } from '@tauri-apps/api/path';
import { load, type Store } from '@tauri-apps/plugin-store';
import type { ViewMode } from '../docs/store.svelte';
import { writeTextFile } from '../ipc';
import { normaliseRules } from '../lint/ruleNames';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type RemoteImagesChoice = 'ask' | 'load' | 'block';

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
  remoteImages: RemoteImagesChoice;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = deepFreeze({
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
  remoteImages: 'ask',
} satisfies Settings);

const FILE = 'settings.json';
const CHANGED = 'lintel://settings-changed';

/** The settings in force. Holds the defaults until `loadSettings` resolves. */
export const settings: Settings = $state(structuredClone(DEFAULT_SETTINGS) as Settings);

/**
 * A change to apply: top-level values replace, objects such as `palettes` are merged by key.
 * A lint rule set to `null` is deleted, so each rule keeps one key (Ruling 270).
 */
export type SettingsPatch = {
  [K in Exclude<keyof Settings, 'lint'>]?: Settings[K] extends object ? DeepPartial<Settings[K]> : Settings[K];
} & { lint?: { enabled?: boolean; rules?: Record<string, boolean | object | null> } };
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// Set when this window could not read settings.json; saving then would mislabel the file.
let loadFailed = false;

// The number of the newest write this window has taken in (Ruling 281).
let appliedRevision = 0;

/** What `update_settings` returns: every stored setting after that write, and its number. */
interface Written {
  revision: number;
  entries: Record<string, unknown>;
}

/** A whole-key replacement Rust makes only if the key still holds `from`. */
type Repairs = Record<string, { from: unknown; to: unknown }>;

/**
 * Reads settings.json into `settings`; a field that is missing or invalid gets its default.
 * A file with an unknown `version` is copied to settings.json.bak and emptied (Ruling 52).
 * If that copy fails, the file is left alone, the defaults are used, and this rejects.
 */
export function loadSettings(): Promise<Settings> {
  return oneAtATime(async () => {
    try {
      // A load reads every write so far.
      appliedRevision = 0;
      const loaded = await readStore();
      loadFailed = false;
      return loaded;
    } catch (err) {
      loadFailed = true;
      throw err;
    }
  });
}

/**
 * Saves the patched keys to settings.json, then tells every window. Rust's
 * `update_settings` merges each patch into the stored value under one lock, so changes
 * from two windows never undo each other (Rulings 140, 159, 271). Rejects, saving
 * nothing, if this window's load failed.
 */
export function updateSettings(patch: SettingsPatch): Promise<void> {
  return oneAtATime(async () => {
    if (loadFailed) {
      throw new Error(
        'Settings could not be loaded, so this change was not saved. Restart Lintel to try again.',
      );
    }
    let written = await write(patch);
    const repairs = repairsFor(new Map(Object.entries(written.entries)));
    if (repairs) {
      // The patch merged into a value this window cannot read: replace it, then patch again.
      await write({}, repairs);
      written = await write(patch);
    }
    applySnapshot(written);
  });
}

function write(patch: SettingsPatch, replace?: Repairs): Promise<Written> {
  const defaults = Object.fromEntries(Object.keys(patch).map((key) => [key, defaultOf(key)]));
  return invoke<Written>('update_settings', { patch, defaults, replace });
}

// Skips a snapshot older than a change already heard, which it would undo.
function applySnapshot({ revision, entries }: Written): void {
  if (revision <= appliedRevision) return;
  appliedRevision = revision;
  Object.assign(settings, readSettings(new Map(Object.entries(entries))));
}

/**
 * Each stored key whose reader rejects or alters it, with the value this window uses
 * instead. Writing that back keeps a hand-edited value from blocking later edits (Ruling 280).
 */
function repairsFor(stored: Map<string, unknown>): Repairs | null {
  const repairs: Repairs = {};
  for (const [key, read] of Object.entries(READERS)) {
    const value = stored.get(key);
    if (value === undefined || value === null) continue;
    const kept = read(value) ?? defaultOf(key);
    if (!sameJson(kept, value)) repairs[key] = { from: value, to: kept };
  }
  return Object.keys(repairs).length ? repairs : null;
}

function repairQuietly(repairs: Repairs): Promise<void> {
  return write({}, repairs).then(applySnapshot, (err) => console.error('Could not repair settings:', err));
}

function defaultOf(key: string): unknown {
  return structuredClone((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]);
}

// Equal as JSON, whatever the key order.
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameJson(a[key], b[key]));
  }
  return a === b;
}

/**
 * Calls `cb` with this window's merged settings after any window changes them, this one
 * included. Returns an unsubscribe. `onError` hears about a listener that could not be registered.
 */
export function onSettingsChanged(
  cb: (s: Settings) => void,
  onError: (err: unknown) => void = (err) => console.error('Could not watch settings:', err),
): () => void {
  let active = true;
  const unlisten = listen<{ revision: number; changes: Record<string, unknown> }>(CHANGED, ({ payload }) => {
    if (!active) return;
    // Another listener here, or this window's own snapshot, may have taken it in already.
    if (payload.revision > appliedRevision) {
      appliedRevision = payload.revision;
      const changes = new Map(Object.entries(payload.changes));
      for (const [key, value] of changes) {
        const read = (READERS as Record<string, Reader<unknown>>)[key];
        if (read) (settings as unknown as Record<string, unknown>)[key] = read(value) ?? defaultOf(key);
      }
      const repairs = repairsFor(changes);
      if (repairs && !loadFailed) void oneAtATime(() => repairQuietly(repairs));
    }
    cb($state.snapshot(settings) as Settings);
  });
  unlisten.catch(onError);
  return () => {
    active = false;
    unlisten.then((stop) => stop()).catch(() => {});
  };
}

async function readStore(): Promise<Settings> {
  const store = await settingsStore();
  const stored = new Map(await store.entries<unknown>());
  let next = structuredClone(DEFAULT_SETTINGS) as Settings;
  if (stored.size > 0 && stored.get('version') !== 1) {
    Object.assign(settings, next);
    await keepBackup(Object.fromEntries(stored));
    await store.clear();
    await store.save();
  } else {
    next = readSettings(stored);
    const repairs = repairsFor(stored);
    if (repairs) await repairQuietly(repairs);
  }
  Object.assign(settings, next);
  return structuredClone(next);
}

// Each stored field as its reader takes it, or the default.
function readSettings(stored: Map<string, unknown>): Settings {
  const next = structuredClone(DEFAULT_SETTINGS) as Settings;
  for (const [key, read] of Object.entries(READERS)) {
    const value = read(stored.get(key));
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}

let queue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
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

type Reader<T> = (value: unknown) => T | undefined;

/** One reader per stored field: the value to use, or undefined to keep the default. */
const READERS: { [K in Exclude<keyof Settings, 'version'>]: Reader<Settings[K]> } = {
  theme: oneOf(['light', 'dark', 'system']),
  palettes: (value) => {
    if (!isRecord(value)) return undefined;
    const light = readPalette(value.light);
    const dark = readPalette(value.dark);
    return light && dark ? { light, dark } : undefined;
  },
  readingFont: readFont,
  editorFont: readFont,
  fontSize: intIn(12, 24),
  defaultMode: oneOf(['edit', 'split', 'read']),
  recentLimit: intIn(0, 20),
  lint: (value) =>
    isRecord(value) && typeof value.enabled === 'boolean' && isRecord(value.rules)
      ? { enabled: value.enabled, rules: normaliseRules(value.rules) }
      : undefined,
  updates: (value) =>
    isRecord(value) && typeof value.autoCheck === 'boolean'
      ? { autoCheck: value.autoCheck }
      : undefined,
  remoteImages: oneOf(['ask', 'load', 'block']),
};

function oneOf<T extends string>(allowed: readonly T[]): Reader<T> {
  return (value) => (allowed.includes(value as T) ? (value as T) : undefined);
}

function intIn(min: number, max: number): Reader<number> {
  return (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.round(value)))
      : undefined;
}

// A family is a quoted string or a run of unquoted words; anything else, such as `;`,
// braces or `!important`, could end the declaration it is put in.
const FAMILY = String.raw`(?:"[^"\\;{}]*"|'[^'\\;{}]*'|[A-Za-z0-9_-]+(?:[ ]+[A-Za-z0-9_-]+)*)`;
const FONT_FAMILY = new RegExp(String.raw`^\s*${FAMILY}(?:\s*,\s*${FAMILY})*\s*$`);

/** True for a CSS font-family list such as `"SF Mono", Menlo, monospace`. */
export function isFontFamily(value: string): boolean {
  return FONT_FAMILY.test(value);
}

// '' means the system font; any other value must be a font-family list (Ruling 152).
function readFont(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value === '' || isFontFamily(value) ? value : '';
}

const COLOUR = /^#[0-9A-Fa-f]{6}$/;

function readPalette(value: unknown): Palette | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ['background', 'text', 'accent', 'link', 'codeBackground'] as const;
  if (!keys.every((key) => typeof value[key] === 'string' && COLOUR.test(value[key]))) {
    return undefined;
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as Palette;
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
