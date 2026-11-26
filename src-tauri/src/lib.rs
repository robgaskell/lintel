mod files;

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Menu ids the frontend handles, sent as the `lintel://menu` payload.
const FORWARDED_MENU_IDS: [&str; 5] = ["new", "open", "save", "save-as", "close-tab"];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .menu(app_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if FORWARDED_MENU_IDS.contains(&id) {
                let _ = app.emit("lintel://menu", id);
            } else if id == "close-window" {
                close_focused_window(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            files::normalize_path,
            files::read_text_file,
            files::write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lintel");
}

/// Temporary menu: Tauri's default with its File and Window submenus rebuilt. The default
/// ones hold a predefined Close Window item that takes Cmd+W on macOS, which must close a
/// tab instead. M1.3 replaces this with the real menu.
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;

    let new = MenuItem::with_id(app, "new", "New", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as = MenuItem::with_id(app, "save-as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?;
    let close_tab = MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let close_window = MenuItem::with_id(
        app,
        "close-window",
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new,
            &open,
            &save,
            &save_as,
            &close_tab,
            &close_window,
            // Tauri's default File menu has Exit on Windows only.
            #[cfg(windows)]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    // Tauri's default menu has no File submenu on Linux; put ours first there.
    match submenu_position(&menu, |sub| sub.text().is_ok_and(|t| t == "File"))? {
        Some(index) => {
            menu.remove_at(index)?;
            menu.insert(&file, index)?;
        }
        None => menu.prepend(&file)?,
    }
    // Same id, so Tauri still registers it as the macOS Window menu.
    if let Some(index) = submenu_position(&menu, |sub| sub.id() == WINDOW_SUBMENU_ID)? {
        menu.remove_at(index)?;
        menu.insert(&window, index)?;
    }
    Ok(menu)
}

fn submenu_position<R: Runtime>(
    menu: &Menu<R>,
    matches: impl Fn(&Submenu<R>) -> bool,
) -> tauri::Result<Option<usize>> {
    Ok(menu.items()?.iter().position(|item| match item {
        MenuItemKind::Submenu(sub) => matches(sub),
        _ => false,
    }))
}

/// Goes through close-requested, so the frontend can prompt for unsaved docs.
fn close_focused_window<R: Runtime>(app: &AppHandle<R>) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false));
    if let Some(window) = focused {
        let _ = window.close();
    }
}
