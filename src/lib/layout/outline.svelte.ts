/**
 * Whether this window shows the outline panel. Each window has its own webview, so
 * module state is per window. M4.4 persists it as WindowSession.outlineVisible.
 */
export const outline = $state({ visible: true });
