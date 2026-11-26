import { describe, expect, it } from 'vitest';
import { parseFrontMatter, splitFrontMatter } from './frontMatter';

describe('splitFrontMatter', () => {
  it('splits a leading --- block from the body', () => {
    expect(splitFrontMatter('---\nname: x\n---\n# Hi\n')).toEqual({
      yaml: 'name: x',
      body: '# Hi\n',
      bodyStartLine: 4,
    });
  });

  it('returns the whole source as body when there is no front matter', () => {
    expect(splitFrontMatter('# Hi\n---\n')).toEqual({ yaml: null, body: '# Hi\n---\n', bodyStartLine: 1 });
  });

  it('needs a closing --- line', () => {
    expect(splitFrontMatter('---\nname: x\n# Hi\n')).toEqual({
      yaml: null,
      body: '---\nname: x\n# Hi\n',
      bodyStartLine: 1,
    });
  });

  it('handles CRLF line endings and trailing spaces on the fences', () => {
    expect(splitFrontMatter('--- \r\na: 1\r\nb: 2\r\n---\r\nbody')).toEqual({
      yaml: 'a: 1\r\nb: 2',
      body: 'body',
      bodyStartLine: 5,
    });
  });

  it('accepts an empty block and a file that ends at the closing fence', () => {
    expect(splitFrontMatter('---\n---')).toEqual({ yaml: '', body: '', bodyStartLine: 3 });
  });

  it('ignores a byte order mark before the opening fence', () => {
    expect(splitFrontMatter('﻿---\na: 1\n---\nx').yaml).toBe('a: 1');
  });
});

describe('parseFrontMatter', () => {
  it('parses a YAML mapping', () => {
    expect(parseFrontMatter('name: x\ntags: [a, b]')).toEqual({
      frontMatter: { name: 'x', tags: ['a', 'b'] },
      frontMatterError: null,
    });
  });

  it('gives an empty object for an empty block', () => {
    expect(parseFrontMatter('')).toEqual({ frontMatter: {}, frontMatterError: null });
  });

  it('reports invalid YAML on one line, with the file line number', () => {
    const r = parseFrontMatter('a: 1\nb: [1,\n');
    expect(r.frontMatter).toBeNull();
    expect(r.frontMatterError).toMatch(/at line 4, column 1$/);
    expect(r.frontMatterError).not.toContain('\n');
  });

  it('refuses YAML that is not a mapping', () => {
    const r = parseFrontMatter('- a\n- b');
    expect(r.frontMatter).toBeNull();
    expect(r.frontMatterError).toBe('Front matter must be a YAML mapping (key: value lines).');
  });
});
