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

// jsdom's Range has no layout methods. CodeMirror measures text with them in an animation
// frame, which under load can run after a test and throw (Ruling 176).
const emptyRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
Range.prototype.getClientRects ??= function () {
  return Object.assign([], { item: () => null }) as unknown as DOMRectList;
};
Range.prototype.getBoundingClientRect ??= function () {
  return { ...emptyRect, toJSON: () => emptyRect } as DOMRect;
};
