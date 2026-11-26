mod files;

use tauri::{Manager, Runtime, Url};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The default menu's Quit skips the unsaved-changes prompt; the frontend builds the menu.
        .enable_macos_default_menu(false)
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            files::normalize_path,
            files::paths_exist,
            files::read_text_file,
            files::write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lintel");
}

/// Refuses any navigation away from the app's own pages, so a link in a document
/// can never replace the editor (Ruling 70).
fn navigation_guard<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            // Only `tauri dev` loads from the dev server; built apps serve their own assets.
            let dev_url = if tauri::is_dev() {
                webview.config().build.dev_url.clone()
            } else {
                None
            };
            is_app_url(url, dev_url.as_ref())
        })
        .build()
}

fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    // Url::origin is opaque for tauri://, so compare the parts.
    let same_origin = |allowed: &Url| {
        url.scheme() == allowed.scheme()
            && url.host_str() == allowed.host_str()
            && url.port_or_known_default() == allowed.port_or_known_default()
    };
    // macOS and Linux serve tauri://localhost; Windows serves http://tauri.localhost.
    ["tauri://localhost", "http://tauri.localhost"]
        .iter()
        .filter_map(|s| Url::parse(s).ok())
        .chain(dev_url.cloned())
        .any(|allowed| same_origin(&allowed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_the_app_origin_on_every_platform() {
        assert!(is_app_url(&url("tauri://localhost"), None));
        assert!(is_app_url(&url("tauri://localhost/index.html#h-intro"), None));
        assert!(is_app_url(&url("http://tauri.localhost/"), None));
    }

    #[test]
    fn allows_the_dev_server_only_when_given() {
        let dev = url("http://localhost:1420");
        assert!(is_app_url(&url("http://localhost:1420/"), Some(&dev)));
        assert!(!is_app_url(&url("http://localhost:1420/"), None));
        assert!(!is_app_url(&url("http://localhost:1421/"), Some(&dev)));
    }

    #[test]
    fn refuses_everything_else() {
        for s in [
            "https://example.com/",
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://tauri.localhost.evil.com/",
            "http://tauri.localhost@evil.com/",
            "tauri://evil/",
            "file:///etc/passwd",
            "about:blank",
            "data:text/html,hi",
            "javascript:alert(1)",
        ] {
            assert!(!is_app_url(&url(s), None), "{s} should be refused");
        }
    }
}
