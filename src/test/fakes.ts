// In-memory stand-ins for Tauri plugins that need the native side. Use them from vi.mock
// factories: vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule)).

/** Every store call and every other faked side effect, in order, for ordering checks. */
export const calls: string[] = [];

/** The options each `load` was given, in order. */
export const loads: { path: string; options: unknown }[] = [];

// Values cross the IPC bridge as JSON, so NaN becomes null and undefined fields vanish.
function viaJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export class FakeStore {
  data = new Map<string, unknown>();
  saves = 0;
  constructor(readonly path: string) {}

  async get<T>(key: string): Promise<T | undefined> {
    return viaJson(this.data.get(key)) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    // The real command needs a value; JSON drops an undefined one, so the call fails.
    if (value === undefined) throw new Error(`invalid args \`value\` for set: missing required key`);
    calls.push(`set ${this.path} ${key}`);
    this.data.set(key, viaJson(value));
  }
  async entries<T>(): Promise<[string, T][]> {
    return [...this.data].map(([k, v]) => [k, viaJson(v) as T]);
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
  listenCalls.length = 0;
  events.failNextListen = null;
}

export const storeModule = {
  load: async (path: string, options?: unknown) => {
    loads.push({ path, options });
    return fakeStore(path);
  },
};

type Handler = (event: { event: string; payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();

/** Set `failNextListen` to make the next `listen` reject with it. */
export const events = { failNextListen: null as Error | null };

/** Every `listen`, with the options it was given, in order. */
export const listenCalls: { event: string; options: unknown }[] = [];

/** Delivers to every listener after the emit resolves, as Tauri does through the core. */
export const eventModule = {
  emit: async (event: string, payload?: unknown) => {
    calls.push(`emit ${event}`);
    const sent = viaJson(payload);
    for (const handler of handlers.get(event) ?? []) {
      setTimeout(() => handler({ event, payload: sent }), 0);
    }
  },
  listen: async (event: string, handler: Handler, options?: unknown) => {
    listenCalls.push({ event, options });
    const failure = events.failNextListen;
    if (failure) {
      events.failNextListen = null;
      throw failure;
    }
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return () => handlers.get(event)?.delete(handler);
  },
};
