import { slugify } from './markdown';

/** What a click on a preview link should do. */
export type HrefAction =
  | { kind: 'external'; url: string } // opened by the system (Ruling 80)
  | { kind: 'anchor'; fragment: string } // decoded, without the '#'
  | { kind: 'file'; target: string } // as written; resolve with resolveTarget
  | { kind: 'ignore' };

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
// RFC 3986 scheme. One letter followed by ':' is a Windows drive, not a scheme.
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

export function classifyHref(href: string): HrefAction {
  if (href === '' || href.startsWith('//')) return { kind: 'ignore' };
  if (href.startsWith('#')) return { kind: 'anchor', fragment: decode(href.slice(1)) };
  if (!SCHEME.test(href)) return { kind: 'file', target: href };
  try {
    const url = new URL(href);
    // The opener's scope match is case-sensitive, so the scheme goes in lower-case.
    if (url.protocol === 'mailto:') return safeMailto(url);
    if (EXTERNAL_SCHEMES.has(url.protocol)) return { kind: 'external', url: url.href };
  } catch {
    // Not a URL the system could open either.
  }
  return { kind: 'ignore' };
}

/** How the preview treats an image source. Only `webImageUrl` sources can ever load remotely. */
export function classifyImageSrc(src: string): 'data' | 'remote' | 'local' {
  if (/^data:/i.test(src)) return 'data';
  if (src.startsWith('//') || SCHEME.test(src)) return 'remote';
  return 'local';
}

/** The address to fetch for an http(s) image; `//host` is fetched as https (Ruling 124). */
export function webImageUrl(src: string): string | null {
  const absolute = src.startsWith('//') ? `https:${src}` : src;
  if (!/^https?:/i.test(absolute)) return null;
  try {
    return new URL(absolute).href;
  } catch {
    return null;
  }
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * The file a link or image target names, resolved against the doc's folder with string
 * logic only. Null when it cannot be resolved: an empty target, a relative target in an
 * unsaved doc, a Windows drive-letter target, which v1 does not support (Ruling 81), or
 * a network path.
 */
export function resolveTarget(docPath: string | null, target: string): string | null {
  const path = decode(target.replace(/[?#].*$/s, ''));
  if (path === '' || /^[a-z]:/i.test(path) || isNetworkPath(path)) return null;
  const resolved = resolveLocal(docPath, path);
  // Checked again after joining, as a doc on a share would put its own root in front.
  return resolved === null || isNetworkPath(resolved) ? null : resolved;
}

/**
 * The `h-` heading id a `#fragment` points at, or null. Tries the fragment as written,
 * lower-cased, then slugged as the renderer slugs heading text (Ruling 64).
 */
export function headingIdFor(fragment: string, ids: ReadonlySet<string>): string | null {
  const candidates = [
    fragment,
    `h-${fragment}`,
    `h-${fragment.toLowerCase()}`,
    `h-${slugify(fragment, new Map())}`,
  ];
  return candidates.find((id) => id.startsWith('h-') && ids.has(id)) ?? null;
}

// Some mail clients honour ?attach=<path>, so only the address, subject and body pass (Ruling 97).
function safeMailto(url: URL): HrefAction {
  const address = decode(url.pathname);
  if (/[?&]/.test(address)) return { kind: 'ignore' };
  const kept: string[] = [];
  for (const field of ['subject', 'body']) {
    const value = [...url.searchParams].find(([key]) => key.toLowerCase() === field)?.[1];
    if (value !== undefined) kept.push(`${field}=${encodeURIComponent(value)}`);
  }
  const query = kept.length > 0 ? `?${kept.join('&')}` : '';
  return { kind: 'external', url: `mailto:${url.pathname}${query}` };
}

function resolveLocal(docPath: string | null, path: string): string | null {
  if (/^[\\/]/.test(path)) return joinUnder('/', path.split(/[\\/]/), '/');
  if (docPath === null) return null;
  const { root, rest } = splitRoot(docPath);
  const sep = root.includes('\\') ? '\\' : '/';
  const folder = rest.split(/[\\/]/).slice(0, -1);
  return joinUnder(root, [...folder, ...path.split(/[\\/]/)], sep);
}

// Two leading separators in any mix mean UNC, \\?\ or \\.\ on Windows: opening one
// connects to another host and can leak the user's password hash (Ruling 94).
function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// The part of a path `..` cannot climb above: "/", "C:\" or "\\server\share\".
function splitRoot(path: string): { root: string; rest: string } {
  const match = /^([a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]|\/)/i.exec(path);
  const root = match?.[0] ?? '';
  return { root, rest: path.slice(root.length) };
}

function joinUnder(root: string, parts: string[], sep: string): string {
  const kept: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') kept.pop();
    else kept.push(part);
  }
  return root + kept.join(sep);
}
