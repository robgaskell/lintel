import {
  createDockview,
  type DockviewApi,
  type IContentRenderer,
  type ITabRenderer,
  type SerializedDockview,
} from 'dockview-core';
import { mount, unmount } from 'svelte';
import { EditorView } from '@codemirror/view';
import { closeDocWithPrompt, docs, type DocState } from '../docs/store.svelte';
import { resolvedTheme, type ResolvedTheme } from '../theme/theme';
import DocPane from './DocPane.svelte';
import Tab from './Tab.svelte';
import './vendor/dockview.css';

// Only the id goes in params: dockview serialises params into the saved layout.
interface PanelParams {
  docId: string;
}

type GridNode =
  | { type: 'branch'; data: GridNode[] }
  | { type: 'leaf'; data: { views: string[] } };

const COMPONENT = 'doc';

function dockTheme(theme: ResolvedTheme) {
  return { name: `lintel-${theme}`, className: `dockview-theme-${theme} lintel-dock` };
}

/** The tabbed editor groups of one window, one panel per open doc (panel id = doc id). */
export class Workspace {
  private readonly api: DockviewApi;
  private readonly panes = new Map<string, HTMLElement>();
  private readonly closing = new Map<string, Promise<boolean>>();
  private readonly focusListener: { dispose(): void };
  private readonly stopTheme: () => void;
  private readonly onKeydown = (e: KeyboardEvent) => this.closeTabFromKeyboard(e);

  constructor(private readonly el: HTMLElement) {
    this.api = createDockview(el, {
      theme: dockTheme('light'),
      disableFloatingGroups: true,
      defaultTabComponent: COMPONENT,
      createComponent: () => this.createPane(),
      createTabComponent: () => this.createTab(),
    });
    this.focusListener = this.api.onDidActivePanelChange((e) => {
      if (e.panel) this.focusEditor(e.panel.id);
    });
    // Dockview's own overlay colours (drag targets, scrollbars) follow the app theme.
    this.stopTheme = resolvedTheme.subscribe((theme) => this.api.updateOptions({ theme: dockTheme(theme) }));
    // Capture phase, so this runs before dockview's own tab-list key handler.
    el.addEventListener('keydown', this.onKeydown, true);
  }

  openDoc(doc: DocState, opts?: { referenceId?: string; direction?: 'right' | 'below' }): void {
    if (this.api.getPanel(doc.id)) {
      this.activate(doc.id);
      return;
    }
    const params: PanelParams = { docId: doc.id };
    this.api.addPanel({
      id: doc.id,
      component: COMPONENT,
      title: doc.title,
      params,
      position: opts?.referenceId
        ? { referencePanel: opts.referenceId, direction: opts.direction ?? 'within' }
        : undefined,
    });
  }

  activate(id: string): void {
    this.api.getPanel(id)?.api.setActive();
    // Re-activating the active panel fires no event, but the editor should still get focus.
    this.focusEditor(id);
  }

  /** False when the user cancels the prompt or the save fails; the tab then stays. */
  closeDoc(id: string): Promise<boolean> {
    const running = this.closing.get(id);
    if (running) return running;
    const promise = this.runClose(id).finally(() => this.closing.delete(id));
    this.closing.set(id, promise);
    return promise;
  }

  activeDocId(): string | null {
    return this.api.activePanel?.id ?? null;
  }

  /** Left to right and top to bottom across groups, then tab order within each group. */
  docIdsInOrder(): string[] {
    const root = this.api.toJSON().grid.root as unknown as GridNode;
    return leafViews(root);
  }

  toJSON(): unknown {
    return this.api.toJSON();
  }

  /** Every doc the layout names must already be in `docs`; panels for missing docs are dropped. */
  fromJSON(layout: unknown): void {
    this.api.fromJSON(layout as SerializedDockview);
    for (const panel of [...this.api.panels]) {
      if (!docs.has(panel.id)) this.api.removePanel(panel);
    }
  }

  onActiveChange(cb: (id: string | null) => void): () => void {
    const listener = this.api.onDidActivePanelChange((e) => cb(e.panel?.id ?? null));
    return () => listener.dispose();
  }

  /** The tab reads the title live; this keeps the title dockview stores in the layout current. */
  refreshTab(id: string): void {
    const doc = docs.get(id);
    if (doc) this.api.getPanel(id)?.api.setTitle(doc.title);
  }

  dispose(): void {
    this.el.removeEventListener('keydown', this.onKeydown, true);
    this.focusListener.dispose();
    this.stopTheme();
    this.api.dispose();
  }

  private async runClose(id: string): Promise<boolean> {
    if (docs.has(id) && !(await closeDocWithPrompt(id))) return false;
    const panel = this.api.getPanel(id);
    if (panel) this.api.removePanel(panel);
    return true;
  }

  // dockview closes a focused tab on Delete or Backspace by removing its panel, which would
  // skip the unsaved-changes prompt and leave the doc in `docs` with no tab.
  private closeTabFromKeyboard(e: KeyboardEvent): void {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const tab = e.target instanceof Element ? e.target.closest('.dv-tab') : null;
    const id = tab?.querySelector<HTMLElement>('.lintel-tab')?.dataset.docId;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    void this.closeDoc(id);
  }

  private createPane(): IContentRenderer {
    const element = document.createElement('div');
    element.style.height = '100%';
    let component: ReturnType<typeof mount> | null = null;
    let docId: string | null = null;
    return {
      element,
      init: ({ params }) => {
        docId = (params as unknown as PanelParams).docId;
        const doc = docs.get(docId);
        if (!doc) return;
        this.panes.set(docId, element);
        component = mount(DocPane, { target: element, props: { doc } });
      },
      dispose: () => {
        if (component) unmount(component);
        if (docId) this.panes.delete(docId);
      },
    };
  }

  private createTab(): ITabRenderer {
    const element = document.createElement('div');
    element.style.height = '100%';
    let component: ReturnType<typeof mount> | null = null;
    return {
      element,
      init: ({ params }) => {
        const docId = (params as unknown as PanelParams).docId;
        const doc = docs.get(docId);
        if (!doc) return;
        component = mount(Tab, {
          target: element,
          props: { doc, onClose: () => void this.closeDoc(docId) },
        });
      },
      dispose: () => {
        if (component) unmount(component);
      },
    };
  }

  // Deferred: the editor may not be mounted yet, and a tab click focuses the tab after this runs.
  private focusEditor(id: string): void {
    setTimeout(() => {
      if (this.activeDocId() !== id) return;
      const editor = this.panes.get(id)?.querySelector<HTMLElement>('.cm-editor');
      if (editor) EditorView.findFromDOM(editor)?.focus();
    }, 0);
  }
}

function leafViews(node: GridNode): string[] {
  if (node.type === 'leaf') return [...node.data.views];
  return node.data.flatMap(leafViews);
}
