import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { claimPath, writeTextFile } from './ipc';

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

describe('writeTextFile', () => {
  // Ruling 357: Rust compares the disk with this hash before it writes.
  it('hands the expected hash to Rust as expectedHash', async () => {
    await writeTextFile('/notes/a.md', 'mine\n', 'h0');
    expect(invoke).toHaveBeenCalledWith('write_text_file', {
      path: '/notes/a.md',
      text: 'mine\n',
      expectedHash: 'h0',
    });
  });

  it('sends null when there is nothing to compare', async () => {
    await writeTextFile('/notes/a.md', 'mine\n');
    expect(invoke).toHaveBeenCalledWith('write_text_file', {
      path: '/notes/a.md',
      text: 'mine\n',
      expectedHash: null,
    });
  });
});
