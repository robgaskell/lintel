<script lang="ts">
  import { settings, type Palette } from '../lib/settings/settings.svelte';
  import { contrastRatio, cssVariables, DEFAULT_PALETTES, type ResolvedTheme } from '../lib/theme/theme';
  import { save } from './save.svelte';

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

  function setColour(theme: ResolvedTheme, key: keyof Palette, value: string) {
    save({ palettes: { [theme]: { [key]: value.toUpperCase() } } });
  }

  // The accent is chosen with the swatches, so it is kept (Ruling 162).
  function restoreDefaults(theme: ResolvedTheme) {
    const { background, text, link, codeBackground } = DEFAULT_PALETTES[theme];
    save({ palettes: { [theme]: { background, text, link, codeBackground } } });
  }

  // Text is checked on the chrome too, since the tab strip and panels sit on it (Ruling 149),
  // and on the code background, where inline code and code blocks sit (Ruling 158).
  function lowContrast(theme: ResolvedTheme): Partial<Record<keyof Palette, boolean>> {
    const p = settings.palettes[theme];
    const chrome = cssVariables($state.snapshot(settings), theme)['--chrome'];
    const below = (a: string, b: string) => contrastRatio(a, b) < MIN_CONTRAST;
    return {
      text: below(p.text, p.background) || below(p.text, chrome),
      link: below(p.link, p.background),
      codeBackground: below(p.text, p.codeBackground),
    };
  }
</script>

<div class="palette-editor" id="palette-editor">
  {#each themes as theme (theme.id)}
    {@const low = lowContrast(theme.id)}
    {@const p = settings.palettes[theme.id]}
    <div class="palette" role="group" aria-labelledby="palette-{theme.id}">
      <span class="field-label" id="palette-{theme.id}">{theme.label} palette</span>
      <div class="sample" style:background={p.background} style:color={p.text} style:border-color={p.accent}>
        Text, a <span style:color={p.link}>link</span> and
        <code style:background={p.codeBackground}>code</code>
      </div>
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
      <button type="button" class="choice" onclick={() => restoreDefaults(theme.id)}
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

  .sample {
    padding: 6px 10px;
    border: 1px solid;
    border-radius: 6px;
  }

  .sample code {
    padding: 1px 4px;
    border-radius: 4px;
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
