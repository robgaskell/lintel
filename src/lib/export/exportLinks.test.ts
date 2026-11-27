import { describe, expect, it } from 'vitest';
import { keepsLink } from './exportLinks';

describe('keepsLink (Rulings 324, 330)', () => {
  it.each([
    'https://example.com/',
    'HTTP://example.com/',
    'mailto:a@example.com',
    'other%20file.md',
    '../up.md',
    '#intro',
    'C:/notes/x.md',
  ])('keeps %s', (href) => {
    expect(keepsLink(href)).toBe(true);
  });

  it.each([
    ['a network path', '//host/share'],
    ['a UNC path', '\\\\host\\share'],
    ['a mixed network path', '/\\host/share'],
    ['a file: URL', 'file:///Users/alice/x'],
    ['javascript:', 'javascript:alert(1)'],
    ['tel:', 'tel:+441234'],
    ['ftp:', 'ftp://host/x'],
    ['a tab inside the scheme', 'java\tscript:alert(1)'],
    ['a percent-encoded UNC path', '%5C%5Chost%5Cx'],
    ['a twice percent-encoded UNC path', '%255C%255Chost/x'],
    ['three times encoded', '%25255C%25255Chost/x'],
    ['a malformed escape', '%5C%5Chost%5Cx%ZZ'],
    ['a malformed UTF-8 escape', '%5C%5Chost%5Cx%E0'],
    ['a leading no-break space', '\u00a0//host/x'],
    ['a leading ideographic space', '\u3000//host/x'],
    ['a zero-width space', '\u200b//host/x'],
    ['fullwidth backslashes', '\uFF3C\uFF3Chost\\x'],
    ['fullwidth slashes', '\uFF0F\uFF0Fhost/x'],
    ['a scheme with a replaced NUL in it', 'fi\ufffdle://host/x'],
    ['a scheme with a space in it', 'fi le://host/x'],
    ['a fullwidth scheme', '\uFF46\uFF49\uFF4C\uFF45://host/x'],
  ])('drops %s', (_name, href) => {
    expect(keepsLink(href)).toBe(false);
  });
});
