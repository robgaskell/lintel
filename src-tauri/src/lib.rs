mod files;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .menu(app_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if matches!(id, "open" | "save" | "save-as") {
                let _ = app.emit("lintel://menu", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            files::read_text_file,
            files::write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lintel");
}

/// Temporary File menu (Open, Save, Save As) on top of Tauri's default menu.
/// M1.3 replaces it with the real menu.
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as = MenuItem::with_id(app, "save-as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?;

    let existing_file = menu
        .items()?
        .into_iter()
        .filter_map(|item| item.as_submenu().cloned())
        .find(|sub| sub.text().is_ok_and(|t| t == "File"));
    match existing_file {
        Some(file) => file.prepend_items(&[&open, &save, &save_as])?,
        // Tauri's default menu has no File submenu on Linux.
        None => menu.prepend(&Submenu::with_items(
            app,
            "File",
            true,
            &[&open, &save, &save_as],
        )?)?,
    }
    Ok(menu)
}
