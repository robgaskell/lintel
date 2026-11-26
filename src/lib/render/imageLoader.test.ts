import { describe, expect, it, vi } from 'vitest';
import { ImageLoader } from './imageLoader';

type Pending = { path: string; resolve: (uri: string) => void; reject: (err: unknown) => void };

function manualRead() {
  const pending: Pending[] = [];
  const read = vi.fn(
    (path: string) => new Promise<string>((resolve, reject) => pending.push({ path, resolve, reject })),
  );
  return { read, pending };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ImageLoader', () => {
  it('reads each path once, even when asked again while the read runs', async () => {
    const { read, pending } = manualRead();
    const loader = new ImageLoader(read);

    const a = loader.load('/a.png');
    const b = loader.load('/a.png');
    pending[0]!.resolve('data:a');

    expect(await a).toBe('data:a');
    expect(await b).toBe('data:a');
    expect(read).toHaveBeenCalledTimes(1);
    expect(loader.cached('/a.png')).toBe('data:a');
  });

  it('keeps at most 4 reads in flight and starts the next as one finishes (Ruling 95)', async () => {
    const { read, pending } = manualRead();
    const loader = new ImageLoader(read);

    for (const n of [1, 2, 3, 4, 5, 6]) void loader.load(`/${n}.png`);
    expect(read).toHaveBeenCalledTimes(4);

    pending[0]!.resolve('data:1');
    await settle();
    expect(read).toHaveBeenCalledTimes(5);

    pending[1]!.reject('Timed out reading /2.png.');
    await settle();
    expect(read).toHaveBeenCalledTimes(6);
  });

  it('does not keep a failure, so a later render tries again', async () => {
    const { read, pending } = manualRead();
    const loader = new ImageLoader(read);

    const first = loader.load('/a.png');
    pending[0]!.reject('Could not read /a.png');
    await expect(first).rejects.toBe('Could not read /a.png');

    void loader.load('/a.png');
    expect(read).toHaveBeenCalledTimes(2);
    expect(loader.cached('/a.png')).toBeUndefined();
  });

  it('drops the oldest images once the cache passes its byte cap (Ruling 97)', async () => {
    const read = vi.fn(async (path: string) => 'x'.repeat(path === '/big.png' ? 60 : 40));
    const loader = new ImageLoader(read, 100);

    await loader.load('/a.png');
    await loader.load('/b.png');
    loader.cached('/a.png'); // a is now the most recently used
    await loader.load('/c.png');

    expect(loader.cached('/b.png')).toBeUndefined();
    expect(loader.cached('/a.png')).toBeDefined();
    expect(loader.cached('/c.png')).toBeDefined();

    await loader.load('/big.png');
    expect(loader.cached('/big.png')).toBeDefined();
    expect(loader.cached('/a.png')).toBeUndefined();
  });

  it('forgets everything on clear, including reads that finish afterwards', async () => {
    const { read, pending } = manualRead();
    const loader = new ImageLoader(read);
    const late = loader.load('/a.png');

    loader.clear();
    pending[0]!.resolve('data:a');
    await late;

    expect(loader.cached('/a.png')).toBeUndefined();
  });
});
