//! Window geometry from tauri-plugin-window-state, kept in step with session.json (Ruling 203).

use std::collections::HashSet;
use std::io;
use std::path::Path;

use serde_json::Value;
use tauri::plugin::TauriPlugin;
use tauri::{Manager, Runtime};
use tauri_plugin_window_state::StateFlags;

/// Geometry only. VISIBLE would show and focus each hidden-start window as it is created,
/// before its theme and docs are in (Rulings 154, 184).
pub const GEOMETRY: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

const SESSION_FILE: &str = "session.json";
const MAIN: &str = "main";

pub fn window_state<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(GEOMETRY)
        // Settings is not a document window and is never restored (Ruling 147).
        .with_denylist(&[crate::SETTINGS])
        .build()
}

/// Must be registered before `window_state`: plugins set up in order, and window-state
/// reads its file in its own setup.
pub fn prune_geometry<R: Runtime>() -> TauriPlugin<R> {
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

    #[test]
    fn geometry_leaves_out_visibility() {
        assert!(!GEOMETRY.contains(StateFlags::VISIBLE));
        assert!(GEOMETRY.contains(StateFlags::SIZE | StateFlags::POSITION));
    }
}
