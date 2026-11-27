import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFakes } from '../test/fakes';
import { fireEvent, render, within } from '@testing-library/svelte';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import AppearanceSection from './AppearanceSection.svelte';

// The real updateSettings on in-memory fakes, watched, so nested patches merge as they do live.
vi.mock('@tauri-apps/plugin-store', () => import('../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/core', () => import('../test/fakes').then((f) => f.coreModule));
vi.mock('../lib/settings/settings.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/settings/settings.svelte')>();
  return { ...real, updateSettings: vi.fn(real.updateSettings) };
});

// Saves go through the update queue; one macrotask lets them land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakes();
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  vi.mocked(updateSettings).mockClear();
});

describe('AppearanceSection', () => {
  it('sets the theme from Light, Dark and Match system', async () => {
    const { getByRole } = render(AppearanceSection);
    const dark = getByRole('button', { name: 'Dark' });

    await fireEvent.click(dark);

    await settle();

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
      await settle();
      // Patched by key path, so no other colour is written (Ruling 159).
      expect(updateSettings).toHaveBeenLastCalledWith({
        palettes: { light: { accent: light }, dark: { accent: dark } },
      });
      expect(settings.palettes.light).toEqual({ ...DEFAULT_SETTINGS.palettes.light, accent: light });
      expect(settings.palettes.dark).toEqual({ ...DEFAULT_SETTINGS.palettes.dark, accent: dark });
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

    await settle();
    expect(custom.getAttribute('aria-expanded')).toBe('true');
    expect(getByRole('group', { name: 'Light palette' })).toBeTruthy();

    await fireEvent.click(custom);

    await settle();
    expect(queryByRole('group', { name: 'Light palette' })).toBeNull();
  });

  it('keeps the picked swatch ringed after Restore default colours (Ruling 162)', async () => {
    const { getByRole } = render(AppearanceSection);
    await fireEvent.click(getByRole('button', { name: 'Teal' }));
    await fireEvent.click(getByRole('button', { name: 'Custom…' }));
    await settle();

    for (const theme of ['Light', 'Dark']) {
      const group = getByRole('group', { name: `${theme} palette` });
      await fireEvent.click(within(group).getByRole('button', { name: 'Restore default colours' }));
      await settle();
      expect(getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('true');
    }
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

    await settle();
    expect(updateSettings).toHaveBeenLastCalledWith({ readingFont: 'Georgia, serif' });
    await fireEvent.change(editor, { target: { value: "'JetBrains Mono', monospace" } });
    await settle();
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

    await settle();
    expect(updateSettings).toHaveBeenLastCalledWith({ fontSize: 24 });
    await fireEvent.input(slider, { target: { value: '5' } });
    await settle();
    expect(updateSettings).toHaveBeenLastCalledWith({ fontSize: 12 });
    await fireEvent.input(slider, { target: { value: '18' } });
    await settle();
    expect(updateSettings).toHaveBeenLastCalledWith({ fontSize: 18 });
    expect(getByText('Text size: 18 px')).toBeTruthy();
  });

  it('clamps a size outside 12–24 itself, whatever the slider reports (Ruling 160)', async () => {
    const { getByLabelText } = render(AppearanceSection);
    const slider = getByLabelText(/Text size/) as HTMLInputElement;
    // jsdom clamps range values itself, which would hide a missing clamp here.
    let reported = '30';
    Object.defineProperty(slider, 'value', { configurable: true, get: () => reported, set: () => {} });

    await fireEvent.input(slider);

    await settle();
    expect(updateSettings).toHaveBeenLastCalledWith({ fontSize: 24 });
    reported = '3';
    await fireEvent.input(slider);
    await settle();
    expect(updateSettings).toHaveBeenLastCalledWith({ fontSize: 12 });
  });

  it("previews the user's palette, which this window does not wear (Ruling 158)", () => {
    settings.palettes.light = {
      background: '#101010',
      text: '#F0F0F0',
      accent: '#2563EB',
      link: '#FFCC00',
      codeBackground: '#202020',
    };
    const { getByText } = render(AppearanceSection);
    const preview = getByText('Release checklist').parentElement!;

    expect(preview.style.background).toBe('rgb(16, 16, 16)');
    expect(preview.style.color).toBe('rgb(240, 240, 240)');
    expect(getByText('build notes').style.color).toBe('rgb(255, 204, 0)');
    expect(getByText('pnpm build').style.background).toBe('rgb(32, 32, 32)');
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

    await settle();

    expect(updateSettings).toHaveBeenLastCalledWith({ remoteImages: 'block' });
    expect(getByRole('button', { name: 'Always block' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'Ask' }).getAttribute('aria-pressed')).toBe('false');
  });
});
