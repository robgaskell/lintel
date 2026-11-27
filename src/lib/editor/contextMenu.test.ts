import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { history } from '@codemirror/commands';
import { EditorState, StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Menu } from '@tauri-apps/api/menu';
import { lockExtension } from './setup';

// Models Tauri: one app-wide id -> handler map; a later item with the same id replaces
// the handler, and closing a menu removes its ids whoever owns them now.
const tauri = vi.hoisted(() => ({ channels: new Map<string, (id: string) => void>() }));

type Item = { id?: string; action?: (id: string) => void };

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: vi.fn(async ({ items }: { items: Item[] }) => {
      for (const item of items) {
        if (item.id && item.action) tauri.channels.set(item.id, item.action);
      }
      return {
        popup: vi.fn(async () => {}),
        close: vi.fn(async () => {
          for (const item of items) if (item.id) tauri.channels.delete(item.id);
        }),
      };
    }),
  },
}));

let attachEditorContextMenu: typeof import('./contextMenu').attachEditorContextMenu;
const views: EditorView[] = [];

function editor(text: string): EditorView {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text }) });
  view.dispatch({ selection: { anchor: 0, head: text.length } });
  views.push(view);
  return view;
}

/** An editor with history whose last edit added "!" to "alpha". */
function edited(extensions: Extension[] = []): EditorView {
  const state = EditorState.create({ doc: 'alpha', extensions: [history()] });
  const view = new EditorView({ parent: document.body, state });
  view.dispatch({ changes: { from: 5, insert: '!' } });
  view.dispatch({ effects: StateEffect.appendConfig.of(extensions) });
  views.push(view);
  return view;
}

async function rightClick(view: EditorView): Promise<MouseEvent> {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  await vi.waitFor(() => expect(Menu.new).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return event;
}

function click(id: string): void {
  tauri.channels.get(id)?.(id);
}

beforeEach(async () => {
  // The menu is app-wide, so each test needs a fresh module.
  vi.resetModules();
  vi.mocked(Menu.new).mockClear();
  tauri.channels.clear();
  ({ attachEditorContextMenu } = await import('./contextMenu'));
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe('editor context menu', () => {
  it('acts on the editor that was right-clicked last', async () => {
    const a = editor('alpha');
    const b = editor('beta');
    attachEditorContextMenu(a);
    attachEditorContextMenu(b);

    await rightClick(b);
    await rightClick(a);
    await rightClick(b);
    click('bold');

    expect(b.state.doc.toString()).toBe('**beta**');
    expect(a.state.doc.toString()).toBe('alpha');
  });

  it('keeps working in one editor after another is detached', async () => {
    const a = editor('alpha');
    const b = editor('beta');
    const detachA = attachEditorContextMenu(a);
    attachEditorContextMenu(b);

    await rightClick(a);
    await rightClick(b);
    detachA();
    await rightClick(b);
    click('italic');

    expect(b.state.doc.toString()).toBe('*beta*');
  });

  // Spec end state 6: undo and redo work from the context menu too.
  it('undoes and redoes the last edit in the right-clicked editor', async () => {
    const view = edited();
    attachEditorContextMenu(view);

    await rightClick(view);
    click('undo');
    expect(view.state.doc.toString()).toBe('alpha');
    click('redo');
    expect(view.state.doc.toString()).toBe('alpha!');
  });

  it('lists Undo and Redo first, then the clipboard items', async () => {
    attachEditorContextMenu(editor('alpha'));

    await rightClick(views[0]);

    const items = vi.mocked(Menu.new).mock.calls[0][0]!.items as { text?: string; item?: string }[];
    const names = items.map((i) => i.text ?? i.item);
    expect(names.slice(0, 4)).toEqual(['Undo', 'Redo', 'Separator', 'Cut']);
  });

  it('undoes nothing while the editor is locked for an update', async () => {
    const view = edited([lockExtension(true)]);
    attachEditorContextMenu(view);

    await rightClick(view);
    click('undo');

    expect(view.state.doc.toString()).toBe('alpha!');
  });

  it('builds one native menu and replaces the webview menu', async () => {
    const a = editor('alpha');
    const b = editor('beta');
    attachEditorContextMenu(a);
    attachEditorContextMenu(b);

    const first = await rightClick(a);
    await rightClick(b);

    expect(first.defaultPrevented).toBe(true);
    expect(Menu.new).toHaveBeenCalledOnce();
  });
});
