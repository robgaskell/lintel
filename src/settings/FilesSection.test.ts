import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFakes } from '../test/fakes';
import { fireEvent, render } from '@testing-library/svelte';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import FilesSection from './FilesSection.svelte';

// The real updateSettings on in-memory fakes, watched, so nested patches merge as they do live.
vi.mock('@tauri-apps/plugin-store', () => import('../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../test/fakes').then((f) => f.eventModule));
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

function recentField() {
  const view = render(FilesSection);
  return { ...view, field: view.getByLabelText('Recent files to show') as HTMLInputElement };
}

describe('FilesSection: Recent files to show (Ruling 143)', () => {
  it('shows the current count as a 0–20 number field', () => {
    const { field } = recentField();

    expect(field.type).toBe('number');
    expect(field.value).toBe('5');
    expect([field.min, field.max]).toEqual(['0', '20']);
  });

  it('accepts 0 to 20, saved when the field loses focus', async () => {
    const { field } = recentField();

    for (const value of [0, 20, 12]) {
      await fireEvent.input(field, { target: { value: String(value) } });
      await settle();
      expect(updateSettings).not.toHaveBeenCalledWith({ recentLimit: value });
      await fireEvent.blur(field);
      await settle();
      expect(updateSettings).toHaveBeenLastCalledWith({ recentLimit: value });
    }
  });

  it('saves on Enter too', async () => {
    const { field } = recentField();

    await fireEvent.input(field, { target: { value: '0' } });

    await settle();
    await fireEvent.keyDown(field, { key: 'Enter' });
    await settle();

    expect(updateSettings).toHaveBeenCalledWith({ recentLimit: 0 });
  });

  it('rejects 21: it is saved as 20', async () => {
    const { field } = recentField();

    await fireEvent.input(field, { target: { value: '21' } });

    await settle();
    await fireEvent.blur(field);
    await settle();

    expect(updateSettings).toHaveBeenCalledWith({ recentLimit: 20 });
    expect(updateSettings).not.toHaveBeenCalledWith({ recentLimit: 21 });
    expect(field.value).toBe('20');
  });

  it('shows 20 again when 21 is typed while the count is already 20', async () => {
    settings.recentLimit = 20;
    const { field } = recentField();

    await fireEvent.input(field, { target: { value: '21' } });

    await settle();
    await fireEvent.blur(field);
    await settle();

    expect(field.value).toBe('20');
  });

  it('puts back the current count for an empty field, a negative or a fraction gets the nearest', async () => {
    const { field } = recentField();

    await fireEvent.input(field, { target: { value: '' } });

    await settle();
    await fireEvent.blur(field);
    await settle();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(field.value).toBe('5');

    await fireEvent.input(field, { target: { value: '-4' } });

    await settle();
    await fireEvent.blur(field);
    await settle();
    expect(updateSettings).toHaveBeenLastCalledWith({ recentLimit: 0 });

    await fireEvent.input(field, { target: { value: '7.6' } });

    await settle();
    await fireEvent.blur(field);
    await settle();
    expect(updateSettings).toHaveBeenLastCalledWith({ recentLimit: 8 });
  });

  it('follows a change made in another window', async () => {
    const { field } = recentField();

    settings.recentLimit = 9;
    await Promise.resolve();

    await vi.waitFor(() => expect(field.value).toBe('9'));
  });
});

describe('FilesSection: later actions', () => {
  it('shows Install command-line tool and Make Lintel the default, disabled until M5.2', () => {
    const { getByRole } = render(FilesSection);

    for (const name of ['Install command-line tool', 'Make Lintel the default']) {
      expect((getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
