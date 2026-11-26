mod files;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The default menu's Quit skips the unsaved-changes prompt; the frontend builds the menu.
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            files::normalize_path,
            files::read_text_file,
            files::write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lintel");
}
