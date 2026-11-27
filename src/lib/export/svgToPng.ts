import { bytesToBase64, dataUriToBytes } from './bytes';

// WebKit gives an empty result past its canvas limit; this stays well inside it (Ruling 326).
const MAX_SIDE = 8192;

export interface Size {
  width: number;
  height: number;
}

/**
 * Draws `svg` on a canvas at `scale` times its size (see svgSize) and returns PNG bytes.
 * Loaded from a data: URI: a blob: URL taints the canvas when the SVG has foreignObject (Ruling 315).
 */
export async function svgToPng(svg: string, scale: number): Promise<Uint8Array> {
  const size = await svgSize(svg);
  if (size === null) throw new Error('The image has no size.');
  const sized = withSize(svg, size);
  const src = `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(sized))}`;
  return drawPng(src, size, scale);
}

/**
 * The SVG's size in CSS pixels, read by image-size as remark-docx reads it for the picture's
 * size in Word, so the PNG is drawn at exactly that size (Ruling 330). Null when it has no
 * finite, non-zero size. Mermaid sets width="100%", so its size is the viewBox.
 */
export async function svgSize(svg: string): Promise<Size | null> {
  const { imageSize } = await import('image-size');
  try {
    const { type, width, height } = imageSize(new TextEncoder().encode(svg));
    return type === 'svg' && isSize(width) && isSize(height) ? { width, height } : null;
  } catch {
    return null; // image-size could not read it, so neither can remark-docx
  }
}

/** A data: URI image (such as webp) as PNG bytes at the given size. */
export function imageToPng(src: string, width: number, height: number): Promise<Uint8Array> {
  return drawPng(src, { width, height }, 1);
}

async function drawPng(src: string, size: Size, scale: number): Promise<Uint8Array> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const factor = Math.min(scale, MAX_SIDE / Math.max(size.width, size.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.width * factor));
  canvas.height = Math.max(1, Math.round(size.height * factor));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not draw the image.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Throws a SecurityError if the canvas is tainted.
  const png = canvas.toDataURL('image/png');
  if (!png.startsWith('data:image/png')) throw new Error('The picture could not be drawn.');
  return dataUriToBytes(png);
}

// image-size's own pattern, so the tag changed is the one it read.
const ROOT_TAG = /<svg\s([^>"']|"[^"]*"|'[^']*')*>/;

function isSize(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n > 0;
}

// Fixed width and height, and no max-width, so the image draws at `size`; the viewBox and
// preserveAspectRatio stay, so the drawing keeps its aspect.
function withSize(svg: string, size: Size): string {
  const tag = ROOT_TAG.exec(svg)![0];
  const sized = tag
    .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/max-width\s*:\s*[^;"']*;?\s*/gi, '')
    .replace(/^<svg\b/i, `<svg width="${size.width}" height="${size.height}"`);
  return svg.replace(tag, () => sized);
}
