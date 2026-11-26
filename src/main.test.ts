import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';

vi.mock('svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('svelte')>()),
  mount: vi.fn(() => ({})),
}));
vi.mock('./App.svelte', () => ({ default: 'App' }));
vi.mock('./settings/SettingsApp.svelte', () => ({ default: 'SettingsApp' }));
vi.mock('./lib/theme/theme', () => ({ restoreTheme: vi.fn() }));

async function start(search: string) {
  history.replaceState(null, '', `/${search}`);
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  vi.mocked(mount).mockClear();
  await import('./main');
  return vi.mocked(mount).mock.calls[0][0] as unknown;
}

afterEach(() => history.replaceState(null, '', '/'));

describe('main', () => {
  it('mounts the editor app by default', async () => {
    expect(await start('')).toBe('App');
  });

  it('mounts Settings in the window opened with ?view=settings', async () => {
    expect(await start('?view=settings&section=files')).toBe('SettingsApp');
  });
});
