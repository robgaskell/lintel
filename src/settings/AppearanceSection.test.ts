import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import AppearanceSection from './AppearanceSection.svelte';

vi.mock('../lib/settings/settings.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/settings/settings.svelte')>();
  return {
    ...real,
    updateSettings: vi.fn(async (patch: object) => void Object.assign(real.settings, patch)),
  };
});
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn() }));

beforeEach(() => {
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  vi.mocked(updateSettings).mockClear();
});

describe('AppearanceSection', () => {
  it('sets the theme from Light, Dark and Match system', async () => {
    const { getByRole } = render(AppearanceSection);
    const dark = getByRole('button', { name: 'Dark' });

    await fireEvent.click(dark);

    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
    expect(dark.getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'Match system' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('offers the five accent presets, with Blue picked by default', () => {
    const { getByRole } = render(AppearanceSection);
    const group = getByRole('group', { name: 'Accent colour' });
    const names = [...group.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'));

    expect(names).toEqual(['Blue', 'Teal', 'Violet', 'Orange', 'Pink']);
    expect(getByRole('button', { name: 'Blue' }).getAttribute('aria-pressed')).toBe('true');
  });

  it("sets both themes' accents from a swatch's light and dark values, and nothing else", async () => {
    const cases = [
      ['Blue', '#2563EB', '#8AB4FF'],
      ['Teal', '#0F766E', '#5EEAD4'],
      ['Violet', '#7C3AED', '#C4B5FD'],
      ['Orange', '#C2410C', '#FDBA74'],
      ['Pink', '#BE185D', '#F9A8D4'],
    ] as const;
    const { getByRole } = render(AppearanceSection);

    for (const [name, light, dark] of cases) {
      await fireEvent.click(getByRole('button', { name }));
      expect(updateSettings).toHaveBeenLastCalledWith({
        palettes: {
          light: { ...DEFAULT_SETTINGS.palettes.light, accent: light },
          dark: { ...DEFAULT_SETTINGS.palettes.dark, accent: dark },
        },
      });
      expect(getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('shows a picked accent as chosen whatever the case of its hex', () => {
    settings.palettes.light.accent = '#0f766e';
    settings.palettes.dark.accent = '#5eead4';
    const { getByRole } = render(AppearanceSection);

    expect(getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens and closes the palette editor from Custom…', async () => {
    const { getByRole, queryByRole } = render(AppearanceSection);
    const custom = getByRole('button', { name: 'Custom…' });

    await fireEvent.click(custom);
    expect(custom.getAttribute('aria-expanded')).toBe('true');
    expect(getByRole('group', { name: 'Light palette' })).toBeTruthy();

    await fireEvent.click(custom);
    expect(queryByRole('group', { name: 'Light palette' })).toBeNull();
  });

  it('offers the fixed reading and editor font stacks, System first', async () => {
    const { getByLabelText } = render(AppearanceSection);
    const reading = getByLabelText('Reading font') as HTMLSelectElement;
    const editor = getByLabelText('Editor font') as HTMLSelectElement;

    expect([...reading.options].map((o) => [o.text, o.value])).toEqual([
      ['System', ''],
      ['Georgia', 'Georgia, serif'],
      ['Charter', "Charter, 'Bitstream Charter', serif"],
      ['Iowan Old Style', "'Iowan Old Style', Palatino, serif"],
    ]);
    expect([...editor.options].map((o) => [o.text, o.value])).toEqual([
      ['System mono', ''],
      ['Menlo', 'Menlo, Consolas, monospace'],
      ['JetBrains Mono', "'JetBrains Mono', monospace"],
      ['Cascadia Code', "'Cascadia Code', monospace"],
    ]);

    await fireEvent.change(reading, { target: { value: 'Georgia, serif' } });
    expect(updateSettings).toHaveBeenLastCalledWith({ readingFont: 'Georgia, serif' });
    await fireEvent.change(editor, { target: { value: "'JetBrains Mono', monospace" } });
    expect(updateSettings).toHaveBeenLastCalledWith({ editorFont: "'JetBrains Mono', monospace" });
  });

  it('keeps a stored font that is not in the list selected', () => {
    settings.readingFont = '"Source Serif", serif';
    const { getByLabelText } = render(AppearanceSection);

    expect((getByLabelText('Reading font') as HTMLSelectElement).value).toBe('"Source Serif", serif');
  });

  it('clamps the text size slider to 12–24', async () => {
    const { getByLabelText, getByText } = render(AppearanceSection);
    const slider = getByLabelText(/Text size/) as HTMLInputElement;
    expect([slider.min, slider.max, slider.step]).toEqual(['12', '24', '1']);

    await fireEvent.input(slider, { target: { value: '30' } });
    expect(updateSettings).toHaveBeenLastCalledWith({ fontSize: 24 });
    await fireEvent.input(slider, { target: { value: '5' } });
    expect(updateSettings).toHaveBeenLastCalledWith({ fontSize: 12 });
    await fireEvent.input(slider, { target: { value: '18' } });
    expect(updateSettings).toHaveBeenLastCalledWith({ fontSize: 18 });
    expect(getByText('Text size: 18 px')).toBeTruthy();
  });

  it('sets remote images to Ask, Always load or Always block (Ruling 146)', async () => {
    const { getByRole } = render(AppearanceSection);
    const group = getByRole('group', { name: 'Remote images' });
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Ask',
      'Always load',
      'Always block',
    ]);

    await fireEvent.click(getByRole('button', { name: 'Always block' }));

    expect(updateSettings).toHaveBeenLastCalledWith({ remoteImages: 'block' });
    expect(getByRole('button', { name: 'Always block' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'Ask' }).getAttribute('aria-pressed')).toBe('false');
  });
});
