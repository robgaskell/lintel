import { parse, YAMLParseError } from 'yaml';

const FENCE = /^---[ \t]*$/;

/**
 * Splits a leading `---` … `---` YAML block from the markdown body.
 * `bodyStartLine` is the 1-based file line where the body starts.
 */
export function splitFrontMatter(src: string): { yaml: string | null; body: string; bodyStartLine: number } {
  const none = { yaml: null, body: src, bodyStartLine: 1 };
  const text = src.startsWith('﻿') ? src.slice(1) : src;
  const lines = text.split('\n');
  if (!FENCE.test(stripCR(lines[0] ?? ''))) return none;

  const close = lines.findIndex((line, i) => i > 0 && FENCE.test(stripCR(line)));
  if (close === -1) return none;

  return {
    yaml: lines.slice(1, close).join('\n').replace(/\r$/, ''),
    body: lines.slice(close + 1).join('\n'),
    bodyStartLine: close + 2,
  };
}

/** Parses the YAML from `splitFrontMatter`. Errors are one line, numbered by file line. */
export function parseFrontMatter(yaml: string): {
  frontMatter: Record<string, unknown> | null;
  frontMatterError: string | null;
} {
  let value: unknown;
  try {
    value = parse(yaml);
  } catch (err) {
    return { frontMatter: null, frontMatterError: errorLine(err) };
  }
  if (value === null || value === undefined) return { frontMatter: {}, frontMatterError: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { frontMatter: null, frontMatterError: 'Front matter must be a YAML mapping (key: value lines).' };
  }
  return { frontMatter: value as Record<string, unknown>, frontMatterError: null };
}

function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

// yaml numbers lines from the start of the block; the opening fence is file line 1.
function errorLine(err: unknown): string {
  if (!(err instanceof YAMLParseError)) return String(err);
  const first = err.message.split('\n')[0] ?? '';
  return first.replace(/ at line (\d+), column (\d+):?$/, (_, line: string, col: string) => {
    return ` at line ${Number(line) + 1}, column ${col}`;
  });
}
