export type LineEnding = '\n' | '\r\n';

/**
 * Dominant ending wins; a tie or a file with no newline gets LF (Ruling 6).
 * A lone CR counts with LF, since the buffer turns it into LF (Ruling 13).
 */
export function detectLineEnding(raw: string): LineEnding {
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  const other = raw.match(/\r\n?|\n/g)?.length ?? 0;
  return crlf > other - crlf ? '\r\n' : '\n';
}

/** CRLF and lone CR become LF, matching what CodeMirror holds. */
export function toBuffer(raw: string): string {
  return raw.replace(/\r\n?/g, '\n');
}

export function toDisk(text: string, le: LineEnding): string {
  return le === '\n' ? text : text.replace(/\n/g, '\r\n');
}
