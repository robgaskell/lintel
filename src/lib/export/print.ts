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

let shown: { docId: string; text: string; root: HTMLElement } | null = null;

/**
 * Prints the doc as the preview shows it, in the light palette. The root stays in the page
 * after print returns, since macOS returns before its dialog even opens (Rulings 294, 302).
 */
export async function printDoc(doc: DocState, opts: { pdfHint: boolean }): Promise<void> {
  if (opts.pdfHint) await message(PDF_HINTS[currentPlatform()], { title: 'Export as PDF', kind: 'info' });
  dropPrintRoot();
  const root = document.createElement('div');
  root.className = 'print-root';
  for (const [name, value] of Object.entries(cssVariables(settings, 'light'))) root.style.setProperty(name, value);
  root.style.colorScheme = 'light';
  document.body.append(root);
  shown = { docId: doc.id, text: doc.text, root };
  try {
    await renderFrozen(doc, root);
  } catch (err) {
    if (shown?.root === root) dropPrintRoot();
    throw err;
  }
  // Replaced by a later print, or dropped as stale.
  if (shown?.root !== root) return;
  // On macOS Tauri's override returns a promise, which rejects without core:webview:allow-print.
  await (window.print() as unknown);
}

/**
 * Renders the doc's preview in print mode into `host`, which must be in the page so Mermaid
 * draws, then leaves only a static copy there: no effects, loaders or fetches. Returns its HTML.
 */
export async function renderFrozen(doc: Pick<DocState, 'id' | 'path' | 'text'>, host: HTMLElement): Promise<string> {
  const result = renderMarkdown(doc.text);
  const preview = mount(Preview, {
    target: host,
    props: { result, docId: doc.id, docPath: doc.path, reading: true, print: true },
  });
  let copy: Node[];
  try {
    flushSync();
    await preview.drawn();
    copy = [...host.childNodes].map((node) => node.cloneNode(true));
  } finally {
    await unmount(preview);
  }
  host.replaceChildren(...copy);
  // A copied image decodes again; printing waits until it can be drawn.
  await Promise.all([...host.querySelectorAll('img')].map((img) => img.decode?.().catch(() => {})));
  return host.innerHTML;
}

/** Drops the print root unless `active`, this window's active doc, is the one printed as it was. */
export function dropStalePrintRoot(active: { id: string; text: string } | undefined): void {
  if (shown && (shown.docId !== active?.id || shown.text !== active.text)) dropPrintRoot();
}

function dropPrintRoot() {
  shown?.root.remove();
  shown = null;
}
