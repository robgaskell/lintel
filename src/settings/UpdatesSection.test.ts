import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import { resetFakes } from '../test/fakes';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import { checkForUpdates, type UpdateState } from '../lib/os/updater';
import UpdatesSection from './UpdatesSection.svelte';

vi.mock('@tauri-apps/plugin-store', () => import('../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/core', () => import('../test/fakes').then((f) => f.coreModule));
vi.mock('../lib/settings/settings.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/settings/settings.svelte')>();
  return { ...real, updateSettings: vi.fn(real.updateSettings) };
});
// Rust's update service, as Settings hears it.
const rust = vi.hoisted(() => ({ send: (_state: UpdateState) => {} }));
vi.mock('../lib/os/updater', () => ({
  followUpdatesInSettings: vi.fn((onState: (state: UpdateState) => void) => {
    rust.send = onState;
    return () => {};
  }),
  checkForUpdates: vi.fn(async () => {}),
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function send(state: Partial<UpdateState>) {
  rust.send({
    status: 'none',
    version: null,
    error: null,
    appVersion: '0.1.0',
    lastChecked: null,
    revision: 1,
    ...state,
  });
  flushSync();
}

const result = (container: HTMLElement) => container.querySelector('#update-result')?.textContent;

beforeEach(() => {
  resetFakes();
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  vi.mocked(updateSettings).mockClear();
  vi.mocked(checkForUpdates).mockClear();
});

describe('UpdatesSection (Ruling 343)', () => {
  it('shows the running version from Rust', () => {
    const { getByText } = render(UpdatesSection);

    send({});

    expect(getByText('Lintel 0.1.0')).toBeTruthy();
  });

  it('saves the auto-check switch', async () => {
    const { getByRole } = render(UpdatesSection);
    const toggle = getByRole('switch', { name: 'Check for updates automatically' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await fireEvent.click(toggle);
    await settle();

    expect(updateSettings).toHaveBeenLastCalledWith({ updates: { autoCheck: false } });
  });

  it('Check now asks Rust, and is off while a check runs', async () => {
    const { getByRole } = render(UpdatesSection);
    const button = getByRole('button', { name: 'Check now' }) as HTMLButtonElement;

    await fireEvent.click(button);
    expect(checkForUpdates).toHaveBeenCalledOnce();

    send({ status: 'checking' });
    expect(button.disabled).toBe(true);
    send({ status: 'none', lastChecked: 0, revision: 2 });
    expect(button.disabled).toBe(false);
  });

  it('shows the last result', () => {
    const { container } = render(UpdatesSection);

    send({});
    expect(result(container)).toBe('Not checked yet.');
    send({ lastChecked: 0 });
    expect(result(container)).toMatch(/^Lintel is up to date\. Last checked /);
    send({ status: 'downloading', version: '0.1.1' });
    expect(result(container)).toBe('Downloading Lintel 0.1.1…');
    send({ status: 'ready', version: '0.1.1' });
    expect(result(container)).toContain('Lintel 0.1.1 is ready.');
    send({ status: 'installing', version: '0.1.1' });
    expect(result(container)).toBe('Installing Lintel 0.1.1…');
    send({ status: 'error', error: 'Could not download the update: offline' });
    expect(result(container)).toBe('Could not download the update: offline');
  });

  it('Check now with an update ready says so, and asks Rust nothing (Ruling 349)', async () => {
    const { container, getByRole } = render(UpdatesSection);
    send({ status: 'ready', version: '0.1.1' });

    await fireEvent.click(getByRole('button', { name: 'Check now' }));

    expect(result(container)).toBe('An update is ready. Restart to install it.');
    expect(checkForUpdates).not.toHaveBeenCalled();
    send({ status: 'ready', version: '0.1.1', revision: 2 });
    expect(result(container)).toContain('Lintel 0.1.1 is ready.');
  });
});
