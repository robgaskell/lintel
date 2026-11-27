import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import type { Workspace } from '../layout/workspace';
import { runQuitRounds } from './quit';

// Rust checks, downloads and installs; windows only show its state and ask (Ruling 343).
export const UPDATE_STATE = 'lintel://update-state';
/** Settings has no app commands, so it asks by event (Ruling 245). */
export const UPDATE_REQUEST = 'lintel://update-request';

// 'installing': from the install request until the relaunch; windows are locked meanwhile.
export type UpdateStatus = 'none' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** The update's version, once one is found. */
  version: string | null;
  error: string | null;
  appVersion: string;
  /** Milliseconds since 1970 when the last check ended. */
  lastChecked: number | null;
  /** Grows with each change, so an older answer never replaces a newer event. */
  revision: number;
}

export interface UpdateRequestEvent {
  action: 'state' | 'check';
}

/** Calls `onState` with the update state now and on every change. Returns a stop function. */
export function followUpdates(onState: (state: UpdateState) => void): () => void {
  return follow(onState, () => invoke<UpdateState>('update_state'));
}

/** As followUpdates, for the Settings window, which asks by event. */
export function followUpdatesInSettings(onState: (state: UpdateState) => void): () => void {
  return follow(onState, async () => {
    await emit(UPDATE_REQUEST, { action: 'state' } satisfies UpdateRequestEvent);
    return null;
  });
}

/** Settings > Updates' Check now. The result arrives as a state change. */
export async function checkForUpdates(): Promise<void> {
  await emit(UPDATE_REQUEST, { action: 'check' } satisfies UpdateRequestEvent);
}

/**
 * "Update ready: restart": the quit prompts run in every window first, then Rust installs
 * and relaunches. Cancel leaves the update ready.
 */
export async function restartToUpdate(
  workspace?: Pick<Workspace, 'docIdsInOrder' | 'activate'>,
): Promise<void> {
  await runQuitRounds(workspace, () => invoke('install_update'), 'update');
}

// Listens before asking, so a change between the two is not missed.
function follow(
  onState: (state: UpdateState) => void,
  ask: () => Promise<UpdateState | null>,
): () => void {
  let stopped = false;
  let newest = -1;
  const take = (state: UpdateState) => {
    if (stopped || state.revision <= newest) return;
    newest = state.revision;
    onState(state);
  };
  const stop = listen<UpdateState>(UPDATE_STATE, ({ payload }) => take(payload));
  stop
    .then(ask)
    .then((state) => state && take(state))
    .catch((err) => console.error('Could not read the update state:', err));
  return () => {
    stopped = true;
    void stop.then((unlisten) => unlisten()).catch(() => {});
  };
}
