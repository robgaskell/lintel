import { Menu } from '@tauri-apps/api/menu';
import type { EditorView } from '@codemirror/view';
import { insertLink, toggleBold, toggleItalic } from './commands';

// Tauri routes menu clicks through one app-wide map keyed by item id, so per-editor
// menus with the same ids would steal each other's clicks. One menu serves every editor.
let menu: Promise<Menu> | null = null;
let target: EditorView | null = null;

/** Replaces the webview's right-click menu on `view` with the shared native one. */
export function attachEditorContextMenu(view: EditorView): () => void {
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    target = view;
    // No position: the menu opens at the mouse.
    void sharedMenu()
      .then((m) => m.popup())
      .catch((err) => console.error('Context menu failed', err));
  };

  view.dom.addEventListener('contextmenu', onContextMenu);
  return () => {
    view.dom.removeEventListener('contextmenu', onContextMenu);
    if (target === view) target = null;
  };
}

function sharedMenu(): Promise<Menu> {
  menu ??= Menu.new({
    items: [
      { item: 'Cut' },
      { item: 'Copy' },
      { item: 'Paste' },
      { item: 'SelectAll' },
      { item: 'Separator' },
      { id: 'bold', text: 'Bold', action: () => onTarget(toggleBold) },
      { id: 'italic', text: 'Italic', action: () => onTarget(toggleItalic) },
      { id: 'link', text: 'Link', action: () => onTarget(insertLink) },
    ],
  }).catch((err) => {
    menu = null; // let the next right-click try again
    throw err;
  });
  return menu;
}

function onTarget(command: (view: EditorView) => boolean): void {
  if (!target) return;
  command(target);
  target.focus();
}
