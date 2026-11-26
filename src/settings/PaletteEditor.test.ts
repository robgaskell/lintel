import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/svelte';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import PaletteEditor from './PaletteEditor.svelte';

vi.mock('../lib/settings/settings.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/settings/settings.svelte')>();
  return {
    ...real,
    updateSettings: vi.fn(async (patch: object) => void Object.assign(real.settings, patch)),
  };
});
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));

const WARNING = 'Low contrast: hard to read';

beforeEach(() => {
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  vi.mocked(updateSettings).mockClear();
});

function palette(theme: 'Light' | 'Dark') {
  const { getByRole } = render(PaletteEditor);
  return within(getByRole('group', { name: `${theme} palette` }));
}

describe('PaletteEditor', () => {
  it('edits all five colours of each theme', () => {
    const { getByRole } = render(PaletteEditor);
    for (const theme of ['Light', 'Dark'] as const) {
      const group = within(getByRole('group', { name: `${theme} palette` }));
      for (const name of ['Background', 'Text', 'Accent', 'Link', 'Code background']) {
        expect((group.getByLabelText(name) as HTMLInputElement).type).toBe('color');
      }
    }
  });

  it("saves a picked colour into its theme's palette only, in upper case", async () => {
    const light = palette('Light');

    await fireEvent.input(light.getByLabelText('Link'), { target: { value: '#1d4ed8' } });

    expect(updateSettings).toHaveBeenLastCalledWith({
      palettes: {
        light: { ...DEFAULT_SETTINGS.palettes.light, link: '#1D4ED8' },
        dark: DEFAULT_SETTINGS.palettes.dark,
      },
    });
  });

  it('shows no warning for the default palettes', () => {
    const { queryByText } = render(PaletteEditor);

    expect(queryByText(WARNING)).toBeNull();
  });

  it('warns when text on the background is under 4.5:1 (Ruling 145)', async () => {
    const light = palette('Light');

    await fireEvent.input(light.getByLabelText('Text'), { target: { value: '#999999' } });

    expect(light.getByText(WARNING)).toBeTruthy();
    expect(light.getByLabelText('Text').getAttribute('aria-describedby')).toBe(
      light.getByText(WARNING).id,
    );
  });

  it('warns when the link on the background is under 4.5:1', async () => {
    const dark = palette('Dark');

    await fireEvent.input(dark.getByLabelText('Link'), { target: { value: '#333333' } });

    expect(dark.getByText(WARNING)).toBeTruthy();
    expect(dark.getByLabelText('Link').getAttribute('aria-describedby')).toBeTruthy();
  });

  it('warns when text passes on the background but not on the chrome around it (Ruling 149)', async () => {
    const light = palette('Light');

    // 4.54:1 on white, but under 4.5:1 on the slightly darker chrome.
    await fireEvent.input(light.getByLabelText('Text'), { target: { value: '#767676' } });

    expect(light.getByText(WARNING)).toBeTruthy();
  });

  it('puts a theme back to its default colours', async () => {
    settings.palettes.dark.text = '#333333';
    const dark = palette('Dark');
    expect(dark.getByText(WARNING)).toBeTruthy();

    await fireEvent.click(dark.getByRole('button', { name: 'Restore default colours' }));

    expect(updateSettings).toHaveBeenLastCalledWith({
      palettes: { light: DEFAULT_SETTINGS.palettes.light, dark: DEFAULT_SETTINGS.palettes.dark },
    });
    expect(dark.queryByText(WARNING)).toBeNull();
  });
});
