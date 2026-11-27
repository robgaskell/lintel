import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/svelte';
import { fakeStore, resetFakes } from '../test/fakes';
import { LINT_RULES } from '../lib/lint/rules';
import { loadSettings, settings, updateSettings } from '../lib/settings/settings.svelte';
import { saveError } from './save.svelte';
import LintSection from './LintSection.svelte';

// The real updateSettings on in-memory fakes, watched, so rule writes merge as they do live.
vi.mock('@tauri-apps/plugin-store', () => import('../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/core', () => import('../test/fakes').then((f) => f.coreModule));
vi.mock('../lib/settings/settings.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/settings/settings.svelte')>();
  return { ...real, updateSettings: vi.fn(real.updateSettings) };
});

const store = () => fakeStore('settings.json');

beforeEach(async () => {
  resetFakes();
  await loadSettings();
  vi.mocked(updateSettings).mockClear();
  saveError.message = '';
});

describe('LintSection', () => {
  it('says that a .markdownlint file in a folder overrides these rules (Ruling 287)', () => {
    const { getByText } = render(LintSection);

    expect(getByText("Documents in a folder with a .markdownlint file use that file's rules instead.")).toBeTruthy();
  });

  it('turns linting off and on', async () => {
    const { getByRole } = render(LintSection);
    const toggle = getByRole('switch', { name: 'Lint documents with markdownlint' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    await fireEvent.click(toggle);

    await vi.waitFor(() => expect(settings.lint.enabled).toBe(false));
    expect(updateSettings).toHaveBeenCalledWith({ lint: { enabled: false } });
    expect(toggle.checked).toBe(false);
  });

  it("lists every rule with its name and markdownlint's description", () => {
    const { getByRole } = render(LintSection);
    const list = getByRole('list', { name: 'Rules' });
    const rows = within(list).getAllByRole('listitem');

    expect(rows).toHaveLength(LINT_RULES.length);
    expect(LINT_RULES.length).toBe(53);
    const md004 = within(list).getByRole('switch', { name: 'MD004 ul-style' });
    expect(md004.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(md004.getAttribute('aria-describedby')!)!.textContent).toBe('Unordered list style');
  });

  it('turns one rule off under its alias, removing its ID key (Ruling 270)', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: true, rules: { default: true, MD004: true } });
    await loadSettings();
    const { getByRole } = render(LintSection);
    const md004 = getByRole('switch', { name: 'MD004 ul-style' }) as HTMLInputElement;
    expect(md004.checked).toBe(true);

    await fireEvent.click(md004);

    await vi.waitFor(() =>
      expect(store().data.get('lint')).toEqual({ enabled: true, rules: { default: true, 'ul-style': false } }),
    );
    expect(md004.checked).toBe(false);
  });

  it('shows a rule that settings name by ID as off', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: true, rules: { default: true, MD013: false } });
    await loadSettings();

    const { getByRole } = render(LintSection);

    expect((getByRole('switch', { name: 'MD013 line-length' }) as HTMLInputElement).checked).toBe(false);
    expect((getByRole('switch', { name: 'MD004 ul-style' }) as HTMLInputElement).checked).toBe(true);
  });

  it('says so when a rule change could not be saved', async () => {
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error('disk full'));
    const { getByRole } = render(LintSection);

    await fireEvent.click(getByRole('switch', { name: 'MD004 ul-style' }));

    await vi.waitFor(() => expect(saveError.message).toBe('Could not save: disk full'));
  });
});
