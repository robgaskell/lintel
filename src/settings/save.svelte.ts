import { updateSettings, type SettingsPatch } from '../lib/settings/settings.svelte';

/** The last change this window could not save; SettingsApp shows it. */
export const saveError = $state({ message: '' });

/** Saves a change from a Settings control. The window has no dialogs (Ruling 160). */
export function save(patch: SettingsPatch): void {
  updateSettings(patch).then(
    () => (saveError.message = ''),
    (err) => (saveError.message = `Could not save: ${err instanceof Error ? err.message : err}`),
  );
}
