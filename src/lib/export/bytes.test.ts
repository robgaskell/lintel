import { describe, expect, it } from 'vitest';
import { bytesToBase64, dataUriToBytes } from './bytes';

describe('dataUriToBytes', () => {
  it('decodes base64', () => {
    expect([...dataUriToBytes('data:image/png;base64,iVBORw==')]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('decodes a percent-encoded URI as UTF-8 text', () => {
    const bytes = dataUriToBytes('data:image/svg+xml;charset=utf-8,%3Csvg%3E%C3%A9%3C/svg%3E');
    expect(new TextDecoder().decode(bytes)).toBe('<svg>é</svg>');
  });

  it('refuses anything else', () => {
    expect(() => dataUriToBytes('https://x.example/a.png')).toThrow();
  });
});

describe('bytesToBase64', () => {
  it('round-trips more than one chunk', () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => i % 251);
    expect([...dataUriToBytes(`data:;base64,${bytesToBase64(bytes)}`)]).toEqual([...bytes]);
  });
});
