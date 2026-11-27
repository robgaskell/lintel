import { mount } from 'svelte';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App.svelte';
import SettingsApp from './settings/SettingsApp.svelte';
import { restoreTheme, setsWindowAppearance } from './lib/theme/theme';
import { whenRestored } from './lib/os/session';
import { whenAdopted } from './lib/os/windows';
import './app.css';

// The Settings window loads the same page with ?view=settings (settingsWindow.ts).
const view = new URLSearchParams(location.search).get('view');

// Before the first render, so the app never paints in the wrong theme (Ruling 150).
// Settings never wears a custom palette, so it stays readable while one is edited (Ruling 158).
// Nor may it call app commands; the document windows set its appearance (Rulings 160, 195).
if (view === 'settings') setsWindowAppearance(false);
restoreTheme({ defaultPalettes: view === 'settings' });

const app = mount(view === 'settings' ? SettingsApp : App, { target: document.getElementById('app')! });

// Windows open hidden; two frames on, a themed frame has been painted (Ruling 154). WebKit
// may hold frames back from a hidden window, so a short timer shows it in that case.
let shown = false;
function show() {
  if (shown) return;
  shown = true;
  getCurrentWindow()
    .show()
    .catch((err) => console.error('Could not show the window:', err));
}
function showOncePainted() {
  requestAnimationFrame(() => requestAnimationFrame(show));
  setTimeout(show, 100);
}

// A document window waits for its moved doc or its restored session, so it never shows
// empty first (Rulings 184, 205). Settings has neither.
const READY_DEADLINE_MS = 2000;
if (view === 'settings') {
  showOncePainted();
} else {
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, READY_DEADLINE_MS));
  void Promise.race([whenAdopted(), whenRestored(), deadline]).then(showOncePainted);
}

export default app;
