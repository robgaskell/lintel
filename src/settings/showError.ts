import { message } from '@tauri-apps/plugin-dialog';

/** Reports a setting that could not be saved. */
export function showError(err: unknown): void {
  void message(String(err), { title: 'Lintel', kind: 'error' });
}
