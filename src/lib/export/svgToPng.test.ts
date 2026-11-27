import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageToPng, svgSize, svgToPng } from './svgToPng';

// jsdom has no canvas or image decoding, so both are stubbed.
const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

class FakeImage {
  static last: FakeImage | null = null;
  src = '';
  constructor() {
    FakeImage.last = this;
  }
  decode = vi.fn(async () => {});
}

const drawImage = vi.fn();
let canvas: HTMLCanvasElement | null = null;

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvas = this;
    return { drawImage } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG_DATA_URI);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  drawImage.mockClear();
  FakeImage.last = null;
  canvas = null;
});

// As mermaid writes it: 100% wide, capped by style, real size only in the viewBox.
const MERMAID_SVG =
  '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 431px; background-color: white;" ' +
  'viewBox="-8 -8 431 234" role="graphics-document"><text>Label</text></svg>';

function decodedSvg(src: string): string {
  const prefix = 'data:image/svg+xml;base64,';
  expect(src.startsWith(prefix)).toBe(true);
  const bytes = Uint8Array.from(atob(src.slice(prefix.length)), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

describe('svgSize', () => {
  it('reads the viewBox, not the 100% width (Ruling 316)', () => {
    expect(svgSize(MERMAID_SVG)).toEqual({ width: 431, height: 234 });
  });

  it('falls back to numeric width and height', () => {
    expect(svgSize('<svg width="120" height="40px"></svg>')).toEqual({ width: 120, height: 40 });
  });

  it('is null with no size at all', () => {
    expect(svgSize('<svg width="100%"></svg>')).toBeNull();
  });

  it('prefers a numeric width and height to the viewBox, as Word does (Ruling 326)', () => {
    expect(svgSize('<svg width="512" height="256" viewBox="0 0 24 24"></svg>')).toEqual({ width: 512, height: 256 });
  });

  it('takes a missing width or height from the viewBox\'s aspect', () => {
    expect(svgSize('<svg width="100" viewBox="0 0 50 25"></svg>')).toEqual({ width: 100, height: 50 });
    expect(svgSize('<svg height="100%" viewBox="0 0 50 25"></svg>')).toEqual({ width: 50, height: 25 });
  });

  it.each([
    ['an infinite viewBox', '<svg viewBox="0 0 1e400 1e400"></svg>'],
    ['a zero viewBox', '<svg viewBox="0 0 0 10"></svg>'],
    ['a zero width', '<svg width="0" height="10"></svg>'],
  ])('is null for %s (Ruling 326)', (_name, svg) => {
    expect(svgSize(svg)).toBeNull();
  });
});

describe('svgToPng', () => {
  it('draws from a data: URI at the viewBox size times the scale, and returns the PNG bytes', async () => {
    const createObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }));

    const png = await svgToPng(MERMAID_SVG, 2);

    const svg = decodedSvg(FakeImage.last!.src);
    expect(svg).toMatch(/^<svg [^>]*width="431" height="234"/);
    expect(svg).not.toContain('100%');
    expect(svg).not.toContain('max-width');
    expect(svg).toContain('background-color: white');
    expect(svg).toContain('<text>Label</text>');
    expect(FakeImage.last!.decode).toHaveBeenCalled();
    expect([canvas!.width, canvas!.height]).toEqual([862, 468]);
    expect(drawImage).toHaveBeenCalledWith(FakeImage.last, 0, 0, 862, 468);
    expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    // A blob: URL taints the canvas when the SVG has foreignObject (Ruling 315).
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('keeps non-ASCII label text intact', async () => {
    await svgToPng('<svg viewBox="0 0 10 10"><text>Café ✓</text></svg>', 1);
    expect(decodedSvg(FakeImage.last!.src)).toContain('Café ✓');
  });

  it('rejects an SVG with no size', async () => {
    await expect(svgToPng('<svg></svg>', 2)).rejects.toThrow();
    await expect(svgToPng('<svg viewBox="0 0 1e400 1e400"></svg>', 2)).rejects.toThrow();
  });

  it('draws at the stated size with the viewBox and preserveAspectRatio kept, so nothing stretches (Ruling 326)', async () => {
    await svgToPng('<svg width="512" height="256" viewBox="0 0 24 24" preserveAspectRatio="xMinYMin meet"></svg>', 2);

    const svg = decodedSvg(FakeImage.last!.src);
    expect(svg).toMatch(/^<svg [^>]*width="512" height="256"/);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('preserveAspectRatio="xMinYMin meet"');
    expect([canvas!.width, canvas!.height]).toEqual([1024, 512]);
  });

  it('caps the canvas at 8192 px on its long side (Ruling 326)', async () => {
    await svgToPng('<svg viewBox="0 0 20000 10000"></svg>', 2);
    expect([canvas!.width, canvas!.height]).toEqual([8192, 4096]);
  });

  it('rejects an empty canvas result (Ruling 326)', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue('data:,');
    await expect(svgToPng(MERMAID_SVG, 2)).rejects.toThrow();
  });

  it('rejects when the canvas is tainted', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => {
      throw new DOMException('tainted', 'SecurityError');
    });
    await expect(svgToPng(MERMAID_SVG, 2)).rejects.toThrow('tainted');
  });
});

describe('imageToPng', () => {
  it('draws a data: URI at the given size', async () => {
    const png = await imageToPng('data:image/webp;base64,UklGRg==', 30, 20);

    expect(FakeImage.last!.src).toBe('data:image/webp;base64,UklGRg==');
    expect([canvas!.width, canvas!.height]).toEqual([30, 20]);
    expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it('caps a large image at 8192 px too', async () => {
    await imageToPng('data:image/webp;base64,UklGRg==', 10000, 5000);
    expect([canvas!.width, canvas!.height]).toEqual([8192, 4096]);
  });
});
