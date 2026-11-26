import { mount } from 'svelte';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App.svelte';
import SettingsApp from './settings/SettingsApp.svelte';
import { restoreTheme } from './lib/theme/theme';
import './app.css';

// Before the first render, so the app never paints in the wrong theme (Ruling 150).
restoreTheme();

// The Settings window loads the same page with ?view=settings (settingsWindow.ts).
const view = new URLSearchParams(location.search).get('view');
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
requestAnimationFrame(() => requestAnimationFrame(show));
setTimeout(show, 100);

export default app;
