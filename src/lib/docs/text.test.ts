import { describe, expect, it } from 'vitest';
import { detectLineEnding, toBuffer, toDisk } from './text';

describe('detectLineEnding', () => {
  it('picks CRLF when most lines end in CRLF', () => {
    expect(detectLineEnding('a\r\nb\r\nc\n')).toBe('\r\n');
  });

  it('picks LF when most lines end in LF', () => {
    expect(detectLineEnding('a\nb\nc\r\n')).toBe('\n');
  });

  it('gives a tie to LF', () => {
    expect(detectLineEnding('a\r\nb\n')).toBe('\n');
  });

  it('counts a lone CR with LF', () => {
    expect(detectLineEnding('a\rb\rc\r\n')).toBe('\n');
    expect(detectLineEnding('a\rb\r\nc\r\nd\r\n')).toBe('\r\n');
  });

  it('gives a file with no newline LF', () => {
    expect(detectLineEnding('abc')).toBe('\n');
    expect(detectLineEnding('')).toBe('\n');
  });
});

describe('toBuffer', () => {
  it('turns CRLF into LF', () => {
    expect(toBuffer('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('turns a lone CR into LF', () => {
    expect(toBuffer('a\rb\r\nc\r')).toBe('a\nb\nc\n');
  });

  it('leaves LF text alone', () => {
    expect(toBuffer('a\nb\n')).toBe('a\nb\n');
  });
});

describe('toDisk', () => {
  it('writes LF text with CRLF when asked', () => {
    expect(toDisk('a\nbc\n', '\r\n')).toBe('a\r\nbc\r\n');
  });

  it('writes LF text unchanged for LF', () => {
    expect(toDisk('a\nbc\n', '\n')).toBe('a\nbc\n');
  });
});

describe('round trip', () => {
  const samples = {
    'CRLF with trailing newline': '# Title\r\n\r\nBody line\r\n',
    'CRLF without trailing newline': '# Title\r\n\r\nBody line',
    'LF with trailing newline': '# Title\n\nBody line\n',
    'LF without trailing newline': '# Title\n\nBody line',
  };

  for (const [name, x] of Object.entries(samples)) {
    it(`restores ${name} exactly`, () => {
      expect(toDisk(toBuffer(x), detectLineEnding(x))).toBe(x);
    });
  }
});
