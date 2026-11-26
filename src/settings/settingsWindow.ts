import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { get } from 'svelte/store';
import { settings } from '../lib/settings/settings.svelte';
import { resolvedTheme } from '../lib/theme/theme';

export type SettingsSection = 'appearance' | 'editor' | 'files' | 'lint' | 'updates';

export const SETTINGS_LABEL = 'settings';
// Its page shows it once painted; after this long it is shown anyway (Ruling 154).
const SHOW_DEADLINE_MS = 2000;
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
    // Hidden and in the app's theme until its page has painted, as the main window is.
    visible: false,
    theme: settings.theme === 'system' ? undefined : settings.theme,
    backgroundColor: settings.palettes[get(resolvedTheme)].background,
  });
  return new Promise((resolve, reject) => {
    void win.once('tauri://created', () => {
      setTimeout(() => void showIfHidden(win), SHOW_DEADLINE_MS);
      resolve();
    });
    void win.once('tauri://error', (event) => reject(event.payload));
  });
}

async function showIfHidden(win: WebviewWindow): Promise<void> {
  try {
    if (!(await win.isVisible())) await win.show();
  } catch (err) {
    // Fails when the window was closed before the deadline.
    console.error('Could not show the Settings window:', err);
  }
}
