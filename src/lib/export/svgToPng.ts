import { bytesToBase64, dataUriToBytes } from './bytes';

// WebKit gives an empty result past its canvas limit; this stays well inside it (Ruling 326).
const MAX_SIDE = 8192;

export interface Size {
  width: number;
  height: number;
}

/**
 * Draws `svg` on a canvas at `scale` times its viewBox size and returns PNG bytes.
 * Loaded from a data: URI: a blob: URL taints the canvas when the SVG has foreignObject (Ruling 315).
 */
export async function svgToPng(svg: string, scale: number): Promise<Uint8Array> {
  const size = svgSize(svg);
  if (size === null) throw new Error('The image has no size.');
  const sized = withSize(svg, size);
  const src = `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(sized))}`;
  return drawPng(src, size, scale);
}

/**
 * The SVG's size in CSS pixels, as Word reads it: numeric width and height, a missing one
 * taken from the viewBox's aspect, else the viewBox. Mermaid sets width="100%", so its size
 * is the viewBox (Rulings 316, 326). Null when there is no finite, non-zero size.
 */
export function svgSize(svg: string): Size | null {
  const tag = rootTag(svg);
  if (tag === null) return null;
  const box = viewBox(attribute(tag, 'viewBox'));
  const width = pixels(attribute(tag, 'width'));
  const height = pixels(attribute(tag, 'height'));
  if (width && height) return { width, height };
  if (box === null) return null;
  if (width) return { width, height: (width * box.height) / box.width };
  if (height) return { width: (height * box.width) / box.height, height };
  return box;
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

function rootTag(svg: string): string | null {
  return /<svg\b[^>]*>/i.exec(svg)?.[0] ?? null;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[2] ?? match[3]) : undefined;
}

function pixels(value: string | undefined): number | null {
  const match = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value ?? '');
  return positive(match ? Number(match[1]) : NaN);
}

function viewBox(value: string | undefined): Size | null {
  const parts = value?.trim().split(/[\s,]+/).map(Number) ?? [];
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const width = positive(parts[2]!);
  const height = positive(parts[3]!);
  return width && height ? { width, height } : null;
}

function positive(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Fixed width and height, and no max-width, so the image draws at `size`; the viewBox and
// preserveAspectRatio stay, so the drawing keeps its aspect.
function withSize(svg: string, size: Size): string {
  const tag = rootTag(svg)!;
  const sized = tag
    .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/max-width\s*:\s*[^;"']*;?\s*/gi, '')
    .replace(/^<svg\b/i, `<svg width="${size.width}" height="${size.height}"`);
  return svg.replace(tag, () => sized);
}
