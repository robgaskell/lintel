// The core JS API has no OS call and plugin-os is not installed, so the user agent decides.
export type Platform = 'macos' | 'windows' | 'linux';

export function isMac(): boolean {
  return /Mac/.test(navigator.userAgent);
}

export function isLinux(): boolean {
  return /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
}

export function currentPlatform(): Platform {
  if (isMac()) return 'macos';
  return isLinux() ? 'linux' : 'windows';
}
