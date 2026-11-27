import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathsExist } from '../ipc';
import { fakeStore, loads, resetFakes } from '../../test/fakes';
import {
  clearRecent,
  getRecent,
  knownRecent,
  onRecentChanged,
  recentMayHaveChanged,
  recordRecent,
} from './recent';

vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule));
vi.mock('../ipc', () => ({
  pathsExist: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => 1),
  completeHandoff: vi.fn(async () => true),
  cancelHandoff: vi.fn(async () => true),
}));

const exists = vi.mocked(pathsExist);
const store = () => fakeStore('recent.json');
const stored = () => store().data.get('paths');

beforeEach(() => {
  resetFakes();
  exists.mockReset();
  exists.mockImplementation(async (paths) => paths.map(() => true));
});

describe('recordRecent', () => {
  it('moves a path recorded again to the top, with no duplicates', async () => {
    await recordRecent('/a.md');
    await recordRecent('/b.md');
    await recordRecent('/a.md');

    expect(await getRecent(20)).toEqual(['/a.md', '/b.md']);
    expect(store().data.get('version')).toBe(1);
  });

  it('saves recent.json after each change, with autoSave off', async () => {
    await recordRecent('/a.md');
    expect(store().saves).toBe(1);
    await clearRecent();
    expect(store().saves).toBe(2);
    expect(loads).toContainEqual({ path: 'recent.json', options: { autoSave: false } });
  });

  it('never rejects, even when a listener throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = onRecentChanged(() => {
      throw new Error('listener broke');
    });

    await expect(recordRecent('/a.md')).resolves.toBeUndefined();

    stop();
    error.mockRestore();
  });

  it('keeps the newest 20 of 25', async () => {
    for (let i = 1; i <= 25; i++) await recordRecent(`/${i}.md`);

    const paths = stored() as string[];
    expect(paths).toHaveLength(20);
    expect(paths[0]).toBe('/25.md');
    expect(paths.at(-1)).toBe('/6.md');
  });

  it('keeps both of two records made at once', async () => {
    await Promise.all([recordRecent('/a.md'), recordRecent('/b.md')]);

    expect(stored()).toEqual(['/b.md', '/a.md']);
  });

  it('logs a store failure instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store(), 'set').mockRejectedValueOnce(new Error('disk full'));

    await expect(recordRecent('/a.md')).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('tells listeners after each change', async () => {
    const changed = vi.fn();
    const stop = onRecentChanged(changed);

    await recordRecent('/a.md');
    await clearRecent();
    stop();
    await recordRecent('/b.md');

    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe('getRecent', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 20; i++) await recordRecent(`/${i}.md`);
  });

  it('returns at most `limit` paths, newest first', async () => {
    expect(await getRecent(5)).toEqual(['/20.md', '/19.md', '/18.md', '/17.md', '/16.md']);
  });

  it('returns nothing for a limit of 0, without checking the disk', async () => {
    expect(await getRecent(0)).toEqual([]);
    expect(exists).not.toHaveBeenCalled();
  });

  it('drops a path whose file is gone, and forgets it', async () => {
    exists.mockImplementation(async (paths) => paths.map((p) => p !== '/19.md'));

    expect(await getRecent(3)).toEqual(['/20.md', '/18.md', '/17.md']);
    expect(stored()).not.toContain('/19.md');
    expect(stored()).toHaveLength(19);
  });
});

describe('knownRecent', () => {
  it('returns the stored list at once, without checking the disk', async () => {
    await recordRecent('/a.md');
    await recordRecent('/b.md');
    let finishCheck: (found: boolean[]) => void = () => {};
    exists.mockReturnValueOnce(new Promise((resolve) => (finishCheck = resolve)));
    const checking = getRecent(5);

    expect(await knownRecent(1)).toEqual(['/b.md']);
    expect(await knownRecent(0)).toEqual([]);
    finishCheck([true, true]);
    await checking;
  });
});

describe('a stored list from another version', () => {
  it('is ignored', async () => {
    store().data.set('version', 2);
    store().data.set('paths', ['/a.md']);

    expect(await getRecent(5)).toEqual([]);
    expect(await knownRecent(5)).toEqual([]);
  });
});

describe('recentMayHaveChanged', () => {
  it('tells listeners, so the menu reads the list again', () => {
    const changed = vi.fn();
    const stop = onRecentChanged(changed);

    recentMayHaveChanged();

    expect(changed).toHaveBeenCalledOnce();
    stop();
  });
});

describe('clearRecent', () => {
  it('empties the list', async () => {
    await recordRecent('/a.md');

    await clearRecent();

    expect(await getRecent(5)).toEqual([]);
    expect(stored()).toEqual([]);
  });
});
