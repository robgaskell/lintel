import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFakes } from '../test/fakes';
import { fireEvent, render, within } from '@testing-library/svelte';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import PaletteEditor from './PaletteEditor.svelte';

// The real updateSettings on in-memory fakes, watched, so nested patches merge as they do live.
vi.mock('@tauri-apps/plugin-store', () => import('../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/core', () => import('../test/fakes').then((f) => f.coreModule));
vi.mock('../lib/settings/settings.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/settings/settings.svelte')>();
  return { ...real, updateSettings: vi.fn(real.updateSettings) };
});

const WARNING = 'Low contrast: hard to read';

// Saves go through the update queue; one macrotask lets them land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakes();
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  vi.mocked(updateSettings).mockClear();
});

function palette(theme: 'Light' | 'Dark') {
  const { getByRole } = render(PaletteEditor);
  return within(getByRole('group', { name: `${theme} palette` }));
}

// The warning a colour field points at, or null.
function warningFor(group: ReturnType<typeof within>, label: string): string | null {
  const id = group.getByLabelText(label).getAttribute('aria-describedby');
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
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

  it("saves a picked colour by key path into its theme's palette only, in upper case", async () => {
    const light = palette('Light');

    await fireEvent.input(light.getByLabelText('Link'), { target: { value: '#1d4ed8' } });
    await settle();

    expect(updateSettings).toHaveBeenLastCalledWith({ palettes: { light: { link: '#1D4ED8' } } });
    expect(settings.palettes).toEqual({
      light: { ...DEFAULT_SETTINGS.palettes.light, link: '#1D4ED8' },
      dark: DEFAULT_SETTINGS.palettes.dark,
    });
  });

  it('keeps both of two colours picked in quick succession (Ruling 159)', async () => {
    const light = palette('Light');

    await fireEvent.input(light.getByLabelText('Text'), { target: { value: '#111111' } });
    await fireEvent.input(light.getByLabelText('Link'), { target: { value: '#1d4ed8' } });
    await settle();

    expect(settings.palettes.light).toMatchObject({ text: '#111111', link: '#1D4ED8' });
  });

  it('shows no warning for the default palettes', () => {
    const { queryByText } = render(PaletteEditor);

    expect(queryByText(WARNING)).toBeNull();
  });

  it('warns beside Text when text on the background is under 4.5:1 (Ruling 145)', async () => {
    const light = palette('Light');

    await fireEvent.input(light.getByLabelText('Text'), { target: { value: '#999999' } });
    await settle();

    expect(warningFor(light, 'Text')).toBe(WARNING);
  });

  it('warns beside Link when the link on the background is under 4.5:1', async () => {
    const dark = palette('Dark');

    await fireEvent.input(dark.getByLabelText('Link'), { target: { value: '#333333' } });
    await settle();

    expect(warningFor(dark, 'Link')).toBe(WARNING);
    expect(warningFor(dark, 'Text')).toBeNull();
  });

  it('warns when text passes on the background but not on the chrome around it (Ruling 149)', async () => {
    const light = palette('Light');

    // 4.54:1 on white, but under 4.5:1 on the slightly darker chrome.
    await fireEvent.input(light.getByLabelText('Text'), { target: { value: '#767676' } });
    await settle();

    expect(warningFor(light, 'Text')).toBe(WARNING);
  });

  it('warns beside Code background when text on it is under 4.5:1 (Ruling 158)', async () => {
    const light = palette('Light');

    await fireEvent.input(light.getByLabelText('Code background'), { target: { value: '#333333' } });
    await settle();

    expect(warningFor(light, 'Code background')).toBe(WARNING);
    expect(warningFor(light, 'Text')).toBeNull();
  });

  it('shows the edited colours in a sample, as this window does not wear them (Ruling 158)', async () => {
    const light = palette('Light');

    await fireEvent.input(light.getByLabelText('Background'), { target: { value: '#102030' } });
    await settle();

    expect(light.getByText(/^Text, a/).style.background).toBe('rgb(16, 32, 48)');
  });

  it('puts back the default colours of a theme but keeps its accent (Ruling 162)', async () => {
    await updateSettings({ palettes: { dark: { text: '#333333', accent: '#5EEAD4' } } });
    const dark = palette('Dark');
    expect(warningFor(dark, 'Text')).toBe(WARNING);

    await fireEvent.click(dark.getByRole('button', { name: 'Restore default colours' }));
    await settle();

    expect(settings.palettes.dark).toEqual({ ...DEFAULT_SETTINGS.palettes.dark, accent: '#5EEAD4' });
    expect(dark.queryByText(WARNING)).toBeNull();
  });
});
