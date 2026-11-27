use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{Emitter, Manager, Runtime, State, Window, WindowEvent};

use crate::SETTINGS;

/// Sent to the window that owns a path when another window tries to open it.
pub const REVEAL_DOC: &str = "lintel://reveal-doc";
/// Sent to the document window that should build the app menu once its owner has closed.
pub const MENU_CLAIM: &str = "lintel://menu-claim";

#[derive(Clone, Serialize)]
pub struct RevealDocEvent {
    pub path: String,
}

/// Which window has each open file, so a file is never open in two places (spec), and the
/// hand-overs of docs between windows that are not yet decided.
#[derive(Default)]
pub struct PathRegistry(Mutex<Claims>);

#[derive(Default)]
struct Claims {
    /// Normalised path to window label.
    paths: HashMap<String, String>,
    handoffs: HashMap<u64, Handoff>,
    next_handoff: u64,
    /// The window each completed hand-over went to, oldest first.
    adopters: Vec<String>,
}

/// Where hand-overs stand app-wide, for a quit round (Ruling 235).
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct HandoffStatus {
    /// Hand-overs not yet decided.
    pending: usize,
    /// Hand-overs completed so far; pass it back as `since` next time.
    completed: usize,
    /// Windows that took in a doc after `since`, each once.
    adopters: Vec<String>,
}

struct Handoff {
    from: String,
    to: String,
    path: Option<String>,
    /// Set when one of the two windows has closed: only the other may then decide it.
    left_to: Option<String>,
}

impl Handoff {
    fn may_decide(&self, label: &str) -> bool {
        self.left_to
            .as_deref()
            .is_none_or(|survivor| survivor == label)
    }
}

impl PathRegistry {
    /// The label of another window that owns `path`, or None once `label` owns it.
    fn claim(&self, label: &str, path: &str) -> Option<String> {
        let paths = &mut self.claims().paths;
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
        let paths = &mut self.claims().paths;
        if paths.get(path).is_some_and(|owner| owner == label) {
            paths.remove(path);
        }
    }

    // The path stays with `from` until the hand-over is decided.
    fn begin_handoff(&self, from: &str, to: &str, path: Option<String>) -> u64 {
        let mut claims = self.claims();
        claims.next_handoff += 1;
        let id = claims.next_handoff;
        let handoff = Handoff {
            from: from.to_owned(),
            to: to.to_owned(),
            path,
            left_to: None,
        };
        claims.handoffs.insert(id, handoff);
        id
    }

    /// True when `label` may take the doc in: the hand-over was to it and is not cancelled.
    fn complete_handoff(&self, label: &str, id: u64) -> bool {
        let mut claims = self.claims();
        if claims
            .handoffs
            .get(&id)
            .is_none_or(|h| h.to != label || !h.may_decide(label))
        {
            return false;
        }
        let Some(handoff) = claims.handoffs.remove(&id) else {
            return false;
        };
        claims.adopters.push(handoff.to.clone());
        if let Some(path) = handoff.path {
            // A third window may have the file if the opener closed meanwhile; it keeps it.
            let owner = claims.paths.get(&path);
            if owner.is_none_or(|owner| *owner == handoff.from) {
                claims.paths.insert(path, handoff.to);
            }
        }
        true
    }

    fn status(&self, since: usize) -> HandoffStatus {
        let claims = self.claims();
        let mut adopters: Vec<String> = Vec::new();
        for label in claims.adopters.iter().skip(since) {
            if !adopters.contains(label) {
                adopters.push(label.clone());
            }
        }
        HandoffStatus {
            pending: claims.handoffs.len(),
            completed: claims.adopters.len(),
            adopters,
        }
    }

    /// True when `label` may keep the doc: the hand-over was from it and is not completed.
    fn cancel_handoff(&self, label: &str, id: u64) -> bool {
        let mut claims = self.claims();
        if claims
            .handoffs
            .get(&id)
            .is_none_or(|h| h.from != label || !h.may_decide(label))
        {
            return false;
        }
        claims.handoffs.remove(&id).is_some()
    }

    /// Drops a closed window's claims. Its pending hand-overs go to the other window, so
    /// the doc is not lost with it, and none is kept once both windows are gone (Ruling 217).
    pub fn drop_window(&self, label: &str) {
        let mut claims = self.claims();
        claims.paths.retain(|_, owner| owner != label);
        claims
            .handoffs
            .retain(|_, h| h.left_to.as_deref() != Some(label));
        for handoff in claims.handoffs.values_mut() {
            if handoff.left_to.is_some() {
                continue;
            }
            if handoff.from == label {
                handoff.left_to = Some(handoff.to.clone());
            } else if handoff.to == label {
                handoff.left_to = Some(handoff.from.clone());
            }
        }
    }

    #[cfg(test)]
    fn pending(&self) -> usize {
        self.claims().handoffs.len()
    }

    fn claims(&self) -> MutexGuard<'_, Claims> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Claims `path` for the calling window, or shows it in the window that owns it and
/// returns that window's label.
#[tauri::command]
pub fn claim_path<R: Runtime>(
    window: Window<R>,
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
pub fn release_path<R: Runtime>(
    window: Window<R>,
    registry: State<'_, PathRegistry>,
    path: String,
) {
    registry.release(window.label(), &path);
}

/// Starts handing the calling window's doc, and its `path` if it has one, to the window
/// `to_label`. Returns the hand-over id that `complete_handoff` and `cancel_handoff` take;
/// exactly one of them succeeds, so the doc ends in one window (Ruling 213).
#[tauri::command]
pub fn transfer_path<R: Runtime>(
    window: Window<R>,
    registry: State<'_, PathRegistry>,
    path: Option<String>,
    to_label: String,
) -> u64 {
    registry.begin_handoff(window.label(), &to_label, path)
}

/// Called by the new window before it shows the doc. False means it must drop it.
#[tauri::command]
pub fn complete_handoff<R: Runtime>(
    window: Window<R>,
    registry: State<'_, PathRegistry>,
    id: u64,
) -> bool {
    registry.complete_handoff(window.label(), id)
}

/// Called by the opener when the new window did not confirm in time. False means the new
/// window has the doc after all.
#[tauri::command]
pub fn cancel_handoff<R: Runtime>(
    window: Window<R>,
    registry: State<'_, PathRegistry>,
    id: u64,
) -> bool {
    registry.cancel_handoff(window.label(), id)
}

/// Pending hand-overs and the windows that took a doc in since `since`, for a quit round.
#[tauri::command]
pub fn handoff_status(registry: State<'_, PathRegistry>, since: usize) -> HandoffStatus {
    registry.status(since)
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

/// The app's window-event hook: keeps the registry and focus order current, and hands the
/// app menu on when a document window closes.
pub fn on_doc_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let app = window.app_handle();
    let open = || app.webview_windows().into_keys().collect();
    let registry = window.state::<PathRegistry>();
    let focus = window.state::<FocusOrder>();
    if let Some(owner) = on_window_event(&registry, &focus, window.label(), event, open) {
        if let Err(err) = app.emit_to(owner.as_str(), MENU_CLAIM, ()) {
            eprintln!("Could not hand the menu to {owner}: {err}");
        }
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

    const A: &str = "/notes/a.md";

    #[test]
    fn a_completed_hand_over_gives_the_path_to_the_new_window() {
        let registry = PathRegistry::default();
        registry.claim("main", A);
        let id = registry.begin_handoff("main", "w-1", Some(A.to_owned()));
        assert_eq!(
            registry.claim("w-2", A),
            Some("main".to_owned()),
            "still the opener's"
        );
        assert!(registry.complete_handoff("w-1", id));
        assert!(!registry.cancel_handoff("main", id), "too late to cancel");
        assert_eq!(registry.claim("main", A), Some("w-1".to_owned()));
    }

    #[test]
    fn a_cancelled_hand_over_leaves_the_path_with_the_opener() {
        let registry = PathRegistry::default();
        registry.claim("main", A);
        let id = registry.begin_handoff("main", "w-1", Some(A.to_owned()));
        assert!(registry.cancel_handoff("main", id));
        assert!(
            !registry.complete_handoff("w-1", id),
            "too late to take it in"
        );
        assert_eq!(registry.claim("w-1", A), Some("main".to_owned()));
    }

    #[test]
    fn the_new_window_takes_the_doc_when_the_opener_dies_mid_hand_over() {
        let registry = PathRegistry::default();
        registry.claim("main", A);
        let id = registry.begin_handoff("main", "w-1", Some(A.to_owned()));
        registry.drop_window("main");
        assert!(!registry.cancel_handoff("main", id));
        assert!(registry.complete_handoff("w-1", id));
        assert_eq!(registry.claim("w-2", A), Some("w-1".to_owned()));
        assert_eq!(registry.pending(), 0);
    }

    #[test]
    fn the_opener_keeps_the_doc_when_the_new_window_dies_mid_hand_over() {
        let registry = PathRegistry::default();
        let id = registry.begin_handoff("main", "w-1", Some(A.to_owned()));
        registry.drop_window("w-1");
        assert!(!registry.complete_handoff("w-1", id));
        assert!(registry.cancel_handoff("main", id));
        assert_eq!(registry.pending(), 0);
    }

    #[test]
    fn reports_pending_hand_overs_and_the_windows_that_took_docs_in() {
        let registry = PathRegistry::default();
        let first = registry.begin_handoff("main", "w-1", None);
        let second = registry.begin_handoff("main", "w-2", None);
        assert_eq!(
            registry.status(0),
            HandoffStatus { pending: 2, completed: 0, adopters: vec![] }
        );
        assert!(registry.complete_handoff("w-1", first));
        let mark = registry.status(0);
        assert_eq!(mark.pending, 1);
        assert_eq!(mark.adopters, ["w-1"]);
        assert!(registry.cancel_handoff("main", second));
        let third = registry.begin_handoff("w-2", "w-1", None);
        assert!(registry.complete_handoff("w-1", third));
        let later = registry.status(mark.completed);
        assert_eq!((later.pending, later.completed), (0, 2));
        assert_eq!(later.adopters, ["w-1"], "only since the mark, each window once");
    }

    #[test]
    fn no_hand_over_is_kept_once_both_windows_are_gone() {
        let registry = PathRegistry::default();
        registry.begin_handoff("main", "w-1", None);
        registry.begin_handoff("main", "w-2", None);
        registry.drop_window("main");
        registry.drop_window("w-1");
        assert_eq!(registry.pending(), 1, "w-2 may still take its doc");
        registry.drop_window("w-2");
        assert_eq!(registry.pending(), 0);
    }

    #[test]
    fn only_the_two_windows_of_a_hand_over_can_decide_it() {
        let registry = PathRegistry::default();
        let id = registry.begin_handoff("main", "w-1", None);
        assert!(!registry.complete_handoff("main", id));
        assert!(!registry.complete_handoff("w-2", id));
        assert!(!registry.cancel_handoff("w-1", id));
        assert!(!registry.complete_handoff("w-1", id + 1));
        assert!(registry.complete_handoff("w-1", id));
    }

    #[test]
    fn a_new_window_that_dies_mid_hand_over_leaves_the_file_with_the_opener() {
        let registry = PathRegistry::default();
        registry.claim("main", A);
        let id = registry.begin_handoff("main", "w-1", Some(A.to_owned()));
        registry.drop_window("w-1");
        assert_eq!(
            registry.claim("w-2", A),
            Some("main".to_owned()),
            "a third window cannot take it"
        );
        assert!(registry.cancel_handoff("main", id));
        assert_eq!(registry.claim("w-2", A), Some("main".to_owned()));
    }

    #[test]
    fn completing_never_takes_the_file_from_a_third_window() {
        let registry = PathRegistry::default();
        registry.claim("main", A);
        let id = registry.begin_handoff("main", "w-1", Some(A.to_owned()));
        registry.drop_window("main");
        registry.claim("w-2", A);
        assert!(registry.complete_handoff("w-1", id));
        assert_eq!(registry.claim("w-1", A), Some("w-2".to_owned()));
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

    mod in_the_app {
        use super::*;
        use std::sync::Arc;
        use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
        use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

        fn app() -> tauri::App<MockRuntime> {
            mock_builder()
                .manage(PathRegistry::default())
                .manage(FocusOrder::default())
                .build(mock_context(noop_assets()))
                .unwrap()
        }

        fn window(app: &tauri::App<MockRuntime>, label: &str) -> Window<MockRuntime> {
            WebviewWindowBuilder::new(app, label, WebviewUrl::default())
                .build()
                .unwrap();
            app.get_webview_window(label).unwrap().as_ref().window()
        }

        fn heard(window: &Window<MockRuntime>, event: &'static str) -> Arc<Mutex<Vec<String>>> {
            let heard = Arc::new(Mutex::new(Vec::new()));
            let log = Arc::clone(&heard);
            window.listen(event, move |e| {
                log.lock().unwrap().push(e.payload().to_owned())
            });
            heard
        }

        #[test]
        fn claim_path_reveals_the_doc_in_the_owner_only() {
            let app = app();
            let main = window(&app, "main");
            let w1 = window(&app, "w-1");
            let in_main = heard(&main, REVEAL_DOC);
            let in_w1 = heard(&w1, REVEAL_DOC);

            assert_eq!(claim_path(w1.clone(), app.state(), A.to_owned()), None);
            assert_eq!(
                claim_path(main.clone(), app.state(), A.to_owned()),
                Some("w-1".to_owned())
            );

            assert_eq!(*in_w1.lock().unwrap(), [r#"{"path":"/notes/a.md"}"#]);
            assert!(in_main.lock().unwrap().is_empty());
        }

        #[test]
        fn a_destroyed_window_loses_its_claims_and_the_menu_goes_on() {
            let app = app();
            let main = window(&app, "main");
            let w1 = window(&app, "w-1");
            let claims_in_main = heard(&main, MENU_CLAIM);
            on_doc_window_event(&main, &WindowEvent::Focused(true));
            on_doc_window_event(&w1, &WindowEvent::Focused(true));
            claim_path(w1.clone(), app.state(), A.to_owned());

            on_doc_window_event(&w1, &WindowEvent::Destroyed);

            assert_eq!(claim_path(main.clone(), app.state(), A.to_owned()), None);
            assert_eq!(claims_in_main.lock().unwrap().len(), 1);
        }
    }
}
