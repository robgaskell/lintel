const KEPT_SCHEMES = new Set(['http', 'https', 'mailto']);
// Control characters and every Unicode space or invisible mark a URL parser or Windows might skip.
const IGNORED = /[\x00-\x20\x7f-\x9f\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g;
// Look-alikes Windows may read as slashes: fraction, division, reverse solidus operator, small reverse solidus.
const SLASHES = /[\u2044\u2215]/g;
const BACKSLASHES = /[\u29f5\u29f9\ufe68]/g;
const MAX_DECODES = 3;

/**
 * Whether a link in an exported file may stay a link: only http, https and mailto URLs,
 * relative paths (including Windows drive paths) and #fragments. A click on a network path
 * sends the user's Windows password hash to that host, so anything else keeps only its text
 * (Rulings 321, 324, 330). The check runs on the link as written and after each round of
 * percent-decoding, up to 3; a link that does not decode cleanly is not kept.
 */
export function keepsLink(href: string): boolean {
  let current = href;
  for (let round = 0; round <= MAX_DECODES; round++) {
    if (!isSafe(current)) return false;
    if (!current.includes('%')) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false;
    }
    if (decoded === current) return true;
    current = decoded;
  }
  return false; // still encoded after 3 rounds
}

function isSafe(href: string): boolean {
  // NFKC turns fullwidth letters, slashes and backslashes into plain ones.
  const target = href.normalize('NFKC').replace(SLASHES, '/').replace(BACKSLASHES, '\\').replace(IGNORED, '');
  if (/^[\\/]{2}/.test(target)) return false;
  // A colon before any slash, ? or # ends a scheme, whatever its characters (HTML turns a NUL into U+FFFD).
  const colon = target.search(/[:/\\?#]/);
  if (colon === -1 || target[colon] !== ':') return true;
  const scheme = target.slice(0, colon).toLowerCase();
  // One letter is a Windows drive, not a scheme.
  return /^[a-z]$/.test(scheme) || KEPT_SCHEMES.has(scheme);
}
