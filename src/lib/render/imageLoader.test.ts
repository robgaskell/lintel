import { describe, expect, it, vi } from 'vitest';
import { DROPPED, ImageLoader } from './imageLoader';

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

  it('never runs a 5th read, even when a new load lands while a slot is handed over (Ruling 105)', async () => {
    let inFlight = 0;
    let most = 0;
    const finishers: (() => void)[] = [];
    const loader = new ImageLoader(
      () =>
        new Promise<string>((resolve) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          finishers.push(() => {
            inFlight -= 1;
            resolve('data:x');
          });
        }),
    );
    for (const n of [1, 2, 3, 4, 5]) void loader.load(`/${n}.png`);

    finishers.shift()!();
    // A load on every microtask turn, so one lands between the release and the waiter waking.
    for (let n = 0; n < 10; n++) {
      void loader.load(`/late${n}.png`);
      await Promise.resolve();
    }

    expect(most).toBe(4);
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

  // Ruling 137: nothing more is sent once the doc closes or remote images are blocked again.
  it('clear() during a queued burst sends nothing more', async () => {
    const { read, pending } = manualRead();
    const loader = new ImageLoader(read);
    const loads = Array.from({ length: 12 }, (_, i) => loader.load(`https://x.test/${i}.png`));
    const outcomes = loads.map((load) => load.then(() => 'loaded', () => 'refused'));
    expect(read).toHaveBeenCalledTimes(4);

    loader.clear();
    for (const p of pending) p.resolve('data:x');
    await settle();

    expect(read).toHaveBeenCalledTimes(4);
    expect(await Promise.all(outcomes.slice(4))).toEqual(Array(8).fill('refused'));
    void loader.load('https://x.test/new.png');
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('with readOnce, remembers a failure until clear', async () => {
    const { read, pending } = manualRead();
    const loader = new ImageLoader(read, 100, 4, { readOnce: true });

    const first = loader.load('https://x.test/a.png');
    pending[0]!.reject('The server answered 404 Not Found.');
    await expect(first).rejects.toBe('The server answered 404 Not Found.');
    await expect(loader.load('https://x.test/a.png')).rejects.toBe('The server answered 404 Not Found.');
    expect(read).toHaveBeenCalledTimes(1);

    loader.clear();
    void loader.load('https://x.test/a.png');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('with readOnce, does not read an image again after the cap drops it', async () => {
    const read = vi.fn(async () => 'x'.repeat(60));
    const loader = new ImageLoader(read, 100, 4, { readOnce: true });

    await loader.load('https://x.test/a.png');
    await loader.load('https://x.test/b.png');

    expect(loader.cached('https://x.test/a.png')).toBeUndefined();
    await expect(loader.load('https://x.test/a.png')).rejects.toBe(DROPPED);
    expect(read).toHaveBeenCalledTimes(2);

    loader.clear();
    await loader.load('https://x.test/a.png');
    expect(read).toHaveBeenCalledTimes(3);
  });
});
