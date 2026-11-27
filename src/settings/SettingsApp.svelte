<script module lang="ts">
  import type { Component } from 'svelte';
  import AppearanceSection from './AppearanceSection.svelte';
  import EditorSection from './EditorSection.svelte';
  import FilesSection from './FilesSection.svelte';
  import LintSection from './LintSection.svelte';

  /** The sidebar, in order. A later step adds Updates. */
  export const sections: { id: string; label: string; component: Component }[] = [
    { id: 'appearance', label: 'Appearance', component: AppearanceSection },
    { id: 'editor', label: 'Editor', component: EditorSection },
    { id: 'files', label: 'Files', component: FilesSection },
    { id: 'lint', label: 'Lint', component: LintSection },
  ];
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { loadSettings, onSettingsChanged, settings, type Settings } from '../lib/settings/settings.svelte';
  import { DEFAULT_PALETTES, followTheme } from '../lib/theme/theme';
  import { saveError } from './save.svelte';
  import { isMac } from '../lib/os/platform';
  import { SECTION_EVENT } from './settingsWindow';

  let current = $state(known(new URLSearchParams(location.search).get('section')) ?? sections[0].id);
  let ready = $state(false);
  let loadError = $state('');
  const Section = $derived(sections.find((s) => s.id === current)!.component);

  function known(id: unknown): string | null {
    return sections.some((s) => s.id === id) ? (id as string) : null;
  }

  onMount(() => {
    let disposed = false;
    let stopTheme = () => {};
    // This window has its own copy of the settings. Until it is loaded and kept in step
    // with other windows, a change here would save stale values (Ruling 140).
    const stopSettings = onSettingsChanged(() => {});
    loadSettings().then(
      () => {
        if (disposed) return;
        stopTheme = followTheme(withDefaultPalettes, { remember: false });
        ready = true;
      },
      (err) => (loadError = `Could not load settings: ${err}`),
    );
    const stopSection = listen<string>(SECTION_EVENT, ({ payload }) => {
      current = known(payload) ?? current;
    });
    return () => {
      disposed = true;
      stopSettings();
      stopTheme();
      stopSection.then((stop) => stop()).catch(() => {});
    };
  });

  // A custom palette may be unreadable; the window that fixes it must stay readable (Ruling 158).
  // Not remembered, so the main window still starts in its own palette.
  function withDefaultPalettes(): Settings {
    return { ...settings, palettes: structuredClone(DEFAULT_PALETTES) as Settings['palettes'] };
  }

  // Windows and Linux give this window no menu bar, so Close Tab's Ctrl+W is handled here.
  function onKeydown(e: KeyboardEvent) {
    if (isMac() || !e.ctrlKey || e.key.toLowerCase() !== 'w') return;
    e.preventDefault();
    void getCurrentWindow().destroy();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="settings-app">
  <nav aria-label="Settings sections">
    {#each sections as section (section.id)}
      <button
        type="button"
        aria-current={section.id === current ? 'page' : undefined}
        onclick={() => (current = section.id)}>{section.label}</button
      >
    {/each}
  </nav>
  <main>
    {#if loadError || saveError.message}
      <p class="error" role="alert">{loadError || saveError.message}</p>
    {/if}
    <fieldset disabled={!ready}>
      <legend class="visually-hidden">{sections.find((s) => s.id === current)?.label}</legend>
      <Section />
    </fieldset>
  </main>
</div>

<style>
  .settings-app {
    display: flex;
    height: 100%;
    background: var(--chrome);
    color: var(--text);
    font-size: 13px;
  }

  nav {
    flex: 0 0 180px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 14px 10px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    color-scheme: var(--scheme);
  }

  nav button {
    padding: 7px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted-strong);
    font: inherit;
    text-align: left;
  }

  nav button:hover {
    background: var(--hover);
  }

  nav button[aria-current='page'] {
    background: var(--inset);
    color: var(--text);
    font-weight: 600;
  }

  main {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    color-scheme: var(--scheme);
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: 22px;
    min-width: 0;
    margin: 0;
    padding: 22px 28px 28px;
    border: 0;
  }

  .error {
    margin: 16px 28px 0;
    color: var(--lint-warning);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Controls shared by every section. */
  .settings-app :global(.field) {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .settings-app :global(.field-label) {
    font-weight: 600;
  }

  .settings-app :global(.hint) {
    color: var(--muted);
    font-size: 12px;
  }

  .settings-app :global(.grid2) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }

  .settings-app :global(.choices) {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .settings-app :global(.choice) {
    height: 32px;
    padding: 0 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }

  /* One pixel less padding keeps the label still when the border thickens. */
  .settings-app :global(.choice[aria-pressed='true']) {
    padding: 0 13px;
    border: 2px solid var(--accent);
    font-weight: 600;
  }

  .settings-app :global(.choice:disabled) {
    color: var(--muted);
  }

  .settings-app :global(select),
  .settings-app :global(input[type='number']) {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }

  .settings-app :global(:is(button, select, input):focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
