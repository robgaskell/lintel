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
