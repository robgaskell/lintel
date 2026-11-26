// jsdom has no ResizeObserver, and dockview creates one per component.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom has no matchMedia; the theme engine reads prefers-color-scheme through it.
window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList) as typeof window.matchMedia;
