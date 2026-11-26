import { invoke } from '@tauri-apps/api/core';

export interface ReadResult {
  text: string;
  hash: string;
}

export function readTextFile(path: string): Promise<ReadResult> {
  return invoke<ReadResult>('read_text_file', { path });
}

/** Resolves to the sha-256 hex of the bytes written. */
export function writeTextFile(path: string, text: string): Promise<string> {
  return invoke<string>('write_text_file', { path, text });
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
