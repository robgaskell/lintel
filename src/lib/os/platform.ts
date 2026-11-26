// The core JS API has no OS call and plugin-os is not installed; WKWebView's agent says "Macintosh".
export function isMac(): boolean {
  return /Mac/.test(navigator.userAgent);
}
