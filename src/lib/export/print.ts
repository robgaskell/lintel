import { flushSync, mount, unmount } from 'svelte';
import { message } from '@tauri-apps/plugin-dialog';
import type { DocState } from '../docs/store.svelte';
import { currentPlatform, type Platform } from '../os/platform';
import { renderMarkdown } from '../render/markdown';
import { settings } from '../settings/settings.svelte';
import { cssVariables } from '../theme/theme';
import Preview from '../ui/Preview.svelte';
import './print.css';

// Each names the PDF option of that OS's print dialog (Ruling 295).
const PDF_HINTS: Record<Platform, string> = {
  macos: 'In the print dialog, choose PDF > Save as PDF.',
  windows: 'In the print dialog, choose Microsoft Print to PDF.',
  linux: 'In the print dialog, choose Print to File, then PDF.',
};

let shown: { docId: string; root: HTMLElement; preview: Record<string, unknown> } | null = null;

/**
 * Prints the doc as the preview shows it, in the light palette. The print root stays in the
 * page after print returns, since macOS returns before its dialog even opens (Ruling 294).
 */
export async function printDoc(doc: DocState, opts: { pdfHint: boolean }): Promise<void> {
  if (opts.pdfHint) await message(PDF_HINTS[currentPlatform()], { title: 'Export as PDF', kind: 'info' });
  const result = renderMarkdown(doc.text);
  dropPrintRoot();
  const root = document.createElement('div');
  root.className = 'print-root';
  for (const [name, value] of Object.entries(cssVariables(settings, 'light'))) root.style.setProperty(name, value);
  root.style.colorScheme = 'light';
  // In the page before rendering: Mermaid skips a detached container.
  document.body.append(root);
  const preview = mount(Preview, {
    target: root,
    props: { result, docId: doc.id, docPath: doc.path, reading: true, print: true },
  });
  shown = { docId: doc.id, root, preview };
  flushSync();
  await preview.drawn();
  // A later print has replaced this one.
  if (shown?.root !== root) return;
  // On macOS Tauri's override returns a promise, which rejects without core:webview:allow-print.
  await (window.print() as unknown);
}

/** `open` is the ids of the docs in this window. */
export function dropPrintRootUnlessOpen(open: ReadonlySet<string>): void {
  if (shown && !open.has(shown.docId)) dropPrintRoot();
}

function dropPrintRoot() {
  if (!shown) return;
  void unmount(shown.preview);
  shown.root.remove();
  shown = null;
}
