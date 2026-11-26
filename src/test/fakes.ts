// In-memory stand-ins for Tauri plugins that need the native side. Use them from vi.mock
// factories: vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule)).

/** Every store call and every other faked side effect, in order, for ordering checks. */
export const calls: string[] = [];

export class FakeStore {
  data = new Map<string, unknown>();
  saves = 0;
  constructor(readonly path: string) {}

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    calls.push(`set ${this.path} ${key}`);
    this.data.set(key, structuredClone(value));
  }
  async entries<T>(): Promise<[string, T][]> {
    return [...this.data].map(([k, v]) => [k, structuredClone(v) as T]);
  }
  async length(): Promise<number> {
    return this.data.size;
  }
  async clear(): Promise<void> {
    calls.push(`clear ${this.path}`);
    this.data.clear();
  }
  async save(): Promise<void> {
    calls.push(`save ${this.path}`);
    this.saves++;
  }
}

const stores = new Map<string, FakeStore>();

/** The one instance per path, as the plugin shares it across windows. */
export function fakeStore(path: string): FakeStore {
  let store = stores.get(path);
  if (!store) stores.set(path, (store = new FakeStore(path)));
  return store;
}

export function resetFakes(): void {
  for (const store of stores.values()) {
    store.data.clear();
    store.saves = 0;
  }
  calls.length = 0;
  handlers.clear();
}

export const storeModule = {
  load: async (path: string) => fakeStore(path),
};

type Handler = (event: { event: string; payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();

/** Delivers to every listener at once, as Tauri does to all windows. */
export const eventModule = {
  emit: async (event: string, payload?: unknown) => {
    calls.push(`emit ${event}`);
    for (const handler of handlers.get(event) ?? []) handler({ event, payload });
  },
  listen: async (event: string, handler: Handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return () => handlers.get(event)?.delete(handler);
  },
};
