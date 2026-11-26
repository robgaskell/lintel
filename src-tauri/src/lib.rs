mod files;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, Runtime, Url, WindowEvent};

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

    #[test]
    fn csp_matches_ruling_69() {
        const RULING_69: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["security"]["csp"], RULING_69);
    }
}
