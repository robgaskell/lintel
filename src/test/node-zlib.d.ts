// The one node:zlib call the tests use to read zip files; @types/node is not a dependency.
declare module 'node:zlib' {
  export function inflateRawSync(data: Uint8Array): Uint8Array;
}
