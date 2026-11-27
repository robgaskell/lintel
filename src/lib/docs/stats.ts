import { parseBlocks } from '../render/headings';
import type { DocState } from './store.svelte';

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Words in the document's prose: paragraphs, headings and table cells. Front matter, code
 * at any depth and raw HTML blocks are left out, and so are tokens with no letter or digit.
 */
export function countWords(text: string): number {
  let words = 0;
  for (const token of parseBlocks(text).tokens) {
    if (token.type !== 'inline') continue;
    for (const word of token.content.split(/\s+/)) {
      if (HAS_LETTER_OR_DIGIT.test(word)) words += 1;
    }
  }
  return words;
}

/** Minutes to read `words` at 200 words a minute, at least 1. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.ceil(words / 200));
}

/** Dirty wins over untitled (Ruling 111); a file deleted on disk is unsaved (Ruling 357). */
export function saveStateOf(
  doc: Pick<DocState, 'path' | 'text' | 'savedText' | 'external'>,
): 'saved' | 'unsaved' | 'untitled' {
  if (doc.text !== doc.savedText || doc.external === 'deleted') return 'unsaved';
  return doc.path === null ? 'untitled' : 'saved';
}
