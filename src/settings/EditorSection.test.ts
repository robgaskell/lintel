import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import EditorSection from './EditorSection.svelte';

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

describe('EditorSection', () => {
  it('sets the mode new tabs open in, Split by default', async () => {
    const { getByRole } = render(EditorSection);
    const group = getByRole('group', { name: 'Default mode for new tabs' });
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Edit', 'Split', 'Read']);
    expect(getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(getByRole('button', { name: 'Read' }));

    expect(updateSettings).toHaveBeenCalledWith({ defaultMode: 'read' });
    expect(getByRole('button', { name: 'Read' }).getAttribute('aria-pressed')).toBe('true');
  });
});
