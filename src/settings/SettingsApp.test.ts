import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { emit } from '@tauri-apps/api/event';
import { resetFakes } from '../test/fakes';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  settings,
  updateSettings,
  type Settings,
} from '../lib/settings/settings.svelte';
import { DEFAULT_PALETTES, followTheme } from '../lib/theme/theme';
import { isMac } from '../lib/os/platform';
import SettingsApp, { sections } from './SettingsApp.svelte';

const order = vi.hoisted(() => [] as string[]);
const load = vi.hoisted(() => ({ finish: (_err?: unknown) => {} }));

vi.mock('../lib/settings/settings.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/settings/settings.svelte')>();
  return {
    ...real,
    loadSettings: vi.fn(
      () =>
        new Promise<Settings>((resolve, reject) => {
          order.push('load');
          load.finish = (err) => {
            order.push(err ? 'load failed' : 'loaded');
            if (err) reject(err);
            else resolve(structuredClone(real.DEFAULT_SETTINGS) as Settings);
          };
        }),
    ),
    onSettingsChanged: vi.fn(() => {
      order.push('subscribe');
      return () => {};
    }),
    updateSettings: vi.fn(async () => {}),
  };
});
vi.mock('../lib/theme/theme', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/theme/theme')>()),
  followTheme: vi.fn(() => {
    order.push('theme');
    return () => {};
  }),
}));
vi.mock('@tauri-apps/api/event', () => import('../test/fakes').then((f) => f.eventModule));
const win = vi.hoisted(() => ({ destroy: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));
vi.mock('../lib/os/platform', () => ({ isMac: vi.fn(() => true) }));

beforeEach(() => {
  resetFakes();
  order.length = 0;
  vi.mocked(loadSettings).mockClear();
  vi.mocked(followTheme).mockClear();
  vi.mocked(onSettingsChanged).mockClear();
  win.destroy.mockClear();
  vi.mocked(isMac).mockReturnValue(true);
  history.replaceState(null, '', '/?view=settings');
});

afterEach(() => history.replaceState(null, '', '/'));

function controls(container: HTMLElement): boolean {
  return container.querySelector('fieldset')!.disabled;
}

describe('SettingsApp', () => {
  it('lists Appearance, Editor, Files and Lint, for later steps to extend', () => {
    expect(sections.map((s) => [s.id, s.label])).toEqual([
      ['appearance', 'Appearance'],
      ['editor', 'Editor'],
      ['files', 'Files'],
      ['lint', 'Lint'],
    ]);
  });

  it('loads settings, follows the theme and listens for changes before enabling controls (Ruling 140)', async () => {
    const { container } = render(SettingsApp);
    expect(controls(container)).toBe(true);

    load.finish();

    await vi.waitFor(() => expect(controls(container)).toBe(false));
    expect(order).toEqual(['subscribe', 'load', 'loaded', 'theme']);
  });

  it('wears the default palette, never the one being edited, and does not save it as the theme (Ruling 158)', async () => {
    render(SettingsApp);
    load.finish();
    await vi.waitFor(() => expect(followTheme).toHaveBeenCalled());
    const [getSettings, options] = vi.mocked(followTheme).mock.calls[0];

    settings.palettes.light.text = '#FFFFFF';
    settings.fontSize = 20;

    expect(getSettings().palettes).toEqual(DEFAULT_PALETTES);
    expect(getSettings().fontSize).toBe(20);
    expect(options).toEqual({ remember: false });
    Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  });

  it('shows a change that could not be saved in the window, since it has no dialogs (Ruling 160)', async () => {
    const { getByRole, findByRole } = render(SettingsApp);
    load.finish();
    await vi.waitFor(() => expect(getByRole('button', { name: 'Dark' })).toHaveProperty('disabled', false));
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error('Settings could not be loaded'));

    await fireEvent.click(getByRole('button', { name: 'Dark' }));

    expect((await findByRole('alert')).textContent).toContain('Settings could not be loaded');
  });

  it('keeps controls disabled and says why when settings cannot be loaded', async () => {
    const { container, findByRole } = render(SettingsApp);

    load.finish('disk full');

    expect((await findByRole('alert')).textContent).toContain('disk full');
    expect(controls(container)).toBe(true);
    expect(followTheme).not.toHaveBeenCalled();
  });

  it('opens on Appearance, and switches section from the sidebar', async () => {
    const { getByRole, queryByLabelText } = render(SettingsApp);
    expect(getByRole('button', { name: 'Appearance' }).getAttribute('aria-current')).toBe('page');
    expect(queryByLabelText('Reading font')).toBeTruthy();

    await fireEvent.click(getByRole('button', { name: 'Files' }));

    expect(getByRole('button', { name: 'Files' }).getAttribute('aria-current')).toBe('page');
    expect(getByRole('button', { name: 'Appearance' }).getAttribute('aria-current')).toBeNull();
    expect(queryByLabelText('Recent files to show')).toBeTruthy();
    expect(queryByLabelText('Reading font')).toBeNull();
  });

  it('opens on the section named in the query (Ruling 144)', () => {
    history.replaceState(null, '', '/?view=settings&section=files');
    const { queryByLabelText } = render(SettingsApp);

    expect(queryByLabelText('Recent files to show')).toBeTruthy();
  });

  it('ignores a section it does not have', () => {
    history.replaceState(null, '', '/?view=settings&section=updates');
    const { queryByLabelText } = render(SettingsApp);

    expect(queryByLabelText('Reading font')).toBeTruthy();
  });

  it('shows the section another window asks for once it is open (Ruling 144)', async () => {
    const { queryByLabelText } = render(SettingsApp);
    await Promise.resolve();

    await emit('lintel://settings-section', 'editor');

    await vi.waitFor(() => expect(queryByLabelText('Recent files to show')).toBeNull());
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-current="page"]')?.textContent).toBe('Editor'),
    );
  });

  it('closes on Ctrl+W on Windows and Linux, where it has no menu bar (Ruling 142)', async () => {
    vi.mocked(isMac).mockReturnValue(false);
    render(SettingsApp);

    await fireEvent.keyDown(window, { key: 'w', ctrlKey: true });

    expect(win.destroy).toHaveBeenCalledOnce();
  });

  it('leaves Cmd+W to the menu bar on macOS', async () => {
    render(SettingsApp);

    await fireEvent.keyDown(window, { key: 'w', metaKey: true });
    await fireEvent.keyDown(window, { key: 'w', ctrlKey: true });

    expect(win.destroy).not.toHaveBeenCalled();
  });
});
