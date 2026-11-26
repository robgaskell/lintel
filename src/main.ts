import { mount } from 'svelte';
import App from './App.svelte';
import SettingsApp from './settings/SettingsApp.svelte';
import { restoreTheme } from './lib/theme/theme';
import './app.css';

// Before the first render, so the app never paints in the wrong theme (Ruling 150).
restoreTheme();

// The Settings window loads the same page with ?view=settings (settingsWindow.ts).
const view = new URLSearchParams(location.search).get('view');
const app = mount(view === 'settings' ? SettingsApp : App, { target: document.getElementById('app')! });

export default app;
