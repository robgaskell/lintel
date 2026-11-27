import type { EditorView } from '@codemirror/view';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { SvelteMap } from 'svelte/reactivity';
import { parse as parseYaml } from 'yaml';
import { docs, setDocHooks, type DocState } from '../docs/store.svelte';
import { viewFor } from '../editor/views';
import { findLintConfig, unwatchPath, watchPath, type LintConfigResult } from '../ipc';
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
 * `extends` is dropped, since it could point anywhere (Ruling 285).
 */
export function parseLintConfig(r: LintConfigResult): ParsedLintConfig {
  const text = r.text.startsWith('\uFEFF') ? r.text.slice(1) : r.text;
  let value: unknown;
  try {
    value = r.format === 'yaml' ? parseYaml(text) : parseJson(text);
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err), note: null };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { config: null, error: 'Expected a set of rules, such as MD013: false.', note: null };
  }
  if (!('extends' in value)) return { config: value, error: null, note: null };
  const { extends: _ignored, ...rest } = value as Record<string, unknown>;
  return { config: rest, error: null, note: `${baseName(r.path)}: extends is not followed` };
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
}

// By config path. Reactive, so the status bar follows a config that breaks or mends.
const cache = new SvelteMap<string, CachedConfig>();
// Why find_lint_config failed, by doc id.
const failures = new SvelteMap<string, string>();
// The config each doc uses, and the docs using each config, which keep it watched.
const configOf = new Map<string, string>();
const usersOf = new Map<string, Set<string>>();
// The latest refresh of each doc; an older one that ends later is dropped.
const latest = new Map<string, number>();
// What each doc's editor was last linted with, so a refresh that finds the same skips it.
const linted = new Map<string, string>();
let refreshes = 0;

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
  if (failure) return { text: 'Lint config error', details: failure };
  const file = doc.lintConfigPath ? cache.get(doc.lintConfigPath) : undefined;
  if (file?.error) return { text: `Lint config error: ${file.name}`, details: file.error };
  if (file?.note) return { text: file.note, details: null };
  return null;
}

/**
 * Finds and reads `doc`'s config file, watches it, and lints `view` (or the doc's editor)
 * again if the config changed. A newer refresh of the same doc wins.
 */
export async function refreshConfig(doc: DocState, view?: EditorView): Promise<void> {
  const refresh = ++refreshes;
  latest.set(doc.id, refresh);
  const path = doc.path;
  let found: LintConfigResult | null = null;
  let failure: string | null = null;
  if (path !== null) {
    try {
      found = await findLintConfig(path);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
  }
  if (latest.get(doc.id) !== refresh || docs.get(doc.id) !== doc || doc.path !== path) return;
  if (found) cache.set(found.path, { name: baseName(found.path), ...parseLintConfig(found) });
  if (failure === null) failures.delete(doc.id);
  else failures.set(doc.id, failure);
  use(doc, found);
  const key = found ? `${found.path}\n${found.hash}` : `none\n${failure}`;
  if (linted.get(doc.id) === key) return;
  linted.set(doc.id, key);
  const target = view ?? viewFor(doc.id);
  if (target) relint(target);
}

function use(doc: DocState, found: LintConfigResult | null): void {
  const next = found?.path ?? null;
  const previous = configOf.get(doc.id) ?? null;
  doc.lintConfigPath = next;
  if (next === previous) return;
  if (found) {
    configOf.set(doc.id, found.path);
    addUser(found, doc.id);
  } else {
    configOf.delete(doc.id);
  }
  if (previous !== null) dropUser(previous, doc.id);
}

// One watch per config file per window, however many docs use it (Ruling 284).
function addUser(found: LintConfigResult, id: string): void {
  const users = usersOf.get(found.path) ?? new Set<string>();
  usersOf.set(found.path, users);
  users.add(id);
  if (users.size === 1) settle('Could not watch the lint config:', () => watchPath(found.path, found.hash));
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
  const path = configOf.get(id);
  if (path === undefined) return;
  configOf.delete(id);
  dropUser(path, id);
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
  refreshAllConfigs();
  return () => setDocHooks(null);
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
