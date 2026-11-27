//! Window geometry from tauri-plugin-window-state, kept in step with session.json (Ruling 203).

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

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
    plugins_with(tauri_plugin_window_state::Builder::new())
}

fn plugins_with<R: Runtime, B: StateBuilder>(window_state: B) -> Vec<TauriPlugin<R>> {
    vec![
        prune_geometry(),
        configure(window_state).build(),
        keep_window_sizes(),
    ]
}

/// The window-state calls Lintel makes, behind a trait so a test can record them.
pub trait StateBuilder: Sized {
    fn with_state_flags(self, flags: StateFlags) -> Self;
    fn with_denylist(self, denylist: &[&str]) -> Self;
    fn build<R: Runtime>(self) -> TauriPlugin<R>;
}

impl StateBuilder for tauri_plugin_window_state::Builder {
    fn with_state_flags(self, flags: StateFlags) -> Self {
        tauri_plugin_window_state::Builder::with_state_flags(self, flags)
    }
    fn with_denylist(self, denylist: &[&str]) -> Self {
        tauri_plugin_window_state::Builder::with_denylist(self, denylist)
    }
    fn build<R: Runtime>(self) -> TauriPlugin<R> {
        tauri_plugin_window_state::Builder::build(self)
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
/// Inspector shrinks (Ruling 222). This keeps each window's own content size, from its
/// outer frame, whenever it can be read, and writes the last good one at exit (Ruling 235).
fn keep_window_sizes<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("keep-window-sizes")
        .setup(|app, _| {
            app.manage(KeptSizes::default());
            Ok(())
        })
        .on_event(keep_size_on)
        .build()
}

fn keep_size_on<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    match event {
        RunEvent::WindowEvent {
            label,
            event:
                WindowEvent::Resized(_)
                | WindowEvent::Moved(_)
                | WindowEvent::Focused(_)
                | WindowEvent::CloseRequested { .. },
            ..
        } => {
            let window = app.get_webview_window(label);
            kept_sizes(app).note(label, window.and_then(|w| window_size(&w)));
        }
        RunEvent::Exit => write_kept_sizes(app),
        _ => {}
    }
}

/// What exit saves, for an exit that skips RunEvent::Exit: the Windows updater's, which
/// runs its installer and ends the process (Ruling 343).
pub fn save_geometry_now<R: Runtime>(app: &AppHandle<R>) {
    if let Err(err) = app.save_window_state(GEOMETRY) {
        eprintln!("Could not save the window positions: {err}");
    }
    // After window-state's save, as at exit.
    write_kept_sizes(app);
}

#[derive(Default)]
struct KeptSizes(Mutex<LastGoodSizes>);

fn kept_sizes<R: Runtime>(app: &AppHandle<R>) -> MutexGuard<'_, LastGoodSizes> {
    let kept = app.state::<KeptSizes>().inner();
    kept.0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Sizes are read before the lock: off the main thread a read waits for the main thread,
// which may itself be waiting for the lock.
fn write_kept_sizes<R: Runtime>(app: &AppHandle<R>) {
    let sizes: Vec<_> = app
        .webview_windows()
        .into_iter()
        .map(|(label, window)| (label, window_size(&window)))
        .collect();
    let mut kept = kept_sizes(app);
    for (label, size) in sizes {
        kept.note(&label, size);
    }
    if let Ok(config) = app.path().app_config_dir() {
        // window-state's own file, which is where its exit save went.
        let state = config.join(app.filename());
        if let Err(err) = kept.write(&state) {
            eprintln!("Could not save the window sizes: {err}");
        }
    }
}

/// Each window's last readable content size. An unreadable frame keeps the one before,
/// so a window never falls back to window-state's own reading or the default size.
#[derive(Default)]
struct LastGoodSizes(HashMap<String, (u32, u32)>);

impl LastGoodSizes {
    fn note(&mut self, label: &str, size: Option<(u32, u32)>) {
        if let Some(size) = size {
            self.0.insert(label.to_owned(), size);
        }
    }

    fn write(&self, state: &Path) -> io::Result<()> {
        write_sizes(state, &self.0)
    }
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

/// A mock app with the geometry plugins writing to a file of the test's own.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    /// A window "main" as window-state saved it last time.
    pub const SAVED: &str = r#"{"main":{"width":10,"height":10,"x":0,"y":0,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#;

    /// window-state reads and writes `state`, which holds SAVED until the app is built and
    /// is then removed, so only a new save makes it again. No window is open: on macOS a
    /// mock window's frame cannot be read.
    pub fn geometry_app(state: &Path) -> tauri::App<MockRuntime> {
        std::fs::write(state, SAVED).unwrap();
        let window_state = configure(tauri_plugin_window_state::Builder::new())
            .with_filename(state.to_string_lossy());
        let app = mock_builder()
            .plugin(window_state.build())
            .plugin(keep_window_sizes())
            .build(mock_context(noop_assets()))
            .unwrap();
        std::fs::remove_file(state).unwrap();
        app
    }

    pub fn note_size<R: Runtime>(app: &AppHandle<R>, label: &str, size: (u32, u32)) {
        kept_sizes(app).note(label, Some(size));
    }

    /// The width and height `state` holds for `label`.
    pub fn saved_size(state: &Path, label: &str) -> Option<(u64, u64)> {
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(state).ok()?).ok()?;
        let entry = &saved[label];
        Some((entry["width"].as_u64()?, entry["height"].as_u64()?))
    }

    /// A fresh folder per test, so tests can run in parallel.
    pub fn temp_dir(name: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lintel-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::sync::Arc;

    #[test]
    fn exit_writes_the_kept_sizes_into_window_states_file() {
        let dir = temp_dir("exit-sizes");
        let state = dir.join("window-state.json");
        let app = geometry_app(&state);
        std::fs::write(&state, SAVED).unwrap();
        note_size(app.handle(), MAIN, (640, 480));

        keep_size_on(app.handle(), &RunEvent::Exit);

        assert_eq!(saved_size(&state, MAIN), Some((640, 480)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saving_geometry_now_writes_window_state_then_the_kept_sizes() {
        let dir = temp_dir("save-now");
        let state = dir.join("window-state.json");
        let app = geometry_app(&state);
        note_size(app.handle(), MAIN, (640, 480));

        save_geometry_now(app.handle());

        assert_eq!(saved_size(&state, MAIN), Some((640, 480)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

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

    // Records every window-state call, in order, and builds a stand-in plugin.
    #[derive(Default)]
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl StateBuilder for Recorder {
        fn with_state_flags(self, flags: StateFlags) -> Self {
            self.0
                .lock()
                .unwrap()
                .push(format!("flags {}", flags.bits()));
            self
        }
        fn with_denylist(self, denylist: &[&str]) -> Self {
            self.0
                .lock()
                .unwrap()
                .push(format!("denylist {}", denylist.join(",")));
            self
        }
        fn build<R: Runtime>(self) -> TauriPlugin<R> {
            self.0.lock().unwrap().push("build".to_owned());
            tauri::plugin::Builder::new("window-state").build()
        }
    }

    #[test]
    fn window_state_is_set_up_for_geometry_only_without_settings_and_in_order() {
        use tauri::plugin::Plugin;
        let recorder = Recorder::default();
        let calls = Arc::clone(&recorder.0);
        let names: Vec<String> = plugins_with::<tauri::test::MockRuntime, _>(recorder)
            .iter()
            .map(|plugin| plugin.name().to_owned())
            .collect();
        let geometry = (StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED).bits();
        assert_eq!(
            *calls.lock().unwrap(),
            [
                format!("flags {geometry}"),
                format!("denylist {}", crate::SETTINGS),
                "build".to_owned()
            ]
        );
        assert_eq!(
            names,
            ["prune-geometry", "window-state", "keep-window-sizes"]
        );
    }

    #[test]
    fn keeps_the_last_good_size_when_the_frame_cannot_be_read() {
        let dir = std::env::temp_dir().join(format!("lintel-sizes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join("state.json");
        std::fs::write(&state, r#"{"w-1":{"width":2200,"height":1520,"x":1}}"#).unwrap();
        let mut kept = LastGoodSizes::default();

        kept.note("w-1", Some((1760, 1280)));
        kept.note("w-1", None);
        kept.write(&state).unwrap();

        let states: serde_json::Map<String, Value> =
            serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
        assert_eq!(
            (&states["w-1"]["width"], &states["w-1"]["height"]),
            (&1760.into(), &1280.into())
        );
        std::fs::remove_dir_all(&dir).unwrap();
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
