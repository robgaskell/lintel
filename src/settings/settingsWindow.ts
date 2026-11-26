import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export type SettingsSection = 'appearance' | 'editor' | 'files' | 'lint' | 'updates';

export const SETTINGS_LABEL = 'settings';
/** Sent to an open Settings window to show a section (Ruling 144). */
export const SECTION_EVENT = 'lintel://settings-section';

let pending: Promise<void> = Promise.resolve();

/** Opens the one Settings window, or brings it forward if it is open. */
export function openSettingsWindow(section?: SettingsSection): Promise<void> {
  // One at a time, so two quick requests cannot both create the window.
  const run = pending.then(() => openOrFocus(section));
  pending = run.catch(() => {});
  return run;
}

/**
 * The Settings window if it is the focused window, else null. A failed check counts as
 * not focused, so menu commands still reach the main window.
 */
export async function focusedSettingsWindow(): Promise<WebviewWindow | null> {
  try {
    const win = await WebviewWindow.getByLabel(SETTINGS_LABEL);
    return win && (await win.isFocused()) ? win : null;
  } catch (err) {
    console.error('Could not check the Settings window:', err);
    return null;
  }
}

async function openOrFocus(section?: SettingsSection): Promise<void> {
  const open = await WebviewWindow.getByLabel(SETTINGS_LABEL);
  if (!open) return create(section);
  if (await open.isMinimized()) await open.unminimize();
  await open.show();
  await open.setFocus();
  if (section) await emitTo(SETTINGS_LABEL, SECTION_EVENT, section);
}

function create(section?: SettingsSection): Promise<void> {
  const query = new URLSearchParams({ view: 'settings' });
  if (section) query.set('section', section);
  const win = new WebviewWindow(SETTINGS_LABEL, {
    url: `/?${query}`,
    title: 'Settings',
    width: 900,
    height: 640,
    resizable: true,
    center: true,
  });
  return new Promise((resolve, reject) => {
    void win.once('tauri://created', () => resolve());
    void win.once('tauri://error', (event) => reject(event.payload));
  });
}
