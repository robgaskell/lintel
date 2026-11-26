import { Menu } from '@tauri-apps/api/menu';
import type { EditorView } from '@codemirror/view';
import { insertLink, toggleBold, toggleItalic } from './commands';

/**
 * Replaces the webview's right-click menu on `view` with a native one.
 * The menu is built on first use and released by the returned detach function.
 */
export function attachEditorContextMenu(view: EditorView): () => void {
  let menu: Promise<Menu> | null = null;
  const apply = (command: (view: EditorView) => boolean) => () => {
    command(view);
    view.focus();
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    menu ??= Menu.new({
      items: [
        { item: 'Cut' },
        { item: 'Copy' },
        { item: 'Paste' },
        { item: 'SelectAll' },
        { item: 'Separator' },
        { id: 'bold', text: 'Bold', action: apply(toggleBold) },
        { id: 'italic', text: 'Italic', action: apply(toggleItalic) },
        { id: 'link', text: 'Link', action: apply(insertLink) },
      ],
    }).catch((err) => {
      menu = null; // let the next right-click try again
      throw err;
    });
    // No position: the menu opens at the mouse.
    void menu.then((m) => m.popup()).catch((err) => console.error('Context menu failed', err));
  };

  view.dom.addEventListener('contextmenu', onContextMenu);
  return () => {
    view.dom.removeEventListener('contextmenu', onContextMenu);
    void menu?.then((m) => m.close()).catch((err) => console.error('Context menu close failed', err));
  };
}
