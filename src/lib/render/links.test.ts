import { describe, expect, it } from 'vitest';
import {
  classifyHref,
  classifyImageSrc,
  headingIdFor,
  isMarkdownPath,
  resolveTarget,
  webImageUrl,
} from './links';

describe('resolveTarget', () => {
  it('resolves a relative target against the doc folder', () => {
    expect(resolveTarget('/notes/doc.md', 'img/a.png')).toBe('/notes/img/a.png');
    expect(resolveTarget('/notes/doc.md', './a.png')).toBe('/notes/a.png');
  });

  it('collapses .. but never climbs above the root', () => {
    expect(resolveTarget('/notes/sub/doc.md', '../a.md')).toBe('/notes/a.md');
    expect(resolveTarget('/doc.md', '../../a.md')).toBe('/a.md');
  });

  it('keeps a POSIX absolute target, tidied', () => {
    expect(resolveTarget('/notes/doc.md', '/pics//x/../a.png')).toBe('/pics/a.png');
    expect(resolveTarget(null, '/pics/a.png')).toBe('/pics/a.png');
  });

  it('percent-decodes and drops ?query and #fragment', () => {
    expect(resolveTarget('/n/doc.md', 'my%20pic.png?v=2')).toBe('/n/my pic.png');
    expect(resolveTarget('/n/doc.md', 'other.md#intro')).toBe('/n/other.md');
  });

  it('keeps a target whose escapes are broken as written', () => {
    expect(resolveTarget('/n/doc.md', '100%.png')).toBe('/n/100%.png');
  });

  it('cannot resolve a relative target for an unsaved doc', () => {
    expect(resolveTarget(null, 'a.png')).toBeNull();
  });

  it('refuses an empty target and a Windows drive-letter target (Ruling 81)', () => {
    expect(resolveTarget('/n/doc.md', '')).toBeNull();
    expect(resolveTarget('/n/doc.md', '#only-a-fragment')).toBeNull();
    expect(resolveTarget('/n/doc.md', 'C:\\pics\\a.png')).toBeNull();
    expect(resolveTarget('/n/doc.md', 'C:/pics/a.png')).toBeNull();
  });

  it('never resolves to a network path, whatever mix of separators (Ruling 94)', () => {
    const targets = [
      '//evil.example/share/a.png',
      '\\\\evil.example\\share\\a.png',
      '/\\evil.example\\share\\a.png',
      '\\/evil.example/share/a.png',
      '/%5Cevil.example%5Cshare%5Ca.png',
      '\\\\?\\UNC\\evil.example\\share\\a.png',
      '\\\\.\\pipe\\name.png',
      '/\\.\\pipe\\name.png',
    ];
    for (const docPath of ['/notes/doc.md', 'C:\\Users\\a\\doc.md', null]) {
      for (const target of targets) expect(resolveTarget(docPath, target), `${docPath} ${target}`).toBeNull();
    }
  });

  it('gives nothing for any target in a doc that lives on a network share', () => {
    expect(resolveTarget('\\\\server\\share\\doc.md', 'a.png')).toBeNull();
    expect(resolveTarget('//server/share/doc.md', 'a.png')).toBeNull();
  });

  it('reads a backslash in a target as a separator', () => {
    expect(resolveTarget('/notes/doc.md', 'img\\a.png')).toBe('/notes/img/a.png');
    expect(resolveTarget('/notes/doc.md', '/pics\\a.png')).toBe('/pics/a.png');
  });

  it('joins with backslashes under a Windows doc path', () => {
    expect(resolveTarget('C:\\Users\\a\\notes\\doc.md', 'img/a.png')).toBe('C:\\Users\\a\\notes\\img\\a.png');
    expect(resolveTarget('C:\\Users\\a\\doc.md', '../../../../b.md')).toBe('C:\\b.md');
  });
});

describe('classifyHref', () => {
  it('sends web, mail and phone links to the system, with a lower-case scheme', () => {
    expect(classifyHref('https://example.com/a?b=1')).toEqual({ kind: 'external', url: 'https://example.com/a?b=1' });
    expect(classifyHref('HTTP://Example.com')).toEqual({ kind: 'external', url: 'http://example.com/' });
    expect(classifyHref('mailto:a@b.test')).toEqual({ kind: 'external', url: 'mailto:a@b.test' });
    expect(classifyHref('tel:+441234')).toEqual({ kind: 'external', url: 'tel:+441234' });
  });

  it('passes a mailto link on with only its address, subject and body (Ruling 97)', () => {
    expect(classifyHref('mailto:x@y.test?attach=/home/u/.ssh/id_rsa&Subject=Hi%20there&body=Yes&cc=z@y.test')).toEqual({
      kind: 'external',
      url: 'mailto:x@y.test?subject=Hi%20there&body=Yes',
    });
    expect(classifyHref('mailto:x@y.test?attach=/etc/passwd')).toEqual({ kind: 'external', url: 'mailto:x@y.test' });
  });

  it('ignores a mailto address that hides header fields in escapes', () => {
    expect(classifyHref('mailto:x@y.test%3Fattach=/etc/passwd')).toEqual({ kind: 'ignore' });
  });

  it('reads a bare #fragment as an in-page anchor, decoded', () => {
    expect(classifyHref('#intro')).toEqual({ kind: 'anchor', fragment: 'intro' });
    expect(classifyHref('#caf%C3%A9')).toEqual({ kind: 'anchor', fragment: 'café' });
  });

  it('reads anything without a scheme as a file target', () => {
    expect(classifyHref('notes/other.md#sec')).toEqual({ kind: 'file', target: 'notes/other.md#sec' });
    expect(classifyHref('/abs/a.md')).toEqual({ kind: 'file', target: '/abs/a.md' });
  });

  it('ignores other schemes and protocol-relative links', () => {
    expect(classifyHref('ftp://x.test/a')).toEqual({ kind: 'ignore' });
    expect(classifyHref('//x.test/a')).toEqual({ kind: 'ignore' });
    expect(classifyHref('')).toEqual({ kind: 'ignore' });
  });
});

describe('isMarkdownPath', () => {
  it('matches .md and .markdown in any case', () => {
    expect(isMarkdownPath('/a/b.md')).toBe(true);
    expect(isMarkdownPath('/a/b.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('/a/b.mdx')).toBe(false);
    expect(isMarkdownPath('/a/md')).toBe(false);
  });
});

describe('classifyImageSrc', () => {
  it('keeps data URIs, refuses remote and other schemes, and reads the rest as files', () => {
    expect(classifyImageSrc('data:image/png;base64,AAAA')).toBe('data');
    expect(classifyImageSrc('https://x.test/a.png')).toBe('remote');
    expect(classifyImageSrc('//x.test/a.png')).toBe('remote');
    expect(classifyImageSrc('blob:abc')).toBe('remote');
    expect(classifyImageSrc('img/a.png')).toBe('local');
    expect(classifyImageSrc('/abs/a.png')).toBe('local');
  });
});

describe('webImageUrl', () => {
  it('gives the address to fetch for http, https and //host images (Ruling 124)', () => {
    expect(webImageUrl('https://x.test/a b.png')).toBe('https://x.test/a%20b.png');
    expect(webImageUrl('HTTP://x.test/a.png')).toBe('http://x.test/a.png');
    expect(webImageUrl('//x.test/a.png')).toBe('https://x.test/a.png');
  });

  it('gives null for any other source', () => {
    for (const src of ['ftp://x.test/a.png', 'file:///etc/a.png', 'blob:abc', 'javascript:alert(1)', 'img/a.png', 'data:image/png;base64,AA', 'https://']) {
      expect(webImageUrl(src), src).toBeNull();
    }
  });
});

describe('headingIdFor', () => {
  const ids = new Set(['h-intro', 'h-café', 'h-build-matrix', 'h-build-matrix-1']);

  it('finds the h- id for a fragment as written, lower-cased, or slugged', () => {
    expect(headingIdFor('intro', ids)).toBe('h-intro');
    expect(headingIdFor('Intro', ids)).toBe('h-intro');
    expect(headingIdFor('Build Matrix', ids)).toBe('h-build-matrix');
    expect(headingIdFor('build-matrix-1', ids)).toBe('h-build-matrix-1');
    expect(headingIdFor('café', ids)).toBe('h-café');
  });

  it('accepts a fragment that already carries the h- prefix', () => {
    expect(headingIdFor('h-intro', ids)).toBe('h-intro');
  });

  it('gives null for an unknown fragment', () => {
    expect(headingIdFor('nowhere', ids)).toBeNull();
  });
});
