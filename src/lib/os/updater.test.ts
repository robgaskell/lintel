import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { calls, eventModule, resetFakes } from '../../test/fakes';
import { runQuitRounds } from './quit';
import {
  checkForUpdates,
  followUpdates,
  followUpdatesInSettings,
  restartToUpdate,
  UPDATE_REQUEST,
  UPDATE_STATE,
  type UpdateState,
} from './updater';

// A listen resolves only once `listening.open` does, as Tauri's goes through the core.
const listening = vi.hoisted(() => ({ open: Promise.resolve() }));
vi.mock('@tauri-apps/api/event', async () => {
  const { eventModule } = await import('../../test/fakes');
  return {
    ...eventModule,
    listen: async (...args: Parameters<typeof eventModule.listen>) => {
      await listening.open;
      return eventModule.listen(...args);
    },
  };
});
const rust = vi.hoisted(() => ({ state: null as UpdateState | null }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'update_state') return rust.state;
    if (command === 'install_update') return undefined;
    throw new Error(`No fake for command ${command}`);
  }),
}));
const rounds = vi.hoisted(() => ({ outcome: 'proceed' as 'proceed' | 'cancelled' }));
vi.mock('./quit', () => ({
  runQuitRounds: vi.fn(async (_workspace: unknown, then: () => Promise<unknown>) => {
    if (rounds.outcome === 'proceed') await then();
    return rounds.outcome;
  }),
}));

function state(status: UpdateState['status'], revision: number, version: string | null = null): UpdateState {
  return { status, version, error: null, appVersion: '0.1.0', lastChecked: null, revision };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakes();
  listening.open = Promise.resolve();
  rust.state = state('none', 0);
  rounds.outcome = 'proceed';
  vi.mocked(invoke).mockClear();
  vi.mocked(runQuitRounds).mockClear();
});

describe('followUpdates (Ruling 343)', () => {
  it('shows a window opened after the download that the update is ready, by asking', async () => {
    rust.state = state('ready', 3, '0.1.1');
    const seen: UpdateState[] = [];

    followUpdates((s) => seen.push(s));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]).toMatchObject({ status: 'ready', version: '0.1.1' });
    expect(invoke).toHaveBeenCalledWith('update_state');
  });

  it('follows each change Rust sends, and drops an answer older than one already heard', async () => {
    let answer: (s: UpdateState) => void = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const seen: string[] = [];
    followUpdates((s) => seen.push(s.status));
    await settle();

    await eventModule.emit(UPDATE_STATE, state('downloading', 2, '0.1.1'));
    await settle();
    answer(state('checking', 1));
    await settle();
    await eventModule.emit(UPDATE_STATE, state('ready', 3, '0.1.1'));
    await settle();

    expect(seen).toEqual(['downloading', 'ready']);
  });

  it('asks only once it listens, so no change between the two is missed (Ruling 349)', async () => {
    let open = () => {};
    listening.open = new Promise<void>((resolve) => (open = resolve));
    const asked: unknown[] = [];
    await eventModule.listen(UPDATE_REQUEST, ({ payload }) => asked.push(payload));

    followUpdates(() => {});
    followUpdatesInSettings(() => {});
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(asked).toEqual([]);

    open();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('update_state'));
    await vi.waitFor(() => expect(asked).toEqual([{ action: 'state' }]));
  });

  it('hears nothing once stopped', async () => {
    const seen: UpdateState[] = [];
    const stop = followUpdates((s) => seen.push(s));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    stop();
    await settle();
    await eventModule.emit(UPDATE_STATE, state('ready', 5, '0.1.1'));
    await settle();

    expect(seen).toHaveLength(1);
  });

  it('in Settings, asks by event after listening, since Settings has no app commands', async () => {
    const seen: UpdateState[] = [];
    const asked: unknown[] = [];
    await eventModule.listen(UPDATE_REQUEST, ({ payload }) => {
      asked.push(payload);
      void eventModule.emit(UPDATE_STATE, state('ready', 4, '0.1.1'));
    });

    followUpdatesInSettings((s) => seen.push(s));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(asked).toEqual([{ action: 'state' }]);
    expect(calls.indexOf(`emit ${UPDATE_REQUEST}`)).toBeGreaterThan(-1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Check now asks Rust by event', async () => {
    const asked: unknown[] = [];
    await eventModule.listen(UPDATE_REQUEST, ({ payload }) => asked.push(payload));

    await checkForUpdates();
    await settle();

    expect(asked).toEqual([{ action: 'check' }]);
  });
});

describe('restartToUpdate (Ruling 343)', () => {
  it('installs only after every window has passed its quit prompts', async () => {
    await restartToUpdate();

    // As an update round, whose hung-window question offers Install Anyway.
    expect(runQuitRounds).toHaveBeenCalledWith(undefined, expect.any(Function), 'update');
    expect(invoke).toHaveBeenCalledWith('install_update');
  });

  it('leaves the update ready when a prompt is cancelled', async () => {
    rounds.outcome = 'cancelled';

    await restartToUpdate();

    expect(invoke).not.toHaveBeenCalledWith('install_update');
  });
});
