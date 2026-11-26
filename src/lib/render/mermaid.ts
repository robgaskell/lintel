import DOMPurify from 'dompurify';
import type { Mermaid } from 'mermaid';

export type DiagramTheme = 'light' | 'dark';

type Outcome = { svg: string } | { error: string };

/**
 * Replaces each `pre.mermaid-src` in `container` with its diagram, or with an error box.
 * Known diagrams go in before this returns, so a re-render never flashes (Ruling 100).
 * Diagrams already drawn in another theme are drawn again.
 */
export async function renderMermaidIn(container: HTMLElement, theme: DiagramTheme): Promise<void> {
  const blocks: { el: HTMLElement; source: string }[] = [];
  for (const el of container.querySelectorAll<HTMLElement>('pre.mermaid-src')) {
    blocks.push({ el, source: el.textContent ?? '' });
  }
  for (const el of container.querySelectorAll<HTMLElement>('.mermaid-diagram, .mermaid-error')) {
    const drawn = drawnFrom.get(el);
    if (drawn && drawn.theme !== theme) blocks.push({ el, source: drawn.source });
  }
  await Promise.all(blocks.map(({ el, source }) => place(el, source, theme)));
}

/** The diagram as sanitised SVG markup. Rejects with mermaid's message. */
export async function renderMermaidToSvg(source: string, theme: DiagramTheme): Promise<string> {
  const outcome = await outcomeFor(source, theme);
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome.svg;
}

// Which source and theme each wrapper shows. Raw HTML cannot add entries, so a forged
// `mermaid-diagram` element is never treated as ours.
const drawnFrom = new WeakMap<HTMLElement, { source: string; theme: DiagramTheme }>();
// The theme each block was last asked for; an older render finishing late is dropped.
const wanted = new WeakMap<HTMLElement, DiagramTheme>();

async function place(el: HTMLElement, source: string, theme: DiagramTheme): Promise<void> {
  wanted.set(el, theme);
  const known = cache.get(cacheKey(source, theme));
  let outcome: Outcome;
  try {
    outcome = known?.source === source ? known.outcome : await outcomeFor(source, theme);
  } catch (err) {
    outcome = { error: `Diagrams could not load: ${String(err)}` }; // not cached, so the next render retries
  }
  if (!el.isConnected || wanted.get(el) !== theme) return;
  const wrapper = 'svg' in outcome ? diagramBox(outcome.svg) : errorBox(outcome.error);
  const line = el.dataset.sourceLine;
  if (line !== undefined) wrapper.dataset.sourceLine = line;
  drawnFrom.set(wrapper, { source, theme });
  el.replaceWith(wrapper);
}

function diagramBox(svg: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'mermaid-diagram';
  const template = document.createElement('template');
  template.innerHTML = svg; // already sanitised by renderOne
  box.append(template.content);
  return box;
}

// textContent only: the message quotes the document's source (Ruling 103).
function errorBox(message: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'mermaid-error';
  const [first = '', ...rest] = message.split('\n');
  const title = document.createElement('strong');
  title.textContent = first;
  box.append(title);
  if (rest.length > 0) {
    const detail = document.createElement('pre');
    detail.textContent = rest.join('\n');
    box.append(detail);
  }
  return box;
}

// Bounded, so typing inside a diagram does not keep every draft.
const MAX_CACHED = 64;
const cache = new Map<string, { source: string; outcome: Outcome }>(); // oldest first
const running = new Map<string, Promise<Outcome>>();

function outcomeFor(source: string, theme: DiagramTheme): Promise<Outcome> {
  const key = cacheKey(source, theme);
  const known = cache.get(key);
  if (known?.source === source) return Promise.resolve(known.outcome);
  const pending = running.get(key);
  if (pending) return pending;
  const job = queue.then(() => renderOne(source, theme));
  queue = job.then(
    () => {},
    () => {},
  );
  const tracked = job
    .then((outcome) => {
      remember(key, source, outcome);
      return outcome;
    })
    .finally(() => running.delete(key));
  running.set(key, tracked);
  return tracked;
}

function remember(key: string, source: string, outcome: Outcome) {
  cache.delete(key);
  cache.set(key, { source, outcome });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

function cacheKey(source: string, theme: DiagramTheme): string {
  return `${theme}:${hash(source)}`;
}

// cyrb53: a fast 53-bit string hash. The entry also keeps its source, so a collision misses.
function hash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const FORBIDDEN_IN_DIAGRAMS = ['img', 'image', 'a', 'script', 'iframe'];
// Mermaid 12.3.0's own list; `secure` replaces it rather than adding to it.
const MERMAID_SECURE_DEFAULTS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges'];

// One render at a time: mermaid's theme is global, so set it and render as one step.
let queue: Promise<void> = Promise.resolve();
let loaded: Promise<Mermaid> | null = null;
let shownTheme: DiagramTheme | null = null;
let renderCount = 0;

async function renderOne(source: string, theme: DiagramTheme): Promise<Outcome> {
  const mermaid = await loadMermaid();
  if (shownTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: theme === 'dark' ? 'dark' : 'default',
      // Mermaid lays labels out in the live page before we sanitise, so its own pass must
      // drop images too, and a document's init block must not undo that or add CSS with url().
      dompurifyConfig: { FORBID_TAGS: ['style', ...FORBIDDEN_IN_DIAGRAMS] },
      secure: [...MERMAID_SECURE_DEFAULTS, 'dompurifyConfig', 'themeCSS', 'fontFamily', 'altFontFamily'],
    });
    shownTheme = theme;
  }
  renderCount += 1;
  const id = `lintel-mermaid-${renderCount}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return { svg: sanitiseSvg(svg) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    // A failed render can leave its scratch node in the body (Ruling 99).
    document.getElementById(`d${id}`)?.remove();
  }
}

function loadMermaid(): Promise<Mermaid> {
  loaded ??= import('mermaid').then(
    (module) => module.default,
    (err: unknown) => {
      loaded = null; // let the next diagram try again
      throw err;
    },
  );
  return loaded;
}

// Separate from the document sanitiser: diagrams need style, classes and ids, which
// documents may not have (Ruling 99).
const purify = DOMPurify(window);

// A diagram must never fetch: no url(), image-set() or @import, and no CSS escapes to hide them.
function stripUrls(css: string): string {
  return css
    .replace(/\\/g, '')
    .replace(/(url|image-set|src)\s*\(/gi, 'blocked(')
    .replace(/@import/gi, '');
}

purify.addHook('afterSanitizeElements', (node) => {
  if (node.nodeName.toLowerCase() === 'style' && node.textContent) node.textContent = stripUrls(node.textContent);
});

purify.addHook('afterSanitizeAttributes', (node) => {
  const style = node.getAttribute('style');
  if (style) node.setAttribute('style', stripUrls(style));
});

const SVG_RULES = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['foreignObject'], // flowchart labels are HTML inside foreignObject
  FORBID_TAGS: FORBIDDEN_IN_DIAGRAMS,
};

function sanitiseSvg(svg: string): string {
  if (!purify.isSupported) throw new Error('DOMPurify cannot run here, so diagrams are not drawn.');
  return purify.sanitize(svg, SVG_RULES);
}
