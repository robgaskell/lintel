const KEPT_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * Whether a link in an exported file may stay a link. A click on a network path sends the
 * user's Windows password hash to that host, so network paths, any file: URL and any scheme
 * but http, https and mailto keep only their text. Relative and #fragment links stay
 * (Rulings 321, 324). Used by both exports.
 */
export function keepsLink(href: string): boolean {
  return isSafe(href) && isSafe(percentDecoded(href));
}

function isSafe(href: string): boolean {
  // URL parsers ignore spaces and control characters.
  const target = href.replace(/[\x00-\x20]/g, '');
  if (/^[\\/]{2}/.test(target)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  // One letter is a Windows drive, not a scheme.
  return scheme === undefined || scheme.length === 1 || KEPT_SCHEMES.has(scheme);
}

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
