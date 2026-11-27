import type { EditorView } from '@codemirror/view';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { SvelteMap } from 'svelte/reactivity';
import { parse as parseYaml } from 'yaml';
import { docs, setDocHooks, watchFailed, type DocState } from '../docs/store.svelte';
import { viewFor } from '../editor/views';
import { findLintConfig, unwatchPath, watchPath, type LintConfigError, type LintConfigResult } from '../ipc';
import { settings } from '../settings/settings.svelte';
import { relint } from './lintExtension';

/** The names find_lint_config looks for, in its order. */
export const CONFIG_NAMES = ['.markdownlint.json', '.markdownlint.jsonc', '.markdownlint.yaml', '.markdownlint.yml'];

export interface ParsedLintConfig {
  config: object | null;
  error: string | null;
  /** Something the file asks for that Lintel ignores. */
  note: string | null;
}

/**
 * Reads a config file's text as data: JSON with comments and trailing commas, or YAML.
 * `extends` is dropped, since it could point anywhere (Ruling 285), and so is any
 * `__proto__` key (Ruling 299).
 */
export function parseLintConfig(r: LintConfigResult): ParsedLintConfig {
  const text = r.text.startsWith('\uFEFF') ? r.text.slice(1) : r.text;
  let value: unknown;
  try {
    value = withoutProto(r.format === 'yaml' ? parseYaml(text) : parseJson(text));
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err), note: null };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { config: null, error: 'Expected a set of rules, such as MD013: false.', note: null };
  }
  const { extends: followed, ...rest } = value as Record<string, unknown>;
  const note = followed == null ? null : `${baseName(r.path)}: extends is not followed`;
  return { config: rest, error: null, note };
}

/**
 * A plain copy without "__proto__" keys, which a parser can turn into the object's
 * prototype. Throws for a loop, which YAML aliases can make and no config needs.
 */
function withoutProto(value: unknown, parents: object[] = []): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (parents.includes(value)) throw new Error('The file refers to itself in a loop.');
  const inside = [...parents, value];
  if (Array.isArray(value)) return value.map((item) => withoutProto(item, inside));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== '__proto__') copy[key] = withoutProto(item, inside);
  }
  return copy;
}

function parseJson(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length === 0) return value;
  const { error, offset } = errors[0];
  // "CommaExpected" reads as "Comma expected".
  const what = printParseErrorCode(error).replace(/(?<=.)([A-Z])/g, (c) => ` ${c.toLowerCase()}`);
  throw new Error(`${what} on line ${text.slice(0, offset).split('\n').length}.`);
}

interface CachedConfig extends ParsedLintConfig {
  name: string;
  hash: string;
}

interface Failure {
  name: string | null;
  message: string;
}

// By config path. Reactive, so the status bar follows a config that breaks or mends.
const cache = new SvelteMap<string, CachedConfig>();
// Why find_lint_config failed, by doc id.
const failures = new SvelteMap<string, Failure>();
// The config files each doc keeps watched, and the docs keeping each one watched.
const watchedFor = new Map<string, Set<string>>();
const usersOf = new Map<string, Set<string>>();
// The latest refresh of each doc; an older one that ends later is dropped.
const latest = new Map<string, number>();
// What each doc's editor was last linted with, so a refresh that finds the same skips it.
const linted = new Map<string, string>();
let refreshes = 0;
// A focus looks again at most this often, as each look reaches the disk (Ruling 298).
export const FOCUS_REFRESH_MS = 5000;
let lastFocusRefresh = -Infinity;
let trailingFocusRefresh: ReturnType<typeof setTimeout> | null = null;

/** The rules from Settings, or null while linting is off (Ruling 268). */
export function settingsLintConfig(): object | null {
  return settings.lint.enabled ? JSON.parse(JSON.stringify(settings.lint.rules)) : null;
}

/**
 * What `doc` is linted with: its config file's rules when the file reads cleanly, else
 * the rules in Settings, or null while linting is off.
 */
export function currentConfig(doc: DocState | undefined): object | null {
  if (!settings.lint.enabled) return null;
  const file = fileConfig(doc);
  return file ? structuredClone(file.config) : settingsLintConfig();
}

/** The file name of the config in force for `doc`, or null when Settings rules apply. */
export function configSource(doc: DocState | undefined): string | null {
  return fileConfig(doc)?.name ?? null;
}

function fileConfig(doc: DocState | undefined): (CachedConfig & { config: object }) | null {
  const file = doc?.lintConfigPath ? cache.get(doc.lintConfigPath) : undefined;
  return file?.config ? (file as CachedConfig & { config: object }) : null;
}

/** What the status bar's lint area says about `doc`'s config, if anything (Ruling 287). */
export function configStatus(doc: DocState | undefined): { text: string; details: string | null } | null {
  if (!doc || !settings.lint.enabled) return null;
  const failure = failures.get(doc.id);
  if (failure) {
    const text = failure.name === null ? 'Lint config error' : `Lint config error: ${failure.name}`;
    return { text, details: failure.message };
  }
  const file = doc.lintConfigPath ? cache.get(doc.lintConfigPath) : undefined;
  if (file?.error) return { text: `Lint config error: ${file.name}`, details: file.error };
  if (file?.note) return { text: file.note, details: null };
  return null;
}

/**
 * Finds and reads `doc`'s config file, watches it, and lints `view` (or the doc's editor)
 * again if the config changed. A newer refresh of the same doc wins. A search that runs
 * out of time changes nothing.
 */
export async function refreshConfig(doc: DocState, view?: EditorView): Promise<void> {
  const refresh = ++refreshes;
  latest.set(doc.id, refresh);
  const path = doc.path;
  let found: LintConfigResult | null = null;
  let failure: LintConfigError | null = null;
  if (path !== null) {
    try {
      found = await findLintConfig(path);
    } catch (err) {
      failure = asFindError(err);
    }
  }
  if (latest.get(doc.id) !== refresh || docs.get(doc.id) !== doc || doc.path !== path) return;
  if (failure?.timedOut) return;
  if (found && cache.get(found.path)?.hash !== found.hash) {
    cache.set(found.path, { name: baseName(found.path), hash: found.hash, ...parseLintConfig(found) });
  }
  if (failure === null) {
    failures.delete(doc.id);
    doc.lintConfigPath = found?.path ?? null;
    const next = new Map(found ? [[found.path, found.hash]] : []);
    // A deleted config stays watched while it would apply again, so its return is heard (Ruling 346).
    for (const kept of watchedFor.get(doc.id) ?? []) {
      if (!next.has(kept) && wouldApply(kept, path, found?.path)) next.set(kept, '');
    }
    watchOnly(doc.id, next);
  } else {
    failures.set(doc.id, { name: failure.path === null ? null : baseName(failure.path), message: failure.message });
    doc.lintConfigPath = null;
    // Settings rules apply. The old config and the failing file stay watched, so a repair
    // to either is heard (Rulings 298, 310). The failing file's hash is unknown.
    const kept = new Map([...(watchedFor.get(doc.id) ?? [])].map((path) => [path, '']));
    if (failure.path !== null && !kept.has(failure.path)) kept.set(failure.path, '');
    watchOnly(doc.id, kept);
  }
  const key = found ? `${found.path}\n${found.hash}` : `none\n${failure?.path}\n${failure?.message}`;
  if (linted.get(doc.id) === key) return;
  linted.set(doc.id, key);
  const target = view ?? viewFor(doc.id);
  if (target) relint(target);
}

/** Makes `next` (config path to known hash) the set of files the doc keeps watched. */
function watchOnly(id: string, next: Map<string, string>): void {
  const current = watchedFor.get(id) ?? new Set<string>();
  for (const [path, hash] of next) if (!current.has(path)) addUser(path, hash, id);
  for (const path of current) if (!next.has(path)) dropUser(path, id);
  if (next.size > 0) watchedFor.set(id, new Set(next.keys()));
  else watchedFor.delete(id);
}

// One watch per config file per window, however many docs use it (Ruling 284).
function addUser(path: string, hash: string, id: string): void {
  const users = usersOf.get(path) ?? new Set<string>();
  usersOf.set(path, users);
  users.add(id);
  if (users.size !== 1) return;
  Promise.resolve()
    .then(() => watchPath(path, hash))
    .catch(watchFailed);
}

function dropUser(path: string, id: string): void {
  const users = usersOf.get(path);
  if (!users?.delete(id) || users.size > 0) return;
  usersOf.delete(path);
  cache.delete(path);
  settle('Could not stop watching the lint config:', () => unwatchPath(path));
}

/** Stops following the config of a doc that left this window. */
function forget(id: string): void {
  latest.delete(id);
  linted.delete(id);
  failures.delete(id);
  watchOnly(id, new Map());
}

/** A config file changed or went away on disk: the docs using it look again. */
export function handleConfigFileEvent(path: string): void {
  for (const id of usersOf.get(path) ?? []) {
    const doc = docs.get(id);
    if (doc) runRefresh(doc);
  }
}

/** Every doc looks again, which finds a config file created nearer to it. */
export function refreshAllConfigs(): void {
  for (const doc of docs.values()) runRefresh(doc);
}

/**
 * As refreshAllConfigs, but at most once in FOCUS_REFRESH_MS; for each window focus. A
 * focus inside that time gets one look at its end, so a config made then is found.
 * `now` is monotonic, so a clock set back cannot hold the looks off (Ruling 310).
 */
export function refreshConfigsOnFocus(now = performance.now()): void {
  const wait = lastFocusRefresh + FOCUS_REFRESH_MS - now;
  if (wait > 0) {
    trailingFocusRefresh ??= setTimeout(() => {
      trailingFocusRefresh = null;
      refreshConfigsOnFocus(lastFocusRefresh + FOCUS_REFRESH_MS);
    }, wait);
    return;
  }
  stopTrailingFocusRefresh();
  lastFocusRefresh = now;
  refreshAllConfigs();
}

function stopTrailingFocusRefresh(): void {
  if (trailingFocusRefresh !== null) clearTimeout(trailingFocusRefresh);
  trailingFocusRefresh = null;
}

function asFindError(err: unknown): LintConfigError {
  if (typeof err === 'object' && err !== null && typeof (err as LintConfigError).message === 'string') {
    const { path = null, message, timedOut = false } = err as Partial<LintConfigError> & { message: string };
    return { path, message, timedOut };
  }
  return { path: null, message: String(err), timedOut: false };
}

/** Lintel wrote `path`: a config in use is read again; a new one may now apply. */
export function configWritten(path: string): void {
  if (usersOf.has(path)) handleConfigFileEvent(path);
  else if (CONFIG_NAMES.includes(baseName(path))) refreshAllConfigs();
}

/**
 * Refreshes each doc's config as it opens, is restored or handed over, and after Save
 * As; follows Lintel's own config saves. Returns a stop function.
 */
export function followDocConfigs(): () => void {
  setDocHooks({
    placed: runRefresh,
    removed: forget,
    saved(doc, oldPath) {
      if (doc.path !== oldPath) runRefresh(doc);
      if (doc.path !== null) configWritten(doc.path);
    },
  });
  lastFocusRefresh = -Infinity;
  stopTrailingFocusRefresh();
  refreshAllConfigs();
  return () => {
    setDocHooks(null);
    stopTrailingFocusRefresh();
  };
}

function runRefresh(doc: DocState): void {
  refreshConfig(doc).catch((err) => console.error('Could not refresh the lint config:', err));
}

// Also catches a call that throws before it returns a promise.
function settle(what: string, run: () => Promise<void>): void {
  Promise.resolve()
    .then(run)
    .catch((err) => console.error(what, err));
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Whether the search from `docPath` reaches `config`'s folder no later than the found config's. */
function wouldApply(config: string, docPath: string | null, found: string | undefined): boolean {
  if (docPath === null) return false;
  const folder = folderOf(config);
  return isWithin(folderOf(docPath), folder) && (found === undefined || isWithin(folder, folderOf(found)));
}

function folderOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
}

// Both paths come canonical from Rust, so comparing text is enough.
function isWithin(path: string, folder: string): boolean {
  return path === folder || (path.startsWith(folder) && /[\\/]/.test(path.charAt(folder.length)));
}
