import { describe, expect, it } from 'vitest';
import { countWords, readingMinutes, saveStateOf } from './stats';

describe('countWords', () => {
  it('counts the words of headings and list items, not their markers', () => {
    expect(countWords('# Hello world\n\n- a b')).toBe(4);
  });

  it('does not count a fenced code block', () => {
    expect(countWords('one\n\n```js\nconst a = b + c;\n```\n\ntwo')).toBe(2);
    expect(countWords('one\n~~~\nskip these words\n~~~\ntwo')).toBe(2);
  });

  it('does not count front matter', () => {
    expect(countWords('---\ntitle: Many words in here\ntags: [a, b]\n---\nJust three words')).toBe(3);
  });

  it('ignores markdown punctuation that stands alone', () => {
    expect(countWords('> quoted *text* and **bold**\n\n| a | b |\n| - | - |\n\n---\n\n1. item')).toBe(7);
  });

  it('keeps counting after an unclosed fence is closed by a longer one', () => {
    expect(countWords('```\nno\n````\nyes')).toBe(1);
  });

  it('does not count code nested in a numbered step or a quote (Ruling 121)', () => {
    expect(countWords('1. Install:\n\n    ```sh\n    npm install foo bar baz\n    ```\n')).toBe(1);
    expect(countWords('> Example:\n> ```js\n> const a = b + c;\n> ```\n')).toBe(1);
    expect(countWords('- Run:\n\n        indented code here\n')).toBe(1);
  });

  it('counts a line that only looks like a fence opener as text', () => {
    expect(countWords('one\n```a`b\ntwo\n')).toBe(3);
  });

  it('counts 0 for an empty document', () => {
    expect(countWords('')).toBe(0);
  });
});

describe('readingMinutes', () => {
  it('reads 200 words a minute, rounding up, and is at least 1', () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(200)).toBe(1);
    expect(readingMinutes(201)).toBe(2);
    expect(readingMinutes(412)).toBe(3);
  });
});

describe('saveStateOf (Ruling 111)', () => {
  it('is unsaved when dirty, even if untitled', () => {
    expect(saveStateOf({ path: '/a.md', text: 'b', savedText: 'a' })).toBe('unsaved');
    expect(saveStateOf({ path: null, text: 'b', savedText: '' })).toBe('unsaved');
  });

  it('is untitled when clean with no path, else saved', () => {
    expect(saveStateOf({ path: null, text: '', savedText: '' })).toBe('untitled');
    expect(saveStateOf({ path: '/a.md', text: 'a', savedText: 'a' })).toBe('saved');
  });
});
