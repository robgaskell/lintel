import {
  createDockview,
  type DockviewApi,
  type DockviewGroupPanel,
  type IContentRenderer,
  type ITabRenderer,
  type SerializedDockview,
} from 'dockview-core';
import { mount, unmount } from 'svelte';
import { EditorView } from '@codemirror/view';
import {
  closeDocWithPrompt,
  confirmCloseAll,
  docs,
  handoffsSettled,
  removeDoc,
  type DocState,
} from '../docs/store.svelte';
import { resolvedTheme, type ResolvedTheme } from '../theme/theme';
import DocPane, { PANE_MOVED } from './DocPane.svelte';
import Tab from './Tab.svelte';
import { attachTabMenu, tabDocId } from './tabMenu';
import './vendor/dockview.css';
import './workspace.css';

// Only the id goes in params: dockview serialises params into the saved layout.
interface PanelParams {
  docId: string;
}

type GridNode =
  | { type: 'branch'; data: GridNode[] }
  | { type: 'leaf'; data: { views: string[]; activeView?: string } };

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
  private readonly moveListener: { dispose(): void };
  private readonly stopTheme: () => void;
  private readonly detachTabMenu: () => void;
  private readonly onKeydown = (e: KeyboardEvent) => this.closeTabFromKeyboard(e);
  private readonly onClick = (e: MouseEvent) => this.selectTabOnClick(e);
  private readonly onPointerDown = (e: PointerEvent) => this.activateGroupUnderPointer(e);
  private sorting = false;
  private pointerActivating = false;

  constructor(private readonly el: HTMLElement) {
    this.api = createDockview(el, {
      theme: dockTheme('light'),
      disableFloatingGroups: true,
      defaultTabComponent: COMPONENT,
      createComponent: () => this.createPane(),
      createTabComponent: () => this.createTab(),
    });
    this.focusListener = this.api.onDidActivePanelChange((e) => {
      if (e.panel && !this.pointerActivating) this.focusEditor(e.panel.id);
    });
    // Dockview's own overlay colours (drag targets, scrollbars) follow the app theme.
    this.stopTheme = resolvedTheme.subscribe((theme) => this.api.updateOptions({ theme: dockTheme(theme) }));
    this.moveListener = this.api.onDidMovePanel((e) => {
      // A drag or a drop into a group can put an unpinned tab left of a pinned one.
      this.sortPinnedFirst(e.panel.group);
      // The pane left the page during the move, which reset its scroll.
      this.panes.get(e.panel.id)?.querySelector('[data-doc-pane]')?.dispatchEvent(new Event(PANE_MOVED));
    });
    // Capture phase, so this runs before dockview's own tab-list key handler.
    el.addEventListener('keydown', this.onKeydown, true);
    el.addEventListener('click', this.onClick);
    el.addEventListener('pointerdown', this.onPointerDown);
    this.detachTabMenu = attachTabMenu(el, this);
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
    // A doc already gone, as one handed to another window, leaves its tab at once.
    if (!docs.has(id)) {
      this.removePanel(id);
      return Promise.resolve(true);
    }
    const running = this.closing.get(id);
    if (running) return running;
    const promise = this.runClose(id).finally(() => this.closing.delete(id));
    this.closing.set(id, promise);
    return promise;
  }

  /** Pinned tabs sort to the left of their group, keeping their relative order. */
  setPinned(id: string, pinned: boolean): void {
    const doc = docs.get(id);
    if (!doc) return;
    doc.pinned = pinned;
    const panel = this.api.getPanel(id);
    if (panel) this.sortPinnedFirst(panel.group);
  }

  /**
   * Closes the other unpinned tabs in the group of `id`, after one round of prompts
   * (Rulings 166, 172).
   */
  closeOthers(id: string): Promise<void> {
    return this.closeUnpinned(this.groupDocIds(id).filter((other) => other !== id));
  }

  /** Closes the unpinned tabs in the group of `id`, or of the active tab (Rulings 166, 172). */
  closeAll(id?: string): Promise<void> {
    return this.closeUnpinned(this.groupDocIds(id));
  }

  /**
   * Moves the tab into a new group on that side of its own. Moving, not copying, keeps a
   * doc in one place (Ruling 178). A tab alone in its group stays put.
   */
  split(id: string, direction: 'right' | 'below'): void {
    const panel = this.api.getPanel(id);
    if (!panel || panel.group.panels.length < 2) return;
    // moveTo takes a Position, which says 'bottom' where addPanel's Direction says 'below'.
    panel.api.moveTo({ group: panel.group, position: direction === 'right' ? 'right' : 'bottom' });
  }

  groupCount(): number {
    return this.api.groups.length;
  }

  isAloneInGroup(id: string): boolean {
    return this.api.getPanel(id)?.group.panels.length === 1;
  }

  /** Activates the next tab of the active group in visible order, wrapping at the end. */
  nextTab(): void {
    this.stepTab(1);
  }

  previousTab(): void {
    this.stepTab(-1);
  }

  activeDocId(): string | null {
    return this.api.activePanel?.id ?? null;
  }

  /** Whether a group shows the doc's tab now, active group or not. */
  isVisible(id: string): boolean {
    const panel = this.api.getPanel(id);
    return panel !== undefined && panel.group.activePanel === panel;
  }

  /** Left to right and top to bottom across groups, then tab order within each group. */
  docIdsInOrder(): string[] {
    const root = this.api.toJSON().grid.root as unknown as GridNode;
    return leafViews(root);
  }

  toJSON(): unknown {
    return this.api.toJSON();
  }

  /**
   * Every doc the layout names must already be in `docs`; panels for missing docs are dropped.
   * A doc in `docs` that the layout leaves out keeps a tab, even when the layout is rejected.
   */
  fromJSON(layout: unknown): void {
    try {
      this.api.fromJSON(layout as SerializedDockview);
    } finally {
      for (const panel of [...this.api.panels]) {
        if (!docs.has(panel.id)) this.api.removePanel(panel);
      }
      for (const doc of docs.values()) {
        if (!this.api.getPanel(doc.id)) this.openDoc(doc);
      }
    }
  }

  onActiveChange(cb: (id: string | null) => void): () => void {
    const listener = this.api.onDidActivePanelChange((e) => cb(e.panel?.id ?? null));
    return () => listener.dispose();
  }

  /** Calls `cb` after tabs or groups are added, removed, moved, switched or resized, once per burst. */
  onLayoutChange(cb: () => void): () => void {
    const listener = this.api.onDidLayoutChange(() => cb());
    return () => listener.dispose();
  }

  /** The tab reads the title live; this keeps the title dockview stores in the layout current. */
  refreshTab(id: string): void {
    const doc = docs.get(id);
    if (doc) this.api.getPanel(id)?.api.setTitle(doc.title);
  }

  dispose(): void {
    this.el.removeEventListener('keydown', this.onKeydown, true);
    this.el.removeEventListener('click', this.onClick);
    this.el.removeEventListener('pointerdown', this.onPointerDown);
    this.detachTabMenu();
    this.focusListener.dispose();
    this.moveListener.dispose();
    this.stopTheme();
    this.api.dispose();
  }

  private async runClose(id: string): Promise<boolean> {
    // A tab on its way to another window is never asked about (Ruling 217).
    await handoffsSettled();
    if (docs.has(id) && !(await closeDocWithPrompt(id))) return false;
    this.removePanel(id);
    return true;
  }

  private removePanel(id: string): void {
    const panel = this.api.getPanel(id);
    if (panel) this.api.removePanel(panel);
  }

  // Cancel at any prompt closes nothing, as with Quit (Ruling 32).
  private async closeUnpinned(ids: string[]): Promise<void> {
    // As in runClose: a tab on its way to another window is never asked about.
    await handoffsSettled();
    const targets = ids.filter((id) => docs.has(id) && !docs.get(id)?.pinned);
    if (!(await confirmCloseAll(targets, (id) => this.activate(id)))) return;
    for (const id of targets) {
      // Already asked: a Don't Save answer leaves the doc dirty, so closeDoc would ask again.
      removeDoc(id);
      const panel = this.api.getPanel(id);
      if (panel) this.api.removePanel(panel);
    }
  }

  private groupDocIds(id?: string): string[] {
    const group = id === undefined ? this.api.activeGroup : this.api.getPanel(id)?.group;
    return group?.panels.map((panel) => panel.id) ?? [];
  }

  private stepTab(step: 1 | -1): void {
    const group = this.api.activeGroup;
    const panels = group?.panels ?? [];
    const current = group?.activePanel;
    if (panels.length < 2 || !current) return;
    const index = panels.indexOf(current);
    this.activate(panels[(index + step + panels.length) % panels.length].id);
  }

  private sortPinnedFirst(group: DockviewGroupPanel): void {
    // Each moveTo below fires onDidMovePanel, which calls back here.
    if (this.sorting) return;
    const isPinned = (id: string) => docs.get(id)?.pinned === true;
    const panels = group.panels;
    const order = [...panels.filter((p) => isPinned(p.id)), ...panels.filter((p) => !isPinned(p.id))];
    if (order.every((panel, i) => panel === panels[i])) return;
    const active = this.api.activePanel;
    this.sorting = true;
    try {
      order.forEach((panel, i) => {
        if (group.panels[i] === panel) return;
        // Moving the group's shown tab without activating it would show a neighbour instead;
        // activating any other tab would show that one (Ruling 175).
        panel.api.moveTo({ group, index: i, skipSetActive: panel !== group.activePanel });
      });
    } finally {
      this.sorting = false;
    }
    // Moving a group's shown tab also makes that group the active one.
    if (active && this.api.activePanel !== active) active.api.setActive();
  }

  // dockview closes a focused tab on Delete or Backspace by removing its panel, which would
  // skip the unsaved-changes prompt and leave the doc in `docs` with no tab.
  private closeTabFromKeyboard(e: KeyboardEvent): void {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const id = tabDocId(e.target);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    // A pinned tab has no close button, so the keys do nothing either (Ruling 48).
    if (docs.get(id)?.pinned) return;
    void this.closeDoc(id);
  }

  // A press on a group's preview moves no focus, so dockview would leave the group inactive.
  private activateGroupUnderPointer(e: PointerEvent): void {
    const pane = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-doc-pane]') : null;
    const panel = pane?.dataset.docPane ? this.api.getPanel(pane.dataset.docPane) : undefined;
    if (!panel || panel === this.api.activePanel) return;
    // Focus stays where the press puts it, so a press in the preview keeps its selection.
    this.pointerActivating = true;
    try {
      panel.api.setActive();
    } finally {
      this.pointerActivating = false;
    }
  }

  // dockview selects on pointerdown only, so a click with no pointer (an accessibility
  // press) would do nothing; the close button stops its own click (Rulings 135, 168).
  private selectTabOnClick(e: MouseEvent): void {
    const id = tabDocId(e.target);
    if (id && id !== this.activeDocId()) this.activate(id);
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
