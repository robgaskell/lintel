<script module lang="ts">
  export const ACCENTS = [
    { name: 'Blue', light: '#2563EB', dark: '#8AB4FF' },
    { name: 'Teal', light: '#0F766E', dark: '#5EEAD4' },
    { name: 'Violet', light: '#7C3AED', dark: '#C4B5FD' },
    { name: 'Orange', light: '#C2410C', dark: '#FDBA74' },
    { name: 'Pink', light: '#BE185D', dark: '#F9A8D4' },
  ] as const;

  export const READING_FONTS = [
    { label: 'System', value: '' },
    { label: 'Georgia', value: 'Georgia, serif' },
    { label: 'Charter', value: "Charter, 'Bitstream Charter', serif" },
    { label: 'Iowan Old Style', value: "'Iowan Old Style', Palatino, serif" },
  ];

  export const EDITOR_FONTS = [
    { label: 'System mono', value: '' },
    { label: 'Menlo', value: 'Menlo, Consolas, monospace' },
    { label: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
    { label: 'Cascadia Code', value: "'Cascadia Code', monospace" },
  ];
</script>

<script lang="ts">
  import {
    settings,
    type RemoteImagesChoice,
    type SettingsPatch,
    type ThemeChoice,
  } from '../lib/settings/settings.svelte';
  import { resolvedTheme } from '../lib/theme/theme';
  import PaletteEditor from './PaletteEditor.svelte';
  import { save } from './save.svelte';

  const MIN_SIZE = 12;
  const MAX_SIZE = 24;

  const themes: { id: ThemeChoice; label: string }[] = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'Match system' },
  ];
  const remoteChoices: { id: RemoteImagesChoice; label: string }[] = [
    { id: 'ask', label: 'Ask' },
    { id: 'load', label: 'Always load' },
    { id: 'block', label: 'Always block' },
  ];

  let customOpen = $state(false);

  function update(patch: SettingsPatch) {
    save(patch);
  }

  // This window always wears the default palette (Ruling 158), so the preview shows the real one.
  const palette = $derived(settings.palettes[$resolvedTheme]);

  // A colour picker gives lower-case hex; the presets are upper-case.
  function isPicked(accent: (typeof ACCENTS)[number]): boolean {
    const { light, dark } = settings.palettes;
    return (
      light.accent.toUpperCase() === accent.light && dark.accent.toUpperCase() === accent.dark
    );
  }

  function pickAccent(accent: (typeof ACCENTS)[number]) {
    update({ palettes: { light: { accent: accent.light }, dark: { accent: accent.dark } } });
  }

  function setSize(value: string) {
    const size = Math.round(Number(value));
    if (!Number.isFinite(size)) return;
    update({ fontSize: Math.min(MAX_SIZE, Math.max(MIN_SIZE, size)) });
  }

  // A hand-edited font outside the list still shows, rather than a blank select.
  function withCurrent(fonts: { label: string; value: string }[], current: string) {
    return fonts.some((f) => f.value === current) ? fonts : [...fonts, { label: current, value: current }];
  }
</script>

<div class="field">
  <span class="field-label" id="theme-label">Theme</span>
  <div class="choices" role="group" aria-labelledby="theme-label">
    {#each themes as theme (theme.id)}
      <button
        type="button"
        class="choice"
        aria-pressed={settings.theme === theme.id}
        onclick={() => update({ theme: theme.id })}>{theme.label}</button
      >
    {/each}
  </div>
</div>

<div class="field">
  <span class="field-label" id="accent-label">Accent colour</span>
  <div class="choices accents" role="group" aria-labelledby="accent-label">
    {#each ACCENTS as accent (accent.name)}
      <button
        type="button"
        class="swatch"
        aria-label={accent.name}
        title={accent.name}
        aria-pressed={isPicked(accent)}
        style:--swatch={accent.light}
        style:--swatch-dark={accent.dark}
        onclick={() => pickAccent(accent)}
      ></button>
    {/each}
    <button
      type="button"
      class="choice"
      aria-expanded={customOpen}
      aria-controls="palette-editor"
      onclick={() => (customOpen = !customOpen)}>Custom…</button
    >
  </div>
  {#if customOpen}
    <PaletteEditor />
  {/if}
</div>

<div class="grid2">
  <label class="field">
    <span class="field-label">Reading font</span>
    <select
      value={settings.readingFont}
      onchange={(e) => update({ readingFont: e.currentTarget.value })}
    >
      {#each withCurrent(READING_FONTS, settings.readingFont) as font (font.value)}
        <option value={font.value}>{font.label}</option>
      {/each}
    </select>
  </label>
  <label class="field">
    <span class="field-label">Editor font</span>
    <select
      value={settings.editorFont}
      onchange={(e) => update({ editorFont: e.currentTarget.value })}
    >
      {#each withCurrent(EDITOR_FONTS, settings.editorFont) as font (font.value)}
        <option value={font.value}>{font.label}</option>
      {/each}
    </select>
  </label>
</div>

<label class="field">
  <span class="field-label">Text size: {settings.fontSize} px</span>
  <input
    class="size"
    type="range"
    min={MIN_SIZE}
    max={MAX_SIZE}
    step="1"
    value={settings.fontSize}
    oninput={(e) => setSize(e.currentTarget.value)}
  />
</label>

<div class="field">
  <span class="field-label" id="preview-label">Preview</span>
  <div
    class="preview"
    aria-labelledby="preview-label"
    style:background={palette.background}
    style:color={palette.text}
  >
    <div class="preview-title">Release checklist</div>
    <div>
      Steps Claude prepared for <strong>v0.4</strong>. See the
      <span class="preview-link" style:color={palette.link}>build notes</span> and run
      <code style:background={palette.codeBackground}>pnpm build</code>.
    </div>
  </div>
</div>

<div class="field">
  <span class="field-label" id="remote-label">Remote images</span>
  <div class="choices" role="group" aria-labelledby="remote-label">
    {#each remoteChoices as choice (choice.id)}
      <button
        type="button"
        class="choice"
        aria-pressed={settings.remoteImages === choice.id}
        onclick={() => update({ remoteImages: choice.id })}>{choice.label}</button
      >
    {/each}
  </div>
</div>

<style>
  .accents {
    align-items: center;
    gap: 10px;
  }

  .swatch {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--swatch);
  }

  :global(:root[data-theme='dark']) .swatch {
    background: var(--swatch-dark);
  }

  .swatch[aria-pressed='true'] {
    border: 2px solid var(--bg);
    box-shadow: 0 0 0 2px var(--swatch);
  }

  :global(:root[data-theme='dark']) .swatch[aria-pressed='true'] {
    box-shadow: 0 0 0 2px var(--swatch-dark);
  }

  .size {
    max-width: 360px;
    accent-color: var(--accent);
  }

  .preview {
    padding: 16px 18px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: var(--font-read);
    font-size: var(--size-read);
    line-height: 1.6;
  }

  .preview-title {
    margin-bottom: 6px;
    font-size: 1.4em;
    font-weight: 700;
  }

  .preview-link {
    text-decoration: underline;
  }

  .preview code {
    padding: 1px 4px;
    border-radius: 4px;
    font-family: var(--font-edit);
    font-size: 0.9em;
  }
</style>
