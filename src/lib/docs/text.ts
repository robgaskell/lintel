export type LineEnding = '\n' | '\r\n';

/** Dominant ending wins; a tie or a file with no newline gets LF (Ruling 6). */
export function detectLineEnding(raw: string): LineEnding {
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  const lf = (raw.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function toBuffer(raw: string): string {
  return raw.replace(/\r\n/g, '\n');
}

export function toDisk(text: string, le: LineEnding): string {
  return le === '\n' ? text : text.replace(/\n/g, '\r\n');
}
