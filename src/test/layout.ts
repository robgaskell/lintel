const FAKED = ['clientHeight', 'offsetTop', 'offsetHeight'] as const;

/**
 * jsdom has no layout. This makes the preview scroller 400 px tall and puts each
 * top-level block of its content 100 px below the last, and gives Range empty geometry
 * for CodeMirror. Returns the undo.
 */
export function fakePreviewLayout(): () => void {
  const proto = HTMLElement.prototype;
  const saved = FAKED.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  const define = (key: (typeof FAKED)[number], get: (el: HTMLElement) => number) =>
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement) {
        return get(this);
      },
    });
  define('clientHeight', (el) => (el.classList.contains('preview') ? 400 : 0));
  define('offsetTop', (el) => {
    const parent = el.parentElement;
    return parent?.classList.contains('content') ? [...parent.children].indexOf(el) * 100 : 0;
  });
  define('offsetHeight', (el) => (el.classList.contains('content') ? el.children.length * 100 : 0));
  // CodeMirror measures text through Range, which jsdom leaves without geometry.
  const range = Range.prototype as unknown as Record<string, unknown>;
  const hadRects = 'getClientRects' in range;
  if (!hadRects) {
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => new DOMRect();
  }
  return () => {
    if (!hadRects) {
      delete range.getClientRects;
      delete range.getBoundingClientRect;
    }
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
}
