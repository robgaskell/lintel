use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{Emitter, State, Window};

/// Sent to the window that owns a path when another window tries to open it.
pub const REVEAL_DOC: &str = "lintel://reveal-doc";

#[derive(Clone, Serialize)]
pub struct RevealDocEvent {
    pub path: String,
}

/// Which window has each open file, so a file is never open in two places (spec).
/// Keys are normalised paths, values window labels.
#[derive(Default)]
pub struct PathRegistry(Mutex<HashMap<String, String>>);

impl PathRegistry {
    /// The label of another window that owns `path`, or None once `label` owns it.
    fn claim(&self, label: &str, path: &str) -> Option<String> {
        let mut paths = self.paths();
        match paths.get(path) {
            Some(owner) if owner != label => Some(owner.clone()),
            _ => {
                paths.insert(path.to_owned(), label.to_owned());
                None
            }
        }
    }

    // A late release from the window a doc moved out of must not drop the new owner's claim.
    fn release(&self, label: &str, path: &str) {
        let mut paths = self.paths();
        if paths.get(path).is_some_and(|owner| owner == label) {
            paths.remove(path);
        }
    }

    pub fn drop_window(&self, label: &str) {
        self.paths().retain(|_, owner| owner != label);
    }

    fn paths(&self) -> MutexGuard<'_, HashMap<String, String>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Claims `path` for the calling window, or shows it in the window that owns it and
/// returns that window's label.
#[tauri::command]
pub fn claim_path(
    window: Window,
    registry: State<'_, PathRegistry>,
    path: String,
) -> Option<String> {
    let owner = registry.claim(window.label(), &path)?;
    if let Err(err) = window.emit_to(owner.as_str(), REVEAL_DOC, RevealDocEvent { path }) {
        eprintln!("Could not reveal the document in {owner}: {err}");
    }
    Some(owner)
}

/// Drops the calling window's claim on `path`; another window's claim stays.
#[tauri::command]
pub fn release_path(window: Window, registry: State<'_, PathRegistry>, path: String) {
    registry.release(window.label(), &path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_window_is_told_the_first_owner() {
        let registry = PathRegistry::default();
        assert_eq!(registry.claim("main", "/notes/a.md"), None);
        assert_eq!(
            registry.claim("w-1", "/notes/a.md"),
            Some("main".to_owned())
        );
        assert_eq!(
            registry.claim("w-2", "/notes/a.md"),
            Some("main".to_owned())
        );
    }

    #[test]
    fn the_owner_can_claim_its_own_path_again() {
        let registry = PathRegistry::default();
        assert_eq!(registry.claim("main", "/notes/a.md"), None);
        assert_eq!(registry.claim("main", "/notes/a.md"), None);
    }

    #[test]
    fn a_released_path_can_be_claimed_by_another_window() {
        let registry = PathRegistry::default();
        registry.claim("main", "/notes/a.md");
        registry.release("main", "/notes/a.md");
        assert_eq!(registry.claim("w-1", "/notes/a.md"), None);
        assert_eq!(
            registry.claim("main", "/notes/a.md"),
            Some("w-1".to_owned())
        );
    }

    #[test]
    fn only_the_owner_can_release_a_path() {
        let registry = PathRegistry::default();
        registry.claim("w-1", "/notes/a.md");
        registry.release("main", "/notes/a.md");
        assert_eq!(
            registry.claim("main", "/notes/a.md"),
            Some("w-1".to_owned())
        );
    }

    #[test]
    fn destroying_a_window_drops_its_claims_only() {
        let registry = PathRegistry::default();
        registry.claim("w-1", "/notes/a.md");
        registry.claim("w-1", "/notes/b.md");
        registry.claim("main", "/notes/c.md");
        registry.drop_window("w-1");
        assert_eq!(registry.claim("w-2", "/notes/a.md"), None);
        assert_eq!(registry.claim("w-2", "/notes/b.md"), None);
        assert_eq!(
            registry.claim("w-2", "/notes/c.md"),
            Some("main".to_owned())
        );
    }
}
