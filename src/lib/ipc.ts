import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

export interface ReadResult {
  text: string;
  hash: string;
}

export function readTextFile(path: string): Promise<ReadResult> {
  return invoke<ReadResult>('read_text_file', { path });
}

/** A fresh read-only copy of the bundled third-party notices, in the cache folder (Ruling 332). */
export function copyNotices(): Promise<string> {
  return invoke<string>('copy_notices');
}

/**
 * Resolves to the sha-256 hex of the bytes written. With `expectedHash`, a file on disk with
 * other bytes is left alone and the call rejects with CHANGED_ON_DISK (Ruling 357).
 */
export function writeTextFile(
  path: string,
  text: string,
  expectedHash: string | null = null,
): Promise<string> {
  return invoke<string>('write_text_file', { path, text, expectedHash });
}

/** Writes `base64`'s bytes atomically, as Save does; for exports such as .docx (Ruling 314). */
export function writeBinaryFile(path: string, base64: string): Promise<void> {
  return invoke<void>('write_binary_file', { path, base64 });
}

/** The canonical path of an existing file (symlinks and `.` resolved). Rejects if it is missing. */
export function normalizePath(path: string): Promise<string> {
  return invoke<string>('normalize_path', { path });
}

/** Whether each path is an existing file, in the same order. Never rejects for a missing path. */
export function pathsExist(paths: string[]): Promise<boolean[]> {
  return invoke<boolean[]>('paths_exist', { paths });
}

/** A local png, jpg, gif, webp or svg (10 MB at most) as a `data:` URI. Rejects with a message otherwise. */
export function readImageAsDataUri(path: string): Promise<string> {
  return invoke<string>('read_image_as_data_uri', { path });
}

/**
 * An http(s) png, jpg, gif, webp or svg (10 MB at most) as a `data:` URI, fetched by Rust so
 * the webview never reaches the network (Ruling 113). Rejects with a message otherwise.
 */
export function fetchRemoteImage(url: string): Promise<string> {
  return invoke<string>('fetch_remote_image', { url });
}

/**
 * Claims `path` for this window. Resolves to the label of another window that already has
 * it open (Rust then shows it there, unless `reveal` is false), or null once this window owns it.
 */
export function claimPath(path: string, { reveal = true } = {}): Promise<string | null> {
  return invoke<string | null>('claim_path', reveal ? { path } : { path, reveal });
}

/** Drops this window's claim on `path`. */
export function releasePath(path: string): Promise<void> {
  return invoke<void>('release_path', { path });
}

/** Sent by Rust to each window that watches a file whose bytes changed on disk. */
export const FILE_CHANGED = 'lintel://file-changed';
/** Sent by Rust to each window that watches a file that is gone from disk. */
export const FILE_REMOVED = 'lintel://file-removed';

/** Sent by Rust to each window watching a file whose folder it could not watch (Ruling 358). */
export const WATCH_FAILED = 'lintel://watch-failed';

export interface WatchFailedEvent {
  message: string;
}

export interface FileChangedEvent {
  path: string;
  hash: string;
}

export interface FileRemovedEvent {
  path: string;
}

/**
 * Adds a watch of `path` for this window; each needs its own unwatchPath (Ruling 283).
 * `knownHash` is the hash of the text this window has; a file that differs is reported at once.
 */
export function watchPath(path: string, knownHash: string): Promise<void> {
  return invoke<void>('watch_path', { path, knownHash });
}

/** Removes one of this window's watches of `path`; other windows' watches stay. */
export function unwatchPath(path: string): Promise<void> {
  return invoke<void>('unwatch_path', { path });
}

export interface LintConfigResult {
  path: string;
  format: 'json' | 'jsonc' | 'yaml';
  text: string;
  hash: string;
}

/** Why find_lint_config failed; `path` is the config file it could not read, if any. */
export interface LintConfigError {
  path: string | null;
  message: string;
  timedOut: boolean;
}

/**
 * The nearest markdownlint config file at or above the doc's folder, or null (Ruling 285).
 * Rejects with a LintConfigError.
 */
export function findLintConfig(docPath: string): Promise<LintConfigResult | null> {
  return invoke<LintConfigResult | null>('find_lint_config', { docPath });
}

/**
 * Sets the native appearance of every window on macOS: "light", "dark", or null to follow
 * the system. A no-op elsewhere (Ruling 195).
 */
export function setWindowAppearance(theme: 'light' | 'dark' | null): Promise<void> {
  return invoke<void>('set_window_appearance', { theme });
}

/**
 * Starts handing this window's doc, and its `path` if any, to the window `toLabel`.
 * Resolves to the hand-over id; the path stays here until the hand-over completes.
 */
export function transferPath(path: string | null, toLabel: string): Promise<number> {
  return invoke<number>('transfer_path', { path, toLabel });
}

/** For the new window: true when it may take the doc in, false when the opener kept it. */
export function completeHandoff(id: number): Promise<boolean> {
  return invoke<boolean>('complete_handoff', { id });
}

/** For the opener: true when it keeps the doc, false when the new window already took it. */
export function cancelHandoff(id: number): Promise<boolean> {
  return invoke<boolean>('cancel_handoff', { id });
}

/** Where hand-overs stand app-wide; `since` is the `completed` count from an earlier call. */
export interface HandoffStatus {
  pending: number;
  completed: number;
  adopters: string[];
}

export function handoffStatus(since: number): Promise<HandoffStatus> {
  return invoke<HandoffStatus>('handoff_status', { since });
}

/** Marks this window ready for files opened from outside; resolves to those sent before any was. */
export function frontendReady(): Promise<string[]> {
  return invoke<string[]>('frontend_ready');
}

// Settings has no app commands (Ruling 160), so it asks Rust for these by event (Ruling 245).
export const OS_ACTION = 'lintel://os-action';
export const OS_ACTION_RESULT = 'lintel://os-action-result';
const OS_ACTION_TIMEOUT_MS = 30_000;

export interface OsActionEvent {
  action: 'install-cli' | 'make-default';
  requestId: string;
}

export interface OsActionResultEvent {
  requestId: string;
  ok: boolean;
  message: string;
}

/** Installs the `lintel` command. Resolves to a message naming its path, with a PATH hint if needed. */
export function installCli(): Promise<string> {
  return runOsAction('install-cli');
}

/** Makes Lintel the default for Markdown files; on Windows it opens Default apps instead. */
export async function makeDefaultHandler(): Promise<void> {
  await runOsAction('make-default');
}

async function runOsAction(action: OsActionEvent['action']): Promise<string> {
  const requestId = crypto.randomUUID();
  let resolve: (message: string) => void = () => {};
  let reject: (err: Error) => void = () => {};
  const answer = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));
  // Listens before asking, so a quick answer cannot be missed.
  const stop = await listen<OsActionResultEvent>(OS_ACTION_RESULT, ({ payload }) => {
    if (payload.requestId !== requestId) return;
    if (payload.ok) resolve(payload.message);
    else reject(new Error(payload.message));
  });
  const timer = setTimeout(() => reject(new Error('Lintel did not answer. Try again.')), OS_ACTION_TIMEOUT_MS);
  try {
    await emit(OS_ACTION, { action, requestId } satisfies OsActionEvent);
    return await answer;
  } finally {
    clearTimeout(timer);
    stop();
  }
}
