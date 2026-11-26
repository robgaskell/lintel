<script lang="ts">
  import { settings, updateSettings, type Palette } from '../lib/settings/settings.svelte';
  import { contrastRatio, cssVariables, DEFAULT_PALETTES, type ResolvedTheme } from '../lib/theme/theme';
  import { showError } from './showError';

  const MIN_CONTRAST = 4.5;

  const themes: { id: ResolvedTheme; label: string }[] = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];
  const colours: { key: keyof Palette; label: string }[] = [
    { key: 'background', label: 'Background' },
    { key: 'text', label: 'Text' },
    { key: 'accent', label: 'Accent' },
    { key: 'link', label: 'Link' },
    { key: 'codeBackground', label: 'Code background' },
  ];

  function save(theme: ResolvedTheme, palette: Palette) {
    const palettes = { ...$state.snapshot(settings.palettes), [theme]: palette };
    updateSettings({ palettes }).catch(showError);
  }

  function setColour(theme: ResolvedTheme, key: keyof Palette, value: string) {
    save(theme, { ...$state.snapshot(settings.palettes[theme]), [key]: value.toUpperCase() });
  }

  // Text is checked on the chrome too, since the tab strip and panels sit on it (Ruling 149).
  function lowContrast(theme: ResolvedTheme): Partial<Record<keyof Palette, boolean>> {
    const p = settings.palettes[theme];
    const chrome = cssVariables($state.snapshot(settings), theme)['--chrome'];
    return {
      text: Math.min(contrastRatio(p.text, p.background), contrastRatio(p.text, chrome)) < MIN_CONTRAST,
      link: contrastRatio(p.link, p.background) < MIN_CONTRAST,
    };
  }
</script>

<div class="palette-editor" id="palette-editor">
  {#each themes as theme (theme.id)}
    {@const low = lowContrast(theme.id)}
    <div class="palette" role="group" aria-labelledby="palette-{theme.id}">
      <span class="field-label" id="palette-{theme.id}">{theme.label} palette</span>
      {#each colours as colour (colour.key)}
        {@const id = `colour-${theme.id}-${colour.key}`}
        {@const warning = `${id}-warning`}
        <div class="colour">
          <input
            {id}
            type="color"
            value={settings.palettes[theme.id][colour.key].toLowerCase()}
            aria-describedby={low[colour.key] ? warning : undefined}
            oninput={(e) => setColour(theme.id, colour.key, e.currentTarget.value)}
          />
          <label for={id}>{colour.label}</label>
          {#if low[colour.key]}
            <span class="warning" id={warning}>Low contrast: hard to read</span>
          {/if}
        </div>
      {/each}
      <button type="button" class="choice" onclick={() => save(theme.id, { ...DEFAULT_PALETTES[theme.id] })}
        >Restore default colours</button
      >
    </div>
  {/each}
</div>

<style>
  .palette-editor {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .palette {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .colour {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
  }

  input[type='color'] {
    width: 36px;
    height: 26px;
    padding: 0 2px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
  }

  .warning {
    flex-basis: 100%;
    padding-left: 46px;
    color: var(--lint-warning);
    font-size: 12px;
  }
</style>
