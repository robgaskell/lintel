mod appearance;
mod files;
mod lint_config;
mod open_queue;
mod os_integration;
mod remote;
mod session;
mod settings;
mod startup;
mod watch;
mod windows;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::Menu;
use tauri::plugin::Plugin;
use tauri::{AppHandle, Manager, RunEvent, Runtime, Url, Window, WindowEvent};

use open_queue::OpenQueue;

/// Label of the Settings window that the frontend opens (settingsWindow.ts).
const SETTINGS: &str = "settings";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the app finishes launching, so AppKit restores nothing this time either.
    #[cfg(target_os = "macos")]
    startup::disable_appkit_restoration();
    let mut builder = tauri::Builder::default()
        // The default menu's Quit skips the unsaved-changes prompt; the frontend builds the menu.
        .enable_macos_default_menu(false);
    for plugin in app_plugins() {
        builder = builder.plugin_boxed(plugin);
    }
    // Opening a file from Finder or `open -g` must not take focus from the app in front.
    #[cfg(target_os = "macos")]
    {
        builder = builder.activate_ignoring_other_apps(false);
    }
    builder
        .manage(windows::PathRegistry::default())
        .manage(windows::FocusOrder::default())
        .manage(Mutex::new(OpenQueue::default()))
        .manage(settings::SettingsLock::default())
        .manage(lint_config::Searches::default())
        .on_window_event(windows::on_doc_window_event)
        .setup(|app| {
            app.manage(watch::Watcher::for_app(app.handle().clone()));
            let args = std::env::args_os().map(|arg| arg.to_string_lossy().into_owned());
            setup_app(app, args, std::env::current_dir().ok());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::normalize_path,
            files::paths_exist,
            files::read_image_as_data_uri,
            files::read_text_file,
            files::write_text_file,
            files::write_binary_file,
            remote::fetch_remote_image,
            windows::claim_path,
            windows::release_path,
            windows::transfer_path,
            windows::complete_handoff,
            windows::cancel_handoff,
            windows::handoff_status,
            appearance::set_window_appearance,
            open_queue::frontend_ready,
            watch::watch_path,
            watch::unwatch_path,
            lint_config::find_lint_config,
            settings::update_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lintel")
        .run(on_run_event);
}

/// Every plugin, in the order it is registered; plugins set up in this order (Ruling 237).
fn app_plugins<R: Runtime>() -> Vec<Box<dyn Plugin<R>>> {
    let mut plugins: Vec<Box<dyn Plugin<R>>> = vec![
        // First, so a second launch hands over its files and exits before other plugins start.
        Box::new(tauri_plugin_single_instance::init(on_second_instance)),
        Box::new(navigation_guard()),
        Box::new(settings_window()),
        Box::new(tauri_plugin_clipboard_manager::init()),
        Box::new(tauri_plugin_dialog::init()),
        Box::new(tauri_plugin_fs::init()),
        // The preview's own click handler is the one path that opens links.
        Box::new(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        ),
        Box::new(tauri_plugin_process::init()),
        Box::new(tauri_plugin_store::Builder::default().build()),
    ];
    for plugin in session::geometry_plugins() {
        plugins.push(Box::new(plugin));
    }
    plugins
}

/// Runs once the app is built. `args` and `cwd` are this launch's, `cwd` None when it
/// could not be read.
fn setup_app<R: Runtime>(
    app: &tauri::App<R>,
    args: impl IntoIterator<Item = String>,
    cwd: Option<PathBuf>,
) {
    #[cfg(target_os = "macos")]
    startup::disable_window_tabbing();
    if let Some(window) = app.get_webview_window("main") {
        startup::prepare_main_window(&window);
    }
    os_integration::listen_for_os_actions(app.handle());
    let cwd = cwd.map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
    open_queue::open_from_outside(app.handle(), open_queue::paths_from_args(args, &cwd));
}

// The plugin sends "" as `cwd` when the second launch's folder could not be read.
fn on_second_instance<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, cwd: String) {
    open_queue::open_from_outside(app, open_queue::paths_from_args(args, &cwd));
}

// macOS passes files from Finder, `open` and the Dock here, not through argv.
fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Opened { urls } = event {
        open_queue::open_from_outside(app, open_queue::paths_from_urls(&urls));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
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
    fn registers_single_instance_first_and_the_geometry_plugins_in_order() {
        let names: Vec<String> = app_plugins::<tauri::test::MockRuntime>()
            .iter()
            .map(|plugin| plugin.name().to_owned())
            .collect();
        assert_eq!(names.first().map(String::as_str), Some("single-instance"));
        let at = |name: &str| names.iter().position(|n| n == name).expect(name);
        // The prune edits window-state's file before window-state reads it, and the size
        // keeper's exit hook runs after window-state's save.
        assert!(at("store") < at("prune-geometry"));
        assert_eq!(
            names[at("prune-geometry")..],
            ["prune-geometry", "window-state", "keep-window-sizes"]
        );
    }

    // Tauri's builder cannot be read back, so its wiring is checked as written.
    #[test]
    fn run_wires_every_open_route_and_launches_without_activating() {
        let source = include_str!("lib.rs");
        for wiring in [
            concat!("tauri_plugin_single_instance::init(", "on_second_instance)"),
            concat!(".run(", "on_run_event)"),
            concat!("setup_app(", "app, args, std::env::current_dir().ok())"),
            concat!("builder = builder.", "activate_ignoring_other_apps(false);"),
        ] {
            assert_eq!(source.matches(wiring).count(), 1, "{wiring}");
        }
    }

    // Their paths are Unix paths.
    #[cfg(not(windows))]
    mod open_routes {
        use super::*;
        use std::sync::Arc;
        use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
        use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

        type Heard = Arc<Mutex<Vec<String>>>;

        // An app whose main window is ready and records the files sent to it.
        fn app() -> (tauri::App<MockRuntime>, Heard) {
            let app = mock_builder()
                .manage(Mutex::new(OpenQueue::default()))
                .build(mock_context(noop_assets()))
                .unwrap();
            let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
                .build()
                .unwrap();
            let heard = Heard::default();
            let log = Arc::clone(&heard);
            main.listen(open_queue::OPEN_FILES, move |e| {
                log.lock().unwrap().push(e.payload().to_owned())
            });
            open_queue::frontend_ready(main.as_ref().window(), app.state());
            (app, heard)
        }

        fn args(list: &[&str]) -> Vec<String> {
            list.iter().map(|s| s.to_string()).collect()
        }

        #[test]
        fn a_second_launch_opens_its_files_from_its_own_folder() {
            let (app, heard) = app();
            on_second_instance(app.handle(), args(&["lintel", "a.md"]), "/tmp/x".to_owned());
            assert_eq!(*heard.lock().unwrap(), [r#"{"paths":["/tmp/x/a.md"]}"#]);
        }

        #[test]
        fn setup_opens_the_launch_arguments() {
            let (app, heard) = app();
            setup_app(&app, args(&["lintel", "a.md", "-v"]), Some("/tmp/x".into()));
            assert_eq!(*heard.lock().unwrap(), [r#"{"paths":["/tmp/x/a.md"]}"#]);
        }

        #[test]
        fn setup_leaves_relative_paths_relative_when_its_folder_is_unknown() {
            let (app, heard) = app();
            setup_app(&app, args(&["lintel", "a.md"]), None);
            assert_eq!(*heard.lock().unwrap(), [r#"{"paths":["a.md"]}"#]);
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn files_macos_opens_with_lintel_are_opened() {
            let (app, heard) = app();
            let urls = vec![Url::parse("file:///tmp/my%20notes.md").unwrap()];
            on_run_event(app.handle(), RunEvent::Opened { urls });
            assert_eq!(*heard.lock().unwrap(), [r#"{"paths":["/tmp/my notes.md"]}"#]);
        }
    }

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
        // Writing settings is the one app command it may call (Ruling 271).
        for id in granted.iter().filter(|id| **id != "allow-update-settings") {
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
    fn the_opener_may_open_only_the_bundled_notices() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let open_path: Vec<&serde_json::Value> = main["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| {
                p.as_str().or(p["identifier"].as_str()) == Some("opener:allow-open-path")
            })
            .collect();
        assert_eq!(
            open_path,
            [&serde_json::json!({
                "identifier": "opener:allow-open-path",
                "allow": [{ "path": "$RESOURCE/THIRD_PARTY_NOTICES.md" }]
            })]
        );
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["resources"]["../THIRD_PARTY_NOTICES.md"],
            "THIRD_PARTY_NOTICES.md"
        );
    }

    #[test]
    fn every_window_writes_settings_through_the_one_command() {
        assert!(include_str!("../build.rs").contains("\"update_settings\""));
        for capability in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/settings.json"),
        ] {
            let value: serde_json::Value = serde_json::from_str(capability).unwrap();
            let granted = value["permissions"].as_array().unwrap();
            assert!(granted.contains(&serde_json::json!("allow-update-settings")));
        }
    }

    #[test]
    fn document_windows_may_set_every_windows_appearance() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted = main["permissions"].as_array().unwrap();
        assert!(granted.contains(&serde_json::json!("allow-set-window-appearance")));
    }

    #[test]
    fn only_document_windows_may_print() {
        // On macOS, window.print() is a call to the webview plugin.
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/settings.json")).unwrap();
        let print = serde_json::json!("core:webview:allow-print");
        assert!(main["permissions"].as_array().unwrap().contains(&print));
        assert!(!settings["permissions"].as_array().unwrap().contains(&print));
    }

    #[test]
    fn document_windows_may_ask_for_opened_files() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted = main["permissions"].as_array().unwrap();
        assert!(granted.contains(&serde_json::json!("allow-frontend-ready")));
    }

    #[test]
    fn document_windows_may_watch_files_and_find_lint_configs() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted = main["permissions"].as_array().unwrap();
        let build = include_str!("../build.rs");
        for command in ["watch_path", "unwatch_path", "find_lint_config"] {
            assert!(
                build.contains(&format!("\"{command}\"")),
                "{command} in build.rs"
            );
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(granted.contains(&serde_json::json!(permission)));
        }
    }

    #[test]
    fn only_document_windows_may_write_exports() {
        assert!(include_str!("../build.rs").contains("\"write_binary_file\""));
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/settings.json")).unwrap();
        let write = serde_json::json!("allow-write-binary-file");
        assert!(main["permissions"].as_array().unwrap().contains(&write));
        assert!(!settings["permissions"].as_array().unwrap().contains(&write));
    }

    #[test]
    fn no_window_may_write_files_through_plugin_fs() {
        // Exports go through write_binary_file, which writes atomically (Ruling 327).
        for capability in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/settings.json"),
        ] {
            assert!(!capability.contains("\"fs:"), "{capability}");
        }
    }

    #[test]
    fn markdown_files_are_associated_with_lintel() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["fileAssociations"],
            serde_json::json!([{
                "ext": ["md", "markdown"],
                "contentTypes": ["net.daringfireball.markdown"],
                "mimeType": "text/markdown",
                "name": "Lintel.Markdown",
                "description": "Markdown document",
                "role": "Editor",
                "rank": "Default"
            }])
        );
    }

    #[test]
    fn windows_installer_adds_lintel_to_open_with_and_puts_the_default_back() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["windows"]["nsis"]["installerHooks"],
            "windows/installer-hooks.nsh"
        );
        // APP_ASSOCIATE names its ProgID and backup value after the association's name.
        let name = conf["bundle"]["fileAssociations"][0]["name"].as_str().unwrap();
        let hooks = include_str!("../windows/installer-hooks.nsh");
        assert!(hooks.contains(&format!("\"{name}_backup\"")));
        for ext in ["md", "markdown"] {
            assert!(hooks.contains(&format!("!insertmacro LINTEL_OPEN_WITH \"{ext}\"")));
            let open_with = format!("\"Software\\Classes\\.{ext}\\OpenWithProgids\" \"{name}\"");
            assert!(hooks.contains(&open_with), "the uninstaller leaves Lintel in {ext} Open with");
        }
        assert!(hooks.contains("\\OpenWithProgids\" \"Lintel.Markdown\" \"\""));
    }

    #[test]
    fn macos_imports_the_markdown_type_rather_than_exporting_it() {
        let plist = include_str!("../Info.plist");
        assert!(plist.contains("<key>UTImportedTypeDeclarations</key>"));
        assert!(plist.contains("<string>net.daringfireball.markdown</string>"));
        assert!(!plist.contains("UTExportedTypeDeclarations"));
    }

    #[test]
    fn linux_desktop_entry_passes_the_files_it_opens() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        for format in ["deb", "rpm"] {
            assert_eq!(
                conf["bundle"]["linux"][format]["desktopTemplate"],
                "linux/lintel.desktop"
            );
        }
        let entry = include_str!("../linux/lintel.desktop");
        assert!(entry.lines().any(|l| l == "Exec=lintel %F"));
        assert!(entry
            .lines()
            .any(|l| l == "MimeType=text/markdown;text/x-markdown;"));
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
