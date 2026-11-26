export const DROPPED = 'Dropped to save memory. Reopen the document to load it again.';
const CLEARED = 'The document no longer needs this image.';

/**
 * One document's images as data URIs. Reads are shared per key and limited in number;
 * results are kept up to a byte cap, least recently used out first (Rulings 83, 95, 97).
 * With `readOnce`, a key is read at most once until `clear`, failures included (Ruling 137).
 */
export class ImageLoader {
  private readonly cache = new Map<string, string>(); // in use order, oldest first
  private cachedBytes = 0;
  private readonly loads = new Map<string, Promise<string>>();
  private readonly failures = new Map<string, unknown>();
  private readonly dropped = new Set<string>();
  private readonly waiting: { go: () => void; stop: (why: string) => void }[] = [];
  private running = 0;
  private generation = 0;
  private readonly readOnce: boolean;

  constructor(
    private readonly read: (key: string) => Promise<string>,
    private readonly maxBytes = 50_000_000, // data URI characters, one byte each
    private readonly maxInFlight = 4,
    { readOnce = false }: { readOnce?: boolean } = {},
  ) {
    this.readOnce = readOnce;
  }

  /** The data URI if it is already loaded; marks it as just used. */
  cached(key: string): string | undefined {
    const uri = this.cache.get(key);
    if (uri !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, uri);
    }
    return uri;
  }

  /** Rejects with the reader's message. Without `readOnce`, the next call after a failure reads again. */
  load(key: string): Promise<string> {
    const known = this.cached(key);
    if (known !== undefined) return Promise.resolve(known);
    if (this.failures.has(key)) return Promise.reject(this.failures.get(key));
    if (this.dropped.has(key)) return Promise.reject(DROPPED);
    const running = this.loads.get(key);
    if (running) return running;
    const generation = this.generation;
    const load = this.limited(() => this.read(key)).then(
      (uri) => {
        if (generation === this.generation) this.keep(key, uri);
        return uri;
      },
      (err: unknown) => {
        if (this.readOnce && generation === this.generation) this.failures.set(key, err);
        throw err;
      },
    );
    const forget = () => {
      if (this.loads.get(key) === load) this.loads.delete(key);
    };
    load.then(forget, forget);
    this.loads.set(key, load);
    return load;
  }

  /** Forgets every image. Queued reads never start; running ones are not kept. */
  clear(): void {
    this.generation += 1;
    this.cache.clear();
    this.cachedBytes = 0;
    this.loads.clear();
    this.failures.clear();
    this.dropped.clear();
    for (const waiter of this.waiting.splice(0)) waiter.stop(CLEARED);
  }

  private keep(key: string, uri: string) {
    if (uri.length > this.maxBytes) {
      if (this.readOnce) this.dropped.add(key);
      return;
    }
    this.cache.set(key, uri);
    this.cachedBytes += uri.length;
    for (const [oldest, old] of this.cache) {
      if (this.cachedBytes <= this.maxBytes) break;
      this.cache.delete(oldest);
      this.cachedBytes -= old.length;
      if (this.readOnce) this.dropped.add(oldest);
    }
  }

  // A document with many images on a stalled disk must not tie up every IPC worker.
  // A finished read hands its slot straight to the next waiter; freeing it first would let
  // a load arriving before the waiter wakes take it too (Ruling 105).
  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxInFlight) {
      // A stopped waiter never held a slot, so it leaves without handing one on.
      await new Promise<void>((go, stop) => this.waiting.push({ go, stop }));
    } else {
      this.running += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next.go();
      else this.running -= 1;
    }
  }
}
