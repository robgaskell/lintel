mod appearance;
mod files;
mod remote;
mod session;
mod startup;
mod windows;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::menu::Menu;
use tauri::{Manager, RunEvent, Runtime, Url, Window, WindowEvent};

/// Label of the Settings window that the frontend opens (settingsWindow.ts).
const SETTINGS: &str = "settings";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the app finishes launching, so AppKit restores nothing this time either.
    #[cfg(target_os = "macos")]
    startup::disable_appkit_restoration();
    let mut builder = tauri::Builder::default()
        // The default menu's Quit skips the unsaved-changes prompt; the frontend builds the menu.
        .enable_macos_default_menu(false)
        .plugin(navigation_guard())
        .plugin(settings_window())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // The preview's own click handler is the one path that opens links.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build());
    for plugin in session::geometry_plugins() {
        builder = builder.plugin(plugin);
    }
    builder
        .manage(windows::PathRegistry::default())
        .manage(windows::FocusOrder::default())
        .on_window_event(windows::on_doc_window_event)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            startup::disable_window_tabbing();
            if let Some(window) = app.get_webview_window("main") {
                startup::prepare_main_window(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::normalize_path,
            files::paths_exist,
            files::read_image_as_data_uri,
            files::read_text_file,
            files::write_text_file,
            remote::fetch_remote_image,
            windows::claim_path,
            windows::release_path,
            windows::transfer_path,
            windows::complete_handoff,
            windows::cancel_handoff,
            appearance::set_window_appearance
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lintel");
}

/// Lets each webview load the app once; any later top-level navigation, even to the
/// app's own URL, is refused. A reload would drop every unsaved edit (Ruling 84).
fn navigation_guard<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let loaded = Arc::new(LoadedWebviews::default());
    let on_destroyed = Arc::clone(&loaded);
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(move |webview, url| {
            let dev_url = dev_server(tauri::is_dev(), webview.config().build.dev_url.as_ref());
            loaded.allow(webview.label(), url, dev_url)
        })
        .on_event(move |_, event| {
            // A new window may reuse a closed window's label.
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = event
            {
                on_destroyed.forget(label);
            }
        })
        .build()
}

/// The Settings window has no menu bar of its own, and closes with the last document
/// window, whose webview runs every menu command (Rulings 142, 190).
fn settings_window<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("settings-window")
        .on_window_ready(|window| {
            // macOS has one app-wide menu bar; elsewhere each window shows its own.
            if cfg!(not(target_os = "macos")) && window.label() == SETTINGS {
                if let Err(err) = hide_menu_bar(&window) {
                    eprintln!("Could not hide the Settings menu bar: {err}");
                }
            }
        })
        .on_event(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = event
            {
                let open = app.webview_windows();
                on_window_destroyed(label, open.keys().map(String::as_str), || {
                    if let Some(settings) = app.get_webview_window(SETTINGS) {
                        let _ = settings.destroy();
                    }
                });
            }
        })
        .build()
}

// `open` may still list the destroyed window.
fn on_window_destroyed<'a>(
    label: &str,
    open: impl IntoIterator<Item = &'a str>,
    close_settings: impl FnOnce(),
) {
    if label == SETTINGS {
        return;
    }
    let doc_window_left = open.into_iter().any(|other| other != label && other != SETTINGS);
    if !doc_window_left {
        close_settings();
    }
}

// An empty menu of its own, not none: a window with no menu is given the app menu
// again on every rebuild of the menu bar.
fn hide_menu_bar<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    window.set_menu(Menu::new(window)?)?;
    window.hide_menu()
}

/// Only `tauri dev` loads from the dev server; built apps serve their own assets.
fn dev_server(is_dev: bool, configured: Option<&Url>) -> Option<&Url> {
    configured.filter(|_| is_dev)
}

/// Labels of the webviews that have already loaded the app.
#[derive(Default)]
struct LoadedWebviews(Mutex<HashSet<String>>);

impl LoadedWebviews {
    fn allow(&self, label: &str, url: &Url, dev_url: Option<&Url>) -> bool {
        // Vite's hot reload navigates the page again, so dev keeps reloads.
        if dev_url.is_some_and(|dev| same_origin(url, dev)) {
            return true;
        }
        same_origin(url, &app_origin()) && self.labels().insert(label.to_owned())
    }

    fn forget(&self, label: &str) {
        self.labels().remove(label);
    }

    fn labels(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn app_origin() -> Url {
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    Url::parse(origin).expect("valid app origin")
}

// Url::origin is opaque for tauri://, so compare the parts.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_closes_with_the_last_document_window() {
        let closed = |label: &str, open: &[&str]| {
            let mut closed = false;
            on_window_destroyed(label, open.iter().copied(), || closed = true);
            closed
        };
        assert!(closed("main", &[SETTINGS]));
        assert!(closed("main", &["main", SETTINGS]), "the closing window does not count");
        assert!(closed("w-1", &[SETTINGS]));
        assert!(!closed("main", &["w-1", SETTINGS]));
        assert!(!closed("w-1", &["main", SETTINGS]));
        assert!(!closed(SETTINGS, &[]));
    }

    #[test]
    fn settings_capability_grants_no_files_dialogs_links_or_app_commands() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/settings.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!([SETTINGS]));
        let granted: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().expect("plain permission ids only"))
            .collect();
        for id in &granted {
            let plugin = id.split(':').next().unwrap();
            assert!(
                matches!(plugin, "core" | "store"),
                "{id} is more than Settings needs"
            );
            assert!(id.contains(':'), "{id} is an app command");
        }
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(main["windows"], serde_json::json!(["main", "w-*"]));
    }

    #[test]
    fn every_window_may_set_its_own_background() {
        for capability in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/settings.json"),
        ] {
            let value: serde_json::Value = serde_json::from_str(capability).unwrap();
            let granted = value["permissions"].as_array().unwrap();
            assert!(granted.contains(&serde_json::json!("core:window:allow-set-background-color")));
            assert!(granted.contains(&serde_json::json!(
                "core:webview:allow-set-webview-background-color"
            )));
        }
    }

    #[test]
    fn document_windows_may_set_every_windows_appearance() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted = main["permissions"].as_array().unwrap();
        assert!(granted.contains(&serde_json::json!("allow-set-window-appearance")));
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn app(path: &str) -> Url {
        app_origin().join(path).unwrap()
    }

    #[test]
    fn allows_only_the_first_load_of_the_app() {
        let loaded = LoadedWebviews::default();
        assert!(loaded.allow("main", &app("/"), None));
        assert!(!loaded.allow("main", &app("/"), None), "a reload is refused");
        assert!(!loaded.allow("main", &app("/other.md"), None));
        assert!(!loaded.allow("main", &app("/?x"), None));
    }

    #[test]
    fn each_webview_gets_its_own_first_load() {
        let loaded = LoadedWebviews::default();
        assert!(loaded.allow("main", &app("/"), None));
        assert!(loaded.allow("doc-2", &app("/"), None));
        loaded.forget("main");
        assert!(loaded.allow("main", &app("/"), None), "a reused label loads again");
    }

    #[test]
    fn a_refused_navigation_does_not_use_up_the_first_load() {
        let loaded = LoadedWebviews::default();
        assert!(!loaded.allow("main", &url("https://example.com/"), None));
        assert!(loaded.allow("main", &app("/"), None));
    }

    #[test]
    fn allows_only_this_platforms_app_origin() {
        let other = if cfg!(windows) {
            "tauri://localhost/"
        } else {
            "http://tauri.localhost/"
        };
        assert!(!LoadedWebviews::default().allow("main", &url(other), None));
    }

    #[test]
    fn refuses_foreign_urls_even_as_the_first_load() {
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
            "http://localhost:1420/",
        ] {
            let loaded = LoadedWebviews::default();
            assert!(!loaded.allow("main", &url(s), None), "{s} should be refused");
        }
    }

    #[test]
    fn dev_server_reloads_are_allowed_in_dev_only() {
        let dev = url("http://localhost:1420");
        let loaded = LoadedWebviews::default();
        for _ in 0..2 {
            assert!(loaded.allow("main", &url("http://localhost:1420/"), Some(&dev)));
        }
        assert!(!loaded.allow("main", &url("http://localhost:1421/"), Some(&dev)));
        assert_eq!(dev_server(true, Some(&dev)), Some(&dev));
        assert_eq!(dev_server(false, Some(&dev)), None);
    }

    // Tauri's mock runtime raises no window events, so the hook's registration is checked
    // as written; the hook itself is tested in windows.rs (Ruling 217).
    #[test]
    fn every_window_event_goes_to_the_document_window_hook() {
        let registration = concat!(".on_window_event(", "windows::on_doc_window_event)");
        assert_eq!(include_str!("lib.rs").matches(registration).count(), 1);
    }

    #[test]
    fn csp_matches_ruling_69() {
        const RULING_69: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["security"]["csp"], RULING_69);
    }
}
