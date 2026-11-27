//! Every window's settings changes are applied here, one at a time (Rulings 169, 271).
//! Two windows each merging into their own copy could undo each other's change.

use std::path::Path;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_store::StoreBuilder;

const FILE: &str = "settings.json";
const CHANGED: &str = "lintel://settings-changed";

/// Held for each read-merge-write of settings.json. Counts the writes, so a window can
/// tell an older snapshot from a newer one (Ruling 281).
#[derive(Default)]
pub struct SettingsLock(Mutex<u64>);

/// A whole-key replacement, made only if the key still holds `from` (missing or null: none).
/// Windows use it to repair a value they cannot read (Ruling 280).
#[derive(Deserialize)]
pub struct Repair {
    from: Option<Value>,
    to: Value,
}

/// Every stored setting after a write, and that write's number.
#[derive(Serialize)]
pub struct Written {
    revision: u64,
    entries: Map<String, Value>,
}

/// The `settings-changed` event: the keys a write changed, and its number.
#[derive(Serialize, Clone)]
struct Changed<'a> {
    revision: u64,
    changes: &'a Map<String, Value>,
}

/// Merges `patch` into settings.json, applies `replace`, saves, then tells every window
/// which keys changed. `defaults` stands in for a missing or malformed stored object.
/// Async, so a burst of saves never waits on the main thread (Ruling 281).
#[tauri::command]
pub async fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    lock: State<'_, SettingsLock>,
    patch: Map<String, Value>,
    defaults: Map<String, Value>,
    replace: Option<Map<String, Value>>,
) -> Result<Written, String> {
    let replace = parse_repairs(replace.unwrap_or_default())?;
    apply(&app, &lock, FILE, patch, &defaults, replace, |changed| {
        app.emit(CHANGED, changed).map_err(|err| err.to_string())
    })
}

fn parse_repairs(replace: Map<String, Value>) -> Result<Vec<(String, Repair)>, String> {
    replace
        .into_iter()
        .map(|(key, value)| {
            serde_json::from_value(value)
                .map(|repair| (key.clone(), repair))
                .map_err(|err| format!("Bad repair for {key}: {err}"))
        })
        .collect()
}

fn apply<R: Runtime>(
    app: &AppHandle<R>,
    lock: &SettingsLock,
    file: impl AsRef<Path>,
    patch: Map<String, Value>,
    defaults: &Map<String, Value>,
    replace: Vec<(String, Repair)>,
    notify: impl FnOnce(Changed) -> Result<(), String>,
) -> Result<Written, String> {
    let mut revision = lock.0.lock().unwrap_or_else(PoisonError::into_inner);
    // The same instance the windows load, which they open with auto-save off too.
    let store = StoreBuilder::new(app, file.as_ref())
        .disable_auto_save()
        .build()
        .map_err(|err| err.to_string())?;
    let mut changes = Map::new();
    let mut set = |key: String, value: Option<Value>| {
        match value {
            Some(value) => store.set(key.clone(), value),
            None => {
                store.delete(&key);
            }
        }
        changes.insert(key.clone(), store.get(&key).unwrap_or(Value::Null));
    };
    for (key, value) in patch {
        let base = with_defaults(store.get(&key), defaults.get(&key));
        set(key, merge(base, value));
    }
    for (key, repair) in replace {
        let held = store.get(&key).filter(|value| !value.is_null());
        if held == repair.from.filter(|value| !value.is_null()) {
            set(key, Some(repair.to).filter(|value| !value.is_null()));
        }
    }
    if !changes.is_empty() {
        store.set("version", 1);
        changes.insert("version".into(), Value::from(1));
        store
            .save()
            .map_err(|err| format!("Could not save settings: {err}"))?;
        *revision += 1;
        // Inside the lock, so windows hear the changes in the order they were saved.
        notify(Changed {
            revision: *revision,
            changes: &changes,
        })?;
    }
    Ok(Written {
        revision: *revision,
        entries: store.entries().into_iter().collect(),
    })
}

/// Objects merge key by key, `null` deletes a key, and any other value replaces.
fn merge(base: Option<Value>, patch: Value) -> Option<Value> {
    match patch {
        Value::Null => None,
        Value::Object(patch) => {
            let mut merged = match base {
                Some(Value::Object(base)) => base,
                _ => Map::new(),
            };
            for (key, value) in patch {
                let old = merged.remove(&key);
                if let Some(value) = merge(old, value) {
                    merged.insert(key, value);
                }
            }
            Some(Value::Object(merged))
        }
        value => Some(value),
    }
}

// Fills keys missing from a stored object from its default, so a patch to one nested key
// still leaves a whole, readable value.
fn with_defaults(stored: Option<Value>, default: Option<&Value>) -> Option<Value> {
    match (stored, default) {
        (Some(Value::Object(mut stored)), Some(Value::Object(default))) => {
            for (key, value) in default {
                let filled = with_defaults(stored.remove(key), Some(value));
                if let Some(filled) = filled {
                    stored.insert(key.clone(), filled);
                }
            }
            Some(Value::Object(stored))
        }
        (Some(_), Some(default)) if default.is_object() => Some(default.clone()),
        (Some(stored), _) => Some(stored),
        (None, default) => default.cloned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::{Listener, Manager};

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .manage(SettingsLock::default())
            .build(mock_context(noop_assets()))
            .unwrap()
    }

    // A fresh file per test, so tests can run in parallel.
    fn temp_file() -> std::path::PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lintel-settings-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("settings.json")
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn update(
        app: &AppHandle<MockRuntime>,
        file: &Path,
        patch: Value,
    ) -> Result<Map<String, Value>, String> {
        let defaults = object(json!({ "lint": { "enabled": true, "rules": { "default": true } } }));
        apply(
            app,
            &app.state::<SettingsLock>(),
            file,
            object(patch),
            &defaults,
            Vec::new(),
            |changed| app.emit(CHANGED, changed).map_err(|err| err.to_string()),
        )
        .map(|written| written.entries)
    }

    // The JS fake runs the same cases, so the two cannot drift apart (Ruling 280).
    #[test]
    fn every_shared_merge_case() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../src/test/settings-merge-cases.json")).unwrap();
        let app = app();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let file = temp_file();
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, case["stored"].to_string()).unwrap();
            let replace =
                parse_repairs(object(case.get("replace").cloned().unwrap_or(json!({})))).unwrap();

            let mut heard = json!({});
            let written = apply(
                app.handle(),
                &app.state::<SettingsLock>(),
                &file,
                object(case["patch"].clone()),
                &object(case["defaults"].clone()),
                replace,
                |changed| {
                    heard = Value::Object(changed.changes.clone());
                    Ok(())
                },
            )
            .unwrap();

            assert_eq!(
                Value::Object(written.entries),
                case["after"],
                "{name}: stored"
            );
            assert_eq!(heard, case["changes"], "{name}: changes");
        }
    }

    #[test]
    fn tells_every_window_the_changed_keys_and_the_write_number() {
        let app = app();
        let file = temp_file();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&heard);
        app.listen_any(CHANGED, move |e| {
            log.lock().unwrap().push(e.payload().to_owned())
        });
        update(app.handle(), &file, json!({ "theme": "dark" })).unwrap();

        update(
            app.handle(),
            &file,
            json!({ "lint": { "rules": { "MD013": false } } }),
        )
        .unwrap();

        let heard = heard.lock().unwrap();
        let last: Value = serde_json::from_str(heard.last().unwrap()).unwrap();
        assert_eq!(
            last,
            json!({
                "revision": 2,
                "changes": {
                    "lint": { "enabled": true, "rules": { "default": true, "MD013": false } },
                    "version": 1
                }
            })
        );
    }

    #[test]
    fn returns_the_write_number_which_a_write_that_changes_nothing_keeps() {
        let app = app();
        let file = temp_file();
        let lock = app.state::<SettingsLock>();
        let notified = std::cell::Cell::new(0);
        let write = |patch: Value, replace: Vec<(String, Repair)>| {
            apply(
                app.handle(),
                &lock,
                &file,
                object(patch),
                &Map::new(),
                replace,
                |_| {
                    notified.set(notified.get() + 1);
                    Ok(())
                },
            )
            .unwrap()
        };

        assert_eq!(write(json!({ "fontSize": 18 }), Vec::new()).revision, 1);
        let stale = vec![(
            "fontSize".to_owned(),
            Repair {
                from: Some(json!(3)),
                to: json!(16),
            },
        )];
        assert_eq!(write(json!({}), stale).revision, 1);
        assert_eq!(
            notified.get(),
            1,
            "told windows of a write that changed nothing"
        );
        assert_eq!(write(json!({ "fontSize": 20 }), Vec::new()).revision, 2);
    }

    // Tauri runs a sync command on the main thread, which a burst of saves would stall.
    #[test]
    fn update_settings_is_async() {
        assert!(include_str!("settings.rs").contains(concat!("pub async fn ", "update_settings")));
    }

    #[test]
    fn a_write_waits_until_the_write_before_it_is_done() {
        let app = app();
        let file = temp_file();
        let lock = app.state::<SettingsLock>();
        let held = lock.0.lock().unwrap();
        let handle = app.handle().clone();
        let writer = std::thread::spawn(move || {
            update(&handle, &file, json!({ "fontSize": 20 })).unwrap();
        });

        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !writer.is_finished(),
            "wrote while another write held the lock"
        );
        drop(held);
        writer.join().unwrap();
    }

    #[test]
    fn two_windows_writing_different_nested_keys_at_once_keep_both() {
        let app = app();
        let file = temp_file();
        const EACH: usize = 200;
        let start = Arc::new(Barrier::new(2));
        let writers: Vec<_> = ["main", "settings"]
            .into_iter()
            .map(|window| {
                let handle = app.handle().clone();
                let file = file.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    for i in 0..EACH {
                        let patch =
                            json!({ "lint": { "rules": { format!("{window}-{i}"): false } } });
                        update(&handle, &file, patch).unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }

        let all = update(app.handle(), &file, json!({})).unwrap();
        let rules = all["lint"]["rules"].as_object().unwrap();
        assert_eq!(rules.len(), 2 * EACH + 1, "a write was lost");
    }
}
