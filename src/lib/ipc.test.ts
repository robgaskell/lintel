import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { readFileSync } from 'node:fs';
import { claimPath, FILE_CHANGED, FILE_REMOVED, WATCH_FAILED, writeTextFile } from './ipc';

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

// Ruling 359: a renamed event on either side would leave the window deaf to it.
describe('event names', () => {
  it('match the names Rust sends from watch.rs', () => {
    const rust = readFileSync('src-tauri/src/watch.rs', 'utf8');
    for (const [name, value] of Object.entries({ FILE_CHANGED, FILE_REMOVED, WATCH_FAILED })) {
      expect(rust).toContain(`pub const ${name}: &str = "${value}";`);
    }
  });
});
