/**
 * One document's images, local or remote, as data URIs. Reads are shared per key and limited in
 * number; results are kept up to a byte cap, least recently used out first (Rulings 83, 95, 97).
 */
export class ImageLoader {
  private readonly cache = new Map<string, string>(); // in use order, oldest first
  private cachedBytes = 0;
  private readonly loads = new Map<string, Promise<string>>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  private generation = 0;

  constructor(
    private readonly read: (path: string) => Promise<string>,
    private readonly maxBytes = 50_000_000, // data URI characters, one byte each
    private readonly maxInFlight = 4,
  ) {}

  /** The data URI if it is already loaded; marks it as just used. */
  cached(path: string): string | undefined {
    const uri = this.cache.get(path);
    if (uri !== undefined) {
      this.cache.delete(path);
      this.cache.set(path, uri);
    }
    return uri;
  }

  /** Rejects with the reader's message. A failure is not kept, so the next call reads again. */
  load(path: string): Promise<string> {
    const known = this.cached(path);
    if (known !== undefined) return Promise.resolve(known);
    const running = this.loads.get(path);
    if (running) return running;
    const generation = this.generation;
    const load = this.limited(() => this.read(path)).then((uri) => {
      if (generation === this.generation) this.keep(path, uri);
      return uri;
    });
    const forget = () => {
      if (this.loads.get(path) === load) this.loads.delete(path);
    };
    load.then(forget, forget);
    this.loads.set(path, load);
    return load;
  }

  /** Forgets every image; reads still running are not kept when they finish. */
  clear(): void {
    this.generation += 1;
    this.cache.clear();
    this.cachedBytes = 0;
    this.loads.clear();
  }

  private keep(path: string, uri: string) {
    if (uri.length > this.maxBytes) return;
    this.cache.set(path, uri);
    this.cachedBytes += uri.length;
    for (const [oldest, old] of this.cache) {
      if (this.cachedBytes <= this.maxBytes) break;
      this.cache.delete(oldest);
      this.cachedBytes -= old.length;
    }
  }

  // A document with many images on a stalled disk must not tie up every IPC worker.
  // A finished read hands its slot straight to the next waiter; freeing it first would let
  // a load arriving before the waiter wakes take it too (Ruling 105).
  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxInFlight) await new Promise<void>((go) => this.waiting.push(go));
    else this.running += 1;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
