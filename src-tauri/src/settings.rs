//! Every window's settings changes are applied here, one at a time (Rulings 169, 271).
//! Two windows each merging into their own copy could undo each other's change.

use std::path::Path;
use std::sync::{Mutex, PoisonError};

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_store::StoreBuilder;

const FILE: &str = "settings.json";
const CHANGED: &str = "lintel://settings-changed";

/// Held for each read-merge-write of settings.json.
#[derive(Default)]
pub struct SettingsLock(Mutex<()>);

/// Merges `patch` into settings.json and saves it, then tells every window which keys
/// changed. `defaults` stands in for a missing or malformed stored object. Returns every
/// stored setting.
#[tauri::command]
pub fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    lock: State<'_, SettingsLock>,
    patch: Map<String, Value>,
    defaults: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    apply(&app, &lock, FILE, patch, &defaults)
}

fn apply<R: Runtime>(
    app: &AppHandle<R>,
    lock: &SettingsLock,
    file: impl AsRef<Path>,
    patch: Map<String, Value>,
    defaults: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let _held = lock.0.lock().unwrap_or_else(PoisonError::into_inner);
    // The same instance the windows load, which they open with auto-save off too.
    let store = StoreBuilder::new(app, file.as_ref())
        .disable_auto_save()
        .build()
        .map_err(|err| err.to_string())?;
    let mut changes = Map::new();
    for (key, value) in patch {
        let base = with_defaults(store.get(&key), defaults.get(&key));
        match merge(base, value) {
            Some(merged) => store.set(key.clone(), merged.clone()),
            None => {
                store.delete(&key);
            }
        }
        changes.insert(key.clone(), store.get(&key).unwrap_or(Value::Null));
    }
    store.set("version", 1);
    changes.insert("version".into(), Value::from(1));
    store
        .save()
        .map_err(|err| format!("Could not save settings: {err}"))?;
    // Inside the lock, so windows hear the changes in the order they were saved.
    app.emit(CHANGED, &changes).map_err(|err| err.to_string())?;
    Ok(store.entries().into_iter().collect())
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
        apply(app, &app.state::<SettingsLock>(), file, object(patch), &defaults)
    }

    #[test]
    fn merges_nested_keys_and_deletes_null_ones() {
        let app = app();
        let file = temp_file();
        update(app.handle(), &file, json!({ "lint": { "rules": { "MD004": false } } })).unwrap();

        let all = update(
            app.handle(),
            &file,
            json!({ "lint": { "rules": { "ul-style": false, "MD004": null } }, "fontSize": 18 }),
        )
        .unwrap();

        assert_eq!(
            all["lint"],
            json!({ "enabled": true, "rules": { "default": true, "ul-style": false } })
        );
        assert_eq!(all["fontSize"], json!(18));
        assert_eq!(all["version"], json!(1));
        let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(saved["lint"], all["lint"]);
    }

    #[test]
    fn a_malformed_stored_object_is_replaced_by_its_default() {
        let app = app();
        let file = temp_file();
        update(app.handle(), &file, json!({ "lint": "garbage" })).unwrap();

        let all = update(app.handle(), &file, json!({ "lint": { "enabled": false } })).unwrap();

        assert_eq!(
            all["lint"],
            json!({ "enabled": false, "rules": { "default": true } })
        );
    }

    #[test]
    fn tells_every_window_only_the_changed_keys() {
        let app = app();
        let file = temp_file();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&heard);
        app.listen_any(CHANGED, move |e| log.lock().unwrap().push(e.payload().to_owned()));
        update(app.handle(), &file, json!({ "theme": "dark" })).unwrap();

        update(app.handle(), &file, json!({ "lint": { "rules": { "MD013": false } } })).unwrap();

        let heard = heard.lock().unwrap();
        let last: Value = serde_json::from_str(heard.last().unwrap()).unwrap();
        assert_eq!(
            last,
            json!({
                "lint": { "enabled": true, "rules": { "default": true, "MD013": false } },
                "version": 1
            })
        );
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
        assert!(!writer.is_finished(), "wrote while another write held the lock");
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
                        let patch = json!({ "lint": { "rules": { format!("{window}-{i}"): false } } });
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
