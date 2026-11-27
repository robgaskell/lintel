import { bytesToBase64, dataUriToBytes } from './bytes';

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
  return drawPng(src, size.width * scale, size.height * scale);
}

/**
 * The SVG's size in CSS pixels: its viewBox, else numeric width and height.
 * Mermaid sets width="100%", so an image's natural size would be wrong (Ruling 316).
 */
export function svgSize(svg: string): Size | null {
  const tag = rootTag(svg);
  if (tag === null) return null;
  const viewBox = attribute(tag, 'viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }
  const width = pixels(attribute(tag, 'width'));
  const height = pixels(attribute(tag, 'height'));
  return width && height ? { width, height } : null;
}

/** A data: URI image (such as webp) as PNG bytes at the given size. */
export function imageToPng(src: string, width: number, height: number): Promise<Uint8Array> {
  return drawPng(src, width, height);
}

async function drawPng(src: string, width: number, height: number): Promise<Uint8Array> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not draw the image.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Throws a SecurityError if the canvas is tainted.
  return dataUriToBytes(canvas.toDataURL('image/png'));
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
  const n = match ? Number(match[1]) : NaN;
  return n > 0 ? n : null;
}

// Fixed width and height, and no max-width, so the image draws at the viewBox size.
function withSize(svg: string, size: Size): string {
  const tag = rootTag(svg)!;
  const sized = tag
    .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/max-width\s*:\s*[^;"']*;?\s*/gi, '')
    .replace(/^<svg\b/i, `<svg width="${size.width}" height="${size.height}"`);
  return svg.replace(tag, () => sized);
}
