//! Window geometry from tauri-plugin-window-state, kept in step with session.json (Ruling 203).

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::plugin::TauriPlugin;
use tauri::{Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Geometry only. VISIBLE would show and focus each hidden-start window as it is created,
/// before its theme and docs are in (Rulings 154, 184).
pub const GEOMETRY: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

const SESSION_FILE: &str = "session.json";
const MAIN: &str = "main";

/// The geometry plugins in the order they must be registered (Ruling 221). Plugins set up
/// in order and window-state reads its file in its own setup, so the prune comes first;
/// the size keeper comes last, so its exit hook runs after window-state's save.
pub fn geometry_plugins<R: Runtime>() -> Vec<TauriPlugin<R>> {
    vec![
        prune_geometry(),
        configure(tauri_plugin_window_state::Builder::new()).build(),
        keep_window_sizes(),
    ]
}

/// The two window-state settings Lintel relies on, behind a trait so a test can see them.
pub trait StateBuilder: Sized {
    fn with_state_flags(self, flags: StateFlags) -> Self;
    fn with_denylist(self, denylist: &[&str]) -> Self;
}

impl StateBuilder for tauri_plugin_window_state::Builder {
    fn with_state_flags(self, flags: StateFlags) -> Self {
        tauri_plugin_window_state::Builder::with_state_flags(self, flags)
    }
    fn with_denylist(self, denylist: &[&str]) -> Self {
        tauri_plugin_window_state::Builder::with_denylist(self, denylist)
    }
}

fn configure<B: StateBuilder>(builder: B) -> B {
    builder
        .with_state_flags(GEOMETRY)
        // Settings is not a document window and is never restored (Ruling 147).
        .with_denylist(&[crate::SETTINGS])
}

fn prune_geometry<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("prune-geometry")
        .setup(|app, _| {
            let path = app.path();
            if let (Ok(data), Ok(config)) = (path.app_data_dir(), path.app_config_dir()) {
                let state = config.join(tauri_plugin_window_state::DEFAULT_FILENAME);
                if let Err(err) = prune(&data.join(SESSION_FILE), &state) {
                    eprintln!("Could not tidy the saved window positions: {err}");
                }
            }
            Ok(())
        })
        .build()
}

/// On macOS, window-state reads a window's size from its web view, which a docked Web
/// Inspector shrinks (Ruling 222). At exit this writes each window's own content size,
/// taken from its outer frame, over what window-state saved.
fn keep_window_sizes<R: Runtime>() -> TauriPlugin<R> {
    let closed = Arc::new(Mutex::new(HashMap::new()));
    tauri::plugin::Builder::new("keep-window-sizes")
        .on_event(move |app, event| {
            let mut sizes = closed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match event {
                // window-state also reads the size as a window closes.
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { .. },
                    ..
                } => {
                    let window = app.get_webview_window(label);
                    if let Some(size) = window.and_then(|w| window_size(&w)) {
                        sizes.insert(label.clone(), size);
                    }
                }
                RunEvent::Exit => {
                    for (label, window) in app.webview_windows() {
                        if let Some(size) = window_size(&window) {
                            sizes.insert(label, size);
                        }
                    }
                    if let Ok(config) = app.path().app_config_dir() {
                        let state = config.join(tauri_plugin_window_state::DEFAULT_FILENAME);
                        if let Err(err) = write_sizes(&state, &sizes) {
                            eprintln!("Could not save the window sizes: {err}");
                        }
                    }
                }
                _ => {}
            }
        })
        .build()
}

/// Content size in physical pixels. None for Settings and for a maximised, minimised or
/// full-screen window, whose saved size window-state keeps as it was.
fn window_size<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<(u32, u32)> {
    if window.label() == crate::SETTINGS
        || window.is_maximized().unwrap_or(true)
        || window.is_minimized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
    {
        return None;
    }
    content_size(window)
}

#[cfg(target_os = "macos")]
fn content_size<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<(u32, u32)> {
    use objc2_app_kit::NSWindow;
    let ns_window = window.ns_window().ok()?;
    if ns_window.is_null() {
        return None;
    }
    // SAFETY: tauri hands over the live NSWindow; run events arrive on the main thread.
    let ns_window = unsafe { &*(ns_window as *const NSWindow) };
    let content = ns_window.contentRectForFrameRect(ns_window.frame());
    let scale = ns_window.backingScaleFactor();
    let width = (content.size.width * scale).round() as u32;
    let height = (content.size.height * scale).round() as u32;
    (width > 0 && height > 0).then_some((width, height))
}

// Elsewhere the size window-state reads is the window's own.
#[cfg(not(target_os = "macos"))]
fn content_size<R: Runtime>(_window: &tauri::WebviewWindow<R>) -> Option<(u32, u32)> {
    None
}

fn write_sizes(state: &Path, sizes: &HashMap<String, (u32, u32)>) -> io::Result<()> {
    if sizes.is_empty() {
        return Ok(());
    }
    let saved = match std::fs::read_to_string(state) {
        Ok(saved) => saved,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    match with_sizes(&saved, sizes) {
        Some(text) => crate::files::write_atomic(state, text.as_bytes(), None),
        None => Ok(()),
    }
}

/// The file with each listed window's width and height replaced; None when nothing changes.
fn with_sizes(saved: &str, sizes: &HashMap<String, (u32, u32)>) -> Option<String> {
    let Ok(Value::Object(mut states)) = serde_json::from_str(saved) else {
        return None;
    };
    let mut changed = false;
    for (label, (width, height)) in sizes {
        let Some(Value::Object(state)) = states.get_mut(label) else {
            continue;
        };
        for (key, value) in [("width", *width), ("height", *height)] {
            if state.get(key).and_then(Value::as_u64) != Some(u64::from(value)) {
                state.insert(key.to_owned(), Value::from(value));
                changed = true;
            }
        }
    }
    if !changed {
        return None;
    }
    serde_json::to_string_pretty(&Value::Object(states)).ok()
}

/// Drops the saved geometry of every window the session will not bring back, so closed
/// windows do not pile up in the file.
fn prune(session: &Path, state: &Path) -> io::Result<()> {
    let saved = match std::fs::read_to_string(state) {
        Ok(saved) => saved,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let keep = restored_labels(std::fs::read_to_string(session).ok().as_deref());
    match pruned(&saved, &keep) {
        Some(text) => crate::files::write_atomic(state, text.as_bytes(), None),
        None => Ok(()),
    }
}

/// `main`, plus each `window:<label>` key of a version 1 session (Ruling 210).
fn restored_labels(session: Option<&str>) -> HashSet<String> {
    let mut labels = HashSet::from([MAIN.to_owned()]);
    let Some(Value::Object(store)) = session.and_then(|s| serde_json::from_str(s).ok()) else {
        return labels;
    };
    // The store writes numbers through JSON, which may give 1.0.
    if store.get("version").and_then(Value::as_f64) != Some(1.0) {
        return labels;
    }
    let windows = store.keys().filter_map(|key| key.strip_prefix("window:"));
    labels.extend(windows.map(str::to_owned));
    labels
}

/// The file without the labels not in `keep`; None when it is unreadable or nothing goes.
fn pruned(saved: &str, keep: &HashSet<String>) -> Option<String> {
    let Ok(Value::Object(mut states)) = serde_json::from_str(saved) else {
        return None;
    };
    let before = states.len();
    states.retain(|label, _| keep.contains(label));
    if states.len() == before {
        return None;
    }
    serde_json::to_string_pretty(&Value::Object(states)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(session: &str) -> Vec<String> {
        let mut labels: Vec<_> = restored_labels(Some(session)).into_iter().collect();
        labels.sort();
        labels
    }

    #[test]
    fn keeps_main_and_each_window_key() {
        let session = r#"{"version":1,"window:main":{},"window:w-1":{},"other":2}"#;
        assert_eq!(labels(session), ["main", "w-1"]);
    }

    #[test]
    fn a_missing_damaged_or_unknown_version_session_keeps_main_only() {
        assert_eq!(restored_labels(None), HashSet::from([MAIN.to_owned()]));
        assert_eq!(labels("not json"), ["main"]);
        assert_eq!(labels(r#"{"version":2,"window:w-1":{}}"#), ["main"]);
        assert_eq!(labels(r#"{"window:w-1":{}}"#), ["main"]);
    }

    #[test]
    fn reads_a_version_written_as_a_float() {
        assert_eq!(
            labels(r#"{"version":1.0,"window:w-1":{}}"#),
            ["main", "w-1"]
        );
    }

    #[test]
    fn prunes_labels_the_session_will_not_restore() {
        let keep = restored_labels(Some(r#"{"version":1,"window:w-1":{}}"#));
        let saved = r#"{"main":{"x":1},"w-1":{"x":2},"w-gone":{"x":3},"settings":{"x":4}}"#;
        let text = pruned(saved, &keep).expect("something to prune");
        let states: serde_json::Map<String, Value> = serde_json::from_str(&text).unwrap();
        let mut left: Vec<_> = states.keys().cloned().collect();
        left.sort();
        assert_eq!(left, ["main", "w-1"]);
        assert_eq!(states["w-1"]["x"], 2, "kept entries are unchanged");
    }

    #[test]
    fn leaves_the_file_alone_when_nothing_goes_or_it_is_unreadable() {
        let keep = restored_labels(None);
        assert_eq!(pruned(r#"{"main":{}}"#, &keep), None);
        assert_eq!(pruned("not json", &keep), None);
    }

    #[test]
    fn prune_rewrites_the_geometry_file() {
        let dir = std::env::temp_dir().join(format!("lintel-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let session = dir.join(SESSION_FILE);
        let state = dir.join("state.json");
        std::fs::write(&session, r#"{"version":1,"window:w-1":{}}"#).unwrap();
        std::fs::write(&state, r#"{"main":{},"w-1":{},"w-2":{}}"#).unwrap();

        prune(&session, &state).unwrap();

        let left: serde_json::Map<String, Value> =
            serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
        assert!(left.contains_key("w-1") && !left.contains_key("w-2"));
        prune(&dir.join("none.json"), &dir.join("absent.json")).expect("no file, no error");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[derive(Default)]
    struct Recorded {
        flags: Option<StateFlags>,
        denylist: Vec<String>,
    }

    impl StateBuilder for Recorded {
        fn with_state_flags(mut self, flags: StateFlags) -> Self {
            self.flags = Some(flags);
            self
        }
        fn with_denylist(mut self, denylist: &[&str]) -> Self {
            self.denylist = denylist.iter().map(|l| l.to_string()).collect();
            self
        }
    }

    #[test]
    fn window_state_restores_geometry_only_and_never_settings() {
        let set = configure(Recorded::default());
        let flags = set.flags.expect("flags set, not left at all()");
        assert!(
            !flags.contains(StateFlags::VISIBLE),
            "VISIBLE would show and focus hidden windows"
        );
        assert!(flags.contains(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED));
        assert_eq!(set.denylist, [crate::SETTINGS]);
    }

    #[test]
    fn the_prune_comes_before_window_state_and_the_size_keeper_after() {
        use tauri::plugin::Plugin;
        let names: Vec<String> = geometry_plugins::<tauri::test::MockRuntime>()
            .iter()
            .map(|plugin| plugin.name().to_owned())
            .collect();
        assert_eq!(
            names,
            ["prune-geometry", "window-state", "keep-window-sizes"]
        );
    }

    #[test]
    fn writes_each_windows_own_size_over_the_saved_one() {
        let saved = r#"{"main":{"width":1760,"height":320,"x":5},"w-1":{"width":10,"height":10}}"#;
        let sizes = HashMap::from([
            ("main".to_owned(), (1760, 1280)),
            ("gone".to_owned(), (1, 1)),
        ]);
        let text = with_sizes(saved, &sizes).expect("main changes");
        let states: serde_json::Map<String, Value> = serde_json::from_str(&text).unwrap();
        assert_eq!(states["main"]["height"], 1280);
        assert_eq!(states["main"]["x"], 5, "the rest is kept");
        assert_eq!(
            states["w-1"]["height"], 10,
            "a window with no size of its own is left"
        );
        assert!(!states.contains_key("gone"));
    }

    #[test]
    fn leaves_the_sizes_file_alone_when_nothing_changes() {
        let sizes = HashMap::from([("main".to_owned(), (10, 20))]);
        assert_eq!(
            with_sizes(r#"{"main":{"width":10,"height":20}}"#, &sizes),
            None
        );
        assert_eq!(with_sizes("not json", &sizes), None);
    }

    #[test]
    fn geometry_leaves_out_visibility() {
        assert!(!GEOMETRY.contains(StateFlags::VISIBLE));
        assert!(GEOMETRY.contains(StateFlags::SIZE | StateFlags::POSITION));
    }
}
