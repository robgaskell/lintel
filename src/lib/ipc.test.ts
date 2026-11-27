import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { claimPath } from './ipc';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

beforeEach(() => vi.clearAllMocks());

describe('claimPath', () => {
  it('lets Rust reveal the doc in its owner by default', async () => {
    await claimPath('/notes/a.md');
    expect(invoke).toHaveBeenCalledWith('claim_path', { path: '/notes/a.md' });
  });

  it('asks Rust not to reveal it when told so (Ruling 322)', async () => {
    await claimPath('/notes/a.md', { reveal: false });
    expect(invoke).toHaveBeenCalledWith('claim_path', { path: '/notes/a.md', reveal: false });
  });
});
