import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventModule, resetFakes } from '../test/fakes';
import { fireEvent, render } from '@testing-library/svelte';
import { DEFAULT_SETTINGS, settings, updateSettings } from '../lib/settings/settings.svelte';
import { OS_ACTION, OS_ACTION_RESULT, type OsActionEvent, type OsActionResultEvent } from '../lib/ipc';
import { currentPlatform } from '../lib/os/platform';
import FilesSection from './FilesSection.svelte';

// The real updateSettings on in-memory fakes, watched, so nested patches merge as they do live.
vi.mock('@tauri-apps/plugin-store', () => import('../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/core', () => import('../test/fakes').then((f) => f.coreModule));
vi.mock('../lib/settings/settings.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/settings/settings.svelte')>();
  return { ...real, updateSettings: vi.fn(real.updateSettings) };
});
vi.mock('../lib/os/platform', () => ({ currentPlatform: vi.fn(() => 'macos') }));

// Saves go through the update queue; one macrotask lets them land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakes();
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  vi.mocked(updateSettings).mockClear();
  vi.mocked(currentPlatform).mockReturnValue('macos');
});

afterEach(() => {
  vi.useRealTimers();
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

type Answer = Omit<OsActionResultEvent, 'requestId'>;

// Stands in for Rust's os-action listener (Ruling 245); null leaves a request unanswered.
function rustAnswers(answer: (action: OsActionEvent['action']) => Answer | null) {
  const asked: OsActionEvent[] = [];
  void eventModule.listen(OS_ACTION, ({ payload }) => {
    const request = payload as OsActionEvent;
    asked.push(request);
    const reply = answer(request.action);
    if (reply) void eventModule.emit(OS_ACTION_RESULT, { requestId: request.requestId, ...reply });
  });
  return asked;
}

type View = { getByRole: (role: 'button', options: { name: string }) => HTMLElement };
const button = (view: View, name: string) => view.getByRole('button', { name }) as HTMLButtonElement;

describe('FilesSection: command-line tool and default app (M5.2)', () => {
  it('offers both actions, with no "later version" hint', () => {
    const view = render(FilesSection);

    for (const name of ['Install command-line tool', 'Make Lintel the default']) {
      expect(button(view, name).disabled).toBe(false);
    }
    expect(view.queryByText('These arrive in a later version.')).toBeNull();
  });

  it('Install command-line tool asks Rust by event and shows the path it reports', async () => {
    const installed = 'Installed the lintel command at /Users/me/.local/bin/lintel. Add ~/.local/bin to your PATH.';
    const asked = rustAnswers(() => ({ ok: true, message: installed }));
    const view = render(FilesSection);

    await fireEvent.click(button(view, 'Install command-line tool'));

    await vi.waitFor(() => expect(view.getByText(installed)).toBeTruthy());
    expect(asked).toEqual([{ action: 'install-cli', requestId: expect.any(String) }]);
    expect(view.getByText(installed).getAttribute('role')).toBe('status');
  });

  it('shows why an install was refused', async () => {
    const refused = 'A different `lintel` already exists at /Users/me/.local/bin/lintel, so it was not replaced.';
    rustAnswers(() => ({ ok: false, message: refused }));
    const view = render(FilesSection);

    await fireEvent.click(button(view, 'Install command-line tool'));

    await vi.waitFor(() => expect(view.getByText(refused).classList.contains('failed')).toBe(true));
  });

  it('keeps the button disabled until the answer arrives', async () => {
    let answer: Answer | null = null;
    const asked = rustAnswers(() => answer);
    const view = render(FilesSection);
    const install = button(view, 'Install command-line tool');

    await fireEvent.click(install);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(install.disabled).toBe(true);

    answer = { ok: true, message: 'Installed.' };
    await eventModule.emit(OS_ACTION_RESULT, { requestId: asked[0].requestId, ...answer });
    await vi.waitFor(() => expect(install.disabled).toBe(false));
    expect(view.getByText('Installed.')).toBeTruthy();
  });

  it('ignores an answer meant for another request', async () => {
    const asked = rustAnswers(() => null);
    const view = render(FilesSection);

    await fireEvent.click(button(view, 'Install command-line tool'));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await eventModule.emit(OS_ACTION_RESULT, { requestId: 'someone-else', ok: true, message: 'Not mine.' });
    await eventModule.emit(OS_ACTION_RESULT, { requestId: asked[0].requestId, ok: true, message: 'Mine.' });

    await vi.waitFor(() => expect(view.getByText('Mine.')).toBeTruthy());
    expect(view.queryByText('Not mine.')).toBeNull();
  });

  it('says Lintel did not answer after 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asked = rustAnswers(() => null);
    const view = render(FilesSection);

    await fireEvent.click(button(view, 'Install command-line tool'));
    // vi.waitFor would move the fake clock on, so time is moved by hand.
    await vi.advanceTimersByTimeAsync(1);
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_998);
    expect(view.queryByText('Lintel did not answer. Try again.')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(view.getByText('Lintel did not answer. Try again.')).toBeTruthy();
    expect(button(view, 'Install command-line tool').disabled).toBe(false);
  });

  it('Make Lintel the default asks Rust and says it is done', async () => {
    const asked = rustAnswers(() => ({ ok: true, message: '' }));
    const view = render(FilesSection);

    await fireEvent.click(button(view, 'Make Lintel the default'));

    await vi.waitFor(() => expect(view.getByText('Lintel is now the default for Markdown files.')).toBeTruthy());
    expect(asked).toEqual([{ action: 'make-default', requestId: expect.any(String) }]);
  });

  it('on Windows, says where to choose Lintel, since apps may not set the default', async () => {
    vi.mocked(currentPlatform).mockReturnValue('windows');
    rustAnswers(() => ({ ok: true, message: '' }));
    const view = render(FilesSection);

    await fireEvent.click(button(view, 'Make Lintel the default'));

    await vi.waitFor(() =>
      expect(view.getByText('In Default apps, choose Lintel for .md and .markdown files.')).toBeTruthy(),
    );
  });

  it('shows why Make Lintel the default failed', async () => {
    const failed = 'macOS could not make Lintel the default (error -50).';
    rustAnswers(() => ({ ok: false, message: failed }));
    const view = render(FilesSection);

    await fireEvent.click(button(view, 'Make Lintel the default'));

    await vi.waitFor(() => expect(view.getByText(failed).classList.contains('failed')).toBe(true));
    expect(view.queryByText('Lintel is now the default for Markdown files.')).toBeNull();
  });
});
