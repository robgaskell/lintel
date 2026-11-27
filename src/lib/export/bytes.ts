/** The bytes a `data:` URI holds; base64 or percent-encoded. Never fetched: the CSP blocks fetch(data:) (Ruling 315). */
export function dataUriToBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (!/^data:/i.test(uri) || comma === -1) throw new Error('Not a data: URI.');
  const header = uri.slice(0, comma);
  const data = uri.slice(comma + 1);
  if (/;base64$/i.test(header)) return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new TextEncoder().encode(decodeURIComponent(data));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: spreading megabytes into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
