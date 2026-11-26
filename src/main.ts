import { mount } from 'svelte';
import App from './App.svelte';
import { restoreTheme } from './lib/theme/theme';
import './app.css';

// Before the first render, so the app never paints in the wrong theme (Ruling 150).
restoreTheme();

const app = mount(App, { target: document.getElementById('app')! });

export default app;
