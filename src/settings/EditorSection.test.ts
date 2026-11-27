import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFakes } from '../test/fakes';
import { fireEvent, render } from '@testing-library/svelte';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import EditorSection from './EditorSection.svelte';

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

describe('EditorSection', () => {
  it('sets the mode new tabs open in, Split by default', async () => {
    const { getByRole } = render(EditorSection);
    const group = getByRole('group', { name: 'Default mode for new tabs' });
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Edit', 'Split', 'Read']);
    expect(getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(getByRole('button', { name: 'Read' }));

    await settle();

    expect(updateSettings).toHaveBeenCalledWith({ defaultMode: 'read' });
    expect(getByRole('button', { name: 'Read' }).getAttribute('aria-pressed')).toBe('true');
  });
});
