import DOMPurify from 'dompurify';
import type { Mermaid } from 'mermaid';

export type DiagramTheme = 'light' | 'dark';

type Outcome = { svg: string } | { error: string };

/**
 * Replaces each `pre.mermaid-src` in `container` with its diagram, or with an error box.
 * Known diagrams go in before this returns, so a re-render never flashes (Ruling 100).
 * Diagrams already drawn in another theme are drawn again. Each call makes the previous
 * call's renders for this container stale (Ruling 115).
 */
export async function renderMermaidIn(container: HTMLElement, theme: DiagramTheme): Promise<void> {
  const generation = (generations.get(container) ?? 0) + 1;
  generations.set(container, generation);
  const request: Request = { container, generation };

  const blocks: { el: HTMLElement; source: string }[] = [];
  let diagrams = 0;
  for (const el of container.querySelectorAll<HTMLElement>('pre.mermaid-src')) {
    blocks.push({ el, source: el.textContent ?? '' });
    diagrams += 1;
  }
  for (const el of container.querySelectorAll<HTMLElement>('.mermaid-diagram, .mermaid-error')) {
    const drawn = drawnFrom.get(el);
    if (!drawn) continue;
    diagrams += 1;
    if (drawn.theme !== theme) blocks.push({ el, source: drawn.source });
  }
  capacity = Math.max(MIN_CACHED, diagrams + 16);
  await Promise.all(blocks.map(({ el, source }) => place(el, source, theme, request)));
}

/** The diagram as sanitised SVG markup. Rejects with mermaid's message. */
export async function renderMermaidToSvg(source: string, theme: DiagramTheme): Promise<string> {
  const outcome = await outcomeFor(source, theme, null);
  if (outcome === null) throw new Error('The diagram render was cancelled.'); // not reached: no container
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome.svg;
}

// The call that asked for a render; null means a caller with no container, never stale.
type Request = { container: HTMLElement; generation: number } | null;

const generations = new WeakMap<HTMLElement, number>();

function isCurrent(request: Request): boolean {
  return request === null || generations.get(request.container) === request.generation;
}

// Which source and theme each wrapper shows. Raw HTML cannot add entries, so a forged
// `mermaid-diagram` element is never treated as ours.
const drawnFrom = new WeakMap<HTMLElement, { source: string; theme: DiagramTheme }>();

async function place(el: HTMLElement, source: string, theme: DiagramTheme, request: Request): Promise<void> {
  let outcome: Outcome | null;
  try {
    outcome = cached(source, theme) ?? (await outcomeFor(source, theme, request));
  } catch (err) {
    outcome = { error: `Diagrams could not load: ${String(err)}` }; // not cached, so the next render retries
  }
  if (outcome === null || !el.isConnected || !isCurrent(request)) return;
  const fenceLine = el.dataset.sourceLine;
  const wrapper = 'svg' in outcome ? diagramBox(outcome.svg) : errorBox(locateError(outcome.error, source, fenceLine));
  if (fenceLine !== undefined) wrapper.dataset.sourceLine = fenceLine;
  drawnFrom.set(wrapper, { source, theme });
  el.replaceWith(wrapper);
}

let copies = 0;

function diagramBox(svg: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'mermaid-diagram';
  const template = document.createElement('template');
  template.innerHTML = svg; // already sanitised by renderOne
  copies += 1;
  suffixIds(template.content, `-c${copies}`);
  box.append(template.content);
  return box;
}

// A cached SVG can be on the page twice; a shared id would send url(#id) to the other copy (Ruling 114).
function suffixIds(root: DocumentFragment, suffix: string) {
  const renamed = new Map<string, string>();
  for (const el of root.querySelectorAll('[id]')) {
    renamed.set(el.id, el.id + suffix);
    el.id += suffix;
  }
  if (renamed.size === 0) return;
  const rename = (id: string) => renamed.get(id) ?? id;
  for (const el of root.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (attr.name === 'id') continue;
      let value = attr.value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (_, quote: string, id: string) => {
        return `url(${quote}#${rename(id)}${quote})`;
      });
      if ((attr.name === 'href' || attr.name === 'xlink:href') && value.startsWith('#')) {
        value = `#${rename(value.slice(1))}`;
      } else if (attr.name === 'aria-labelledby' || attr.name === 'aria-describedby') {
        value = value.split(/\s+/).map(rename).join(' ');
      }
      if (value !== attr.value) attr.value = value;
    }
    if (el.localName === 'style' && el.textContent) {
      el.textContent = el.textContent.replace(/#((?:[\w-]|[^\x00-\x7f])+)/g, (_, id: string) => `#${rename(id)}`);
    }
  }
}

// Mermaid numbers lines within the diagram and may report one past its end (Ruling 117).
function locateError(message: string, source: string, fenceLine: string | undefined): string {
  const [first = '', ...rest] = message.split('\n');
  const lines = source.replace(/\n$/, '').split('\n').length;
  const located = first.replace(/\bline (\d+)/, (_, n: string) => {
    const line = Math.min(Number(n), lines);
    const where = fenceLine === undefined ? '' : ` (file line ${Number(fenceLine) + line})`;
    return `line ${line} of the diagram${where}`;
  });
  return [located, ...rest].join('\n');
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

// Least recently used first out; large enough that a document's own diagrams never push
// each other out (Ruling 115).
const MIN_CACHED = 64;
let capacity = MIN_CACHED;
const cache = new Map<string, { source: string; outcome: Outcome }>(); // least recently used first

function cached(source: string, theme: DiagramTheme): Outcome | undefined {
  const key = cacheKey(source, theme);
  const entry = cache.get(key);
  if (entry?.source !== source) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry.outcome;
}

function remember(source: string, theme: DiagramTheme, outcome: Outcome) {
  const key = cacheKey(source, theme);
  cache.delete(key);
  cache.set(key, { source, outcome });
  for (const oldest of cache.keys()) {
    if (cache.size <= capacity) break;
    cache.delete(oldest);
  }
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

// One job per theme and source; every call that wants it is listed, so it runs while any is current.
type Job = { requests: Request[]; result: Promise<Outcome | null> };
const running = new Map<string, Job>();

/** Resolves null when every call that wanted this render went stale before it started. */
function outcomeFor(source: string, theme: DiagramTheme, request: Request): Promise<Outcome | null> {
  const known = cached(source, theme);
  if (known) return Promise.resolve(known);
  const key = cacheKey(source, theme);
  const existing = running.get(key);
  if (existing) {
    existing.requests.push(request);
    return existing.result;
  }
  const job: Job = { requests: [request], result: Promise.resolve(null) };
  const work = queue.then(() => (job.requests.some(isCurrent) ? renderOne(source, theme) : null));
  queue = work.then(
    () => {},
    () => {},
  );
  job.result = work
    .then((outcome) => {
      if (outcome) remember(source, theme, outcome);
      return outcome;
    })
    .finally(() => running.delete(key));
  running.set(key, job);
  return job.result;
}

const FORBIDDEN_IN_DIAGRAMS = ['img', 'image', 'feimage', 'a', 'script', 'iframe'];
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
      // A 300-edge flowchart blocks the UI for seconds (Ruling 114).
      maxEdges: 200,
      maxTextSize: 20000,
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

// Repeated until stable, so removing one piece cannot join two others into `@import`.
// Escapes go first, as they could spell `url(` (Ruling 114).
function cleanCss(css: string): string {
  let previous: string;
  do {
    previous = css;
    css = css
      .replace(/\\/g, '')
      .replace(/@import/gi, '')
      .replace(/(?:image-set|src)\s*\(/gi, 'blocked(')
      .replace(/url\s*\(\s*(?!['"]?#)/gi, 'blocked(');
  } while (css !== previous);
  return css;
}

// Presentation attributes such as fill, mask and clip-path take url() too.
function fetchesRemotely(value: string): boolean {
  if (value.includes('\\')) return value.includes('(');
  for (const [, fn = '', target = ''] of value.matchAll(/(url|image-set|src)\s*\(\s*['"]?([^'")]*)/gi)) {
    if (fn.toLowerCase() !== 'url' || !target.startsWith('#')) return true;
  }
  return false;
}

purify.addHook('afterSanitizeElements', (node) => {
  if (node.nodeName.toLowerCase() === 'style' && node.textContent) node.textContent = cleanCss(node.textContent);
});

purify.addHook('afterSanitizeAttributes', (node) => {
  for (const { name, value } of [...node.attributes]) {
    if (name === 'style') node.setAttribute('style', cleanCss(value));
    else if (fetchesRemotely(value)) node.removeAttribute(name);
    else if ((name === 'href' || name === 'xlink:href') && !value.trim().startsWith('#')) node.removeAttribute(name);
  }
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
