import { splitFrontMatter } from '../render/frontMatter';
import type { DocState } from './store.svelte';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
// Block markers at the start of a line: headings, quotes, bullets, numbers and tasks.
const LINE_MARKERS = /^\s*(?:(?:#{1,6}|>|[-*+]|\d{1,9}[.)])(?=\s|$)\s*)*(?:\[[ xX]\]\s)?/;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Words in the document, leaving out front matter, fenced code and markdown punctuation. */
export function countWords(text: string): number {
  const { body } = splitFrontMatter(text);
  let words = 0;
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    if (fence !== null) {
      // Only the same character, at least as long, with nothing after it, closes a fence.
      const close = CLOSING_FENCE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      fence = marker;
      continue;
    }
    for (const token of line.replace(LINE_MARKERS, '').split(/\s+/)) {
      if (HAS_LETTER_OR_DIGIT.test(token)) words += 1;
    }
  }
  return words;
}

/** Minutes to read `words` at 200 words a minute, at least 1. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.ceil(words / 200));
}

/** Dirty wins over untitled (Ruling 111). */
export function saveStateOf(doc: Pick<DocState, 'path' | 'text' | 'savedText'>): 'saved' | 'unsaved' | 'untitled' {
  if (doc.text !== doc.savedText) return 'unsaved';
  return doc.path === null ? 'untitled' : 'saved';
}
