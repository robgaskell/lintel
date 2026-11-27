use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{Emitter, State, Window, WindowEvent};

use crate::SETTINGS;

/// Sent to the window that owns a path when another window tries to open it.
pub const REVEAL_DOC: &str = "lintel://reveal-doc";
/// Sent to the document window that should build the app menu once its owner has closed.
pub const MENU_CLAIM: &str = "lintel://menu-claim";

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

    fn transfer(&self, path: &str, to: &str) {
        self.paths().insert(path.to_owned(), to.to_owned());
    }

    pub fn drop_window(&self, label: &str) {
        self.paths().retain(|_, owner| owner != label);
    }

    fn paths(&self) -> MutexGuard<'_, HashMap<String, String>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
    claim_or_reveal(&registry, window.label(), path, |owner, event| {
        if let Err(err) = window.emit_to(owner, REVEAL_DOC, event) {
            eprintln!("Could not reveal the document in {owner}: {err}");
        }
    })
}

/// Drops the calling window's claim on `path`; another window's claim stays.
#[tauri::command]
pub fn release_path(window: Window, registry: State<'_, PathRegistry>, path: String) {
    registry.release(window.label(), &path);
}

/// Gives `path` to the window `to_label` in one step, so no other window can claim it
/// in between, as a release and a claim would allow (Ruling 197).
#[tauri::command]
pub fn transfer_path(registry: State<'_, PathRegistry>, path: String, to_label: String) {
    registry.transfer(&path, &to_label);
}

fn claim_or_reveal(
    registry: &PathRegistry,
    label: &str,
    path: String,
    reveal: impl FnOnce(&str, RevealDocEvent),
) -> Option<String> {
    let owner = registry.claim(label, &path)?;
    reveal(&owner, RevealDocEvent { path });
    Some(owner)
}

/// Document windows, most recently focused first. Settings is never one.
#[derive(Default)]
pub struct FocusOrder(Mutex<Vec<String>>);

impl FocusOrder {
    fn labels(&self) -> MutexGuard<'_, Vec<String>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Keeps the registry and the focus order current. Returns the window that should take
/// the app menu, when the window that closed may have owned it (Ruling 198).
pub fn on_window_event(
    registry: &PathRegistry,
    focus: &FocusOrder,
    label: &str,
    event: &WindowEvent,
    open: impl FnOnce() -> Vec<String>,
) -> Option<String> {
    match event {
        WindowEvent::Focused(true) if label != SETTINGS => {
            let mut order = focus.labels();
            order.retain(|other| other != label);
            order.insert(0, label.to_owned());
            None
        }
        WindowEvent::Destroyed => {
            registry.drop_window(label);
            focus.labels().retain(|other| other != label);
            if label == SETTINGS {
                return None;
            }
            // `open` may still list the closed window, and a new window may not have had focus yet.
            let open: Vec<String> = open()
                .into_iter()
                .filter(|other| other != label && other != SETTINGS)
                .collect();
            let order = focus.labels();
            order
                .iter()
                .find(|other| open.contains(other))
                .or_else(|| open.first())
                .cloned()
        }
        _ => None,
    }
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
    fn a_transfer_gives_the_path_to_the_new_window_at_once() {
        let registry = PathRegistry::default();
        registry.claim("main", "/notes/a.md");
        registry.transfer("/notes/a.md", "w-1");
        assert_eq!(
            registry.claim("main", "/notes/a.md"),
            Some("w-1".to_owned())
        );
        registry.release("main", "/notes/a.md");
        assert_eq!(registry.claim("w-1", "/notes/a.md"), None);
    }

    #[test]
    fn a_second_claim_reveals_the_doc_in_its_owner() {
        let registry = PathRegistry::default();
        let mut revealed = Vec::new();
        let mut claim = |label: &str| {
            claim_or_reveal(
                &registry,
                label,
                "/notes/a.md".to_owned(),
                |owner, event| revealed.push((owner.to_owned(), event.path)),
            )
        };
        assert_eq!(claim("w-1"), None);
        assert_eq!(claim("main"), Some("w-1".to_owned()));
        assert_eq!(claim("w-1"), None, "the owner is never revealed to itself");
        assert_eq!(revealed, [("w-1".to_owned(), "/notes/a.md".to_owned())]);
    }

    fn event(
        registry: &PathRegistry,
        focus: &FocusOrder,
        label: &str,
        event: WindowEvent,
        open: &[&str],
    ) -> Option<String> {
        let open: Vec<String> = open.iter().map(|l| l.to_string()).collect();
        on_window_event(registry, focus, label, &event, || open)
    }

    #[test]
    fn a_destroyed_window_drops_its_claims() {
        let registry = PathRegistry::default();
        let focus = FocusOrder::default();
        registry.claim("w-1", "/notes/a.md");
        event(&registry, &focus, "w-1", WindowEvent::Destroyed, &["main"]);
        assert_eq!(registry.claim("main", "/notes/a.md"), None);
    }

    #[test]
    fn the_menu_goes_to_the_most_recently_focused_document_window() {
        let registry = PathRegistry::default();
        let focus = FocusOrder::default();
        for label in ["main", "w-2", "w-1", SETTINGS] {
            event(&registry, &focus, label, WindowEvent::Focused(true), &[]);
        }
        let open = ["main", "w-1", "w-2", SETTINGS];
        assert_eq!(
            event(&registry, &focus, "w-1", WindowEvent::Destroyed, &open),
            Some("w-2".to_owned())
        );
        assert_eq!(
            event(
                &registry,
                &focus,
                "w-2",
                WindowEvent::Destroyed,
                &["main", SETTINGS]
            ),
            Some("main".to_owned())
        );
    }

    #[test]
    fn the_menu_goes_to_a_window_never_focused_rather_than_nowhere() {
        let registry = PathRegistry::default();
        let focus = FocusOrder::default();
        event(&registry, &focus, "main", WindowEvent::Focused(true), &[]);
        assert_eq!(
            event(
                &registry,
                &focus,
                "main",
                WindowEvent::Destroyed,
                &["main", "w-1", SETTINGS]
            ),
            Some("w-1".to_owned())
        );
    }

    #[test]
    fn closing_settings_or_the_last_window_gives_the_menu_to_no_one() {
        let registry = PathRegistry::default();
        let focus = FocusOrder::default();
        event(&registry, &focus, "main", WindowEvent::Focused(true), &[]);
        assert_eq!(
            event(
                &registry,
                &focus,
                SETTINGS,
                WindowEvent::Destroyed,
                &["main"]
            ),
            None
        );
        assert_eq!(
            event(
                &registry,
                &focus,
                "main",
                WindowEvent::Destroyed,
                &[SETTINGS]
            ),
            None
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
