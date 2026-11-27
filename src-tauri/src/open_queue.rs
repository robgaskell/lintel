use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Window, WindowEvent};

use crate::SETTINGS;

/// Sent to a document window with paths opened from outside Lintel.
pub const OPEN_FILES: &str = "lintel://open-files";

const MAIN: &str = "main";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OpenFilesEvent {
    pub paths: Vec<String>,
}

/// Paths opened from outside Lintel. They wait here until a window can open them, as macOS
/// may send them before any webview has loaded (spec, "Opening paths").
#[derive(Default)]
pub struct OpenQueue {
    ready: HashSet<String>,
    pending: Vec<String>,
    last_focused: Option<String>,
}

/// Sends `OpenFilesEvent`s; a trait so the queue can be tested without an app.
pub trait OpenFilesEmitter {
    fn open_files(&self, label: &str, event: OpenFilesEvent);
}

impl<R: Runtime> OpenFilesEmitter for AppHandle<R> {
    fn open_files(&self, label: &str, event: OpenFilesEvent) {
        if let Err(err) = self.emit_to(label, OPEN_FILES, event) {
            eprintln!("Could not send opened files to {label}: {err}");
        }
    }
}

impl OpenQueue {
    /// Sends `paths` to the window that should open them, or keeps them until one is ready.
    pub fn push(&mut self, paths: Vec<String>, emitter: &impl OpenFilesEmitter) {
        if paths.is_empty() {
            return;
        }
        match self.target() {
            Some(label) => emitter.open_files(&label, OpenFilesEvent { paths }),
            None => self.pending.extend(paths),
        }
    }

    /// Marks `label` ready and hands it every path kept so far. Settings opens no files.
    pub fn ready(&mut self, label: &str) -> Vec<String> {
        if label == SETTINGS {
            return Vec::new();
        }
        self.ready.insert(label.to_owned());
        std::mem::take(&mut self.pending)
    }

    /// Keeps the target in step with the focus order, whose front is `most_recent`.
    pub fn window_event(&mut self, label: &str, event: &WindowEvent, most_recent: Option<String>) {
        match event {
            WindowEvent::Focused(true) => self.last_focused = most_recent,
            WindowEvent::Destroyed => {
                self.ready.remove(label);
                self.last_focused = most_recent;
            }
            _ => {}
        }
    }

    // The most recently focused ready window, else main (Ruling 230). A window may be ready
    // without ever having had focus, as at a launch from `open -g`.
    fn target(&self) -> Option<String> {
        let ready = |label: &&String| self.ready.contains(label.as_str());
        self.last_focused
            .as_ref()
            .filter(ready)
            .or_else(|| self.ready.get(MAIN))
            .or_else(|| self.ready.iter().min())
            .cloned()
    }
}

/// Paths from a command line: the program name and options are skipped, and relative paths
/// are taken from `cwd`, the folder the command ran in (Ruling 231).
pub fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &str) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
        .map(|arg| Path::new(cwd).join(arg).to_string_lossy().into_owned())
        .collect()
}

/// The local files among the URLs macOS passes to `RunEvent::Opened`.
#[cfg(target_os = "macos")]
pub fn paths_from_urls(urls: &[tauri::Url]) -> Vec<String> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// Opens `paths` from outside Lintel. Nothing here shows or focuses a window (Ruling 229).
pub fn open_from_outside<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    lock(&app.state::<Mutex<OpenQueue>>()).push(paths, app);
}

/// Called by a document window once it listens for `OPEN_FILES`. Returns the paths that
/// were opened before any window was ready; later windows get none.
#[tauri::command]
pub fn frontend_ready<R: Runtime>(
    window: Window<R>,
    queue: State<'_, Mutex<OpenQueue>>,
) -> Vec<String> {
    lock(&queue).ready(window.label())
}

pub fn lock(queue: &Mutex<OpenQueue>) -> MutexGuard<'_, OpenQueue> {
    queue
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Sent(RefCell<Vec<(String, Vec<String>)>>);

    impl OpenFilesEmitter for Sent {
        fn open_files(&self, label: &str, event: OpenFilesEvent) {
            self.0.borrow_mut().push((label.to_owned(), event.paths));
        }
    }

    impl Sent {
        fn take(&self) -> Vec<(String, Vec<String>)> {
            std::mem::take(&mut self.0.borrow_mut())
        }
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn args(list: &[&str]) -> Vec<String> {
        paths(list)
    }

    #[cfg(not(windows))]
    #[test]
    fn argv_paths_skip_options_and_resolve_against_the_cwd() {
        assert_eq!(
            paths_from_args(
                args(&["lintel", "notes.md", "--flag", "/abs/b.md"]),
                "/tmp/x"
            ),
            ["/tmp/x/notes.md", "/abs/b.md"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn argv_paths_skip_options_and_resolve_against_the_cwd() {
        assert_eq!(
            paths_from_args(
                args(&["lintel.exe", "notes.md", "--flag", r"C:\abs\b.md"]),
                r"C:\x"
            ),
            [r"C:\x\notes.md", r"C:\abs\b.md"]
        );
    }

    #[test]
    fn argv_with_no_files_gives_no_paths() {
        assert!(paths_from_args(args(&["lintel"]), "/tmp/x").is_empty());
        assert!(paths_from_args(args(&["lintel", "-psn_0_123", ""]), "/tmp/x").is_empty());
        assert!(paths_from_args(Vec::new(), "/tmp/x").is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opened_urls_give_their_local_paths() {
        let urls = [
            tauri::Url::parse("file:///tmp/my%20notes.md").unwrap(),
            tauri::Url::parse("https://example.com/a.md").unwrap(),
        ];
        assert_eq!(paths_from_urls(&urls), ["/tmp/my notes.md"]);
    }

    #[test]
    fn paths_pushed_before_ready_are_handed_over_exactly_once() {
        let mut queue = OpenQueue::default();
        let sent = Sent::default();
        queue.push(paths(&["/a.md"]), &sent);
        queue.push(paths(&["/b.md"]), &sent);
        assert!(sent.take().is_empty(), "nothing is ready to hear them");

        assert_eq!(queue.ready("main"), ["/a.md", "/b.md"]);
        assert!(queue.ready("main").is_empty());
        assert!(queue.ready("w-1").is_empty());
        assert!(sent.take().is_empty());
    }

    #[test]
    fn after_ready_a_push_is_sent_not_kept() {
        let mut queue = OpenQueue::default();
        let sent = Sent::default();
        queue.ready("main");

        queue.push(paths(&["/a.md"]), &sent);

        assert_eq!(sent.take(), [("main".to_owned(), paths(&["/a.md"]))]);
        assert!(queue.ready("w-1").is_empty(), "nothing was kept");
    }

    #[test]
    fn an_empty_push_sends_nothing() {
        let mut queue = OpenQueue::default();
        let sent = Sent::default();
        queue.ready("main");
        queue.push(Vec::new(), &sent);
        assert!(sent.take().is_empty());
    }

    #[test]
    fn settings_is_never_ready_and_takes_no_paths() {
        let mut queue = OpenQueue::default();
        let sent = Sent::default();
        queue.push(paths(&["/a.md"]), &sent);

        assert!(queue.ready(SETTINGS).is_empty());
        queue.push(paths(&["/b.md"]), &sent);

        assert!(sent.take().is_empty());
        assert_eq!(queue.ready("main"), ["/a.md", "/b.md"]);
    }

    #[test]
    fn paths_go_to_the_most_recently_focused_ready_window() {
        let mut queue = OpenQueue::default();
        let sent = Sent::default();
        queue.ready("main");
        queue.ready("w-1");
        queue.window_event("w-1", &WindowEvent::Focused(true), Some("w-1".to_owned()));

        queue.push(paths(&["/a.md"]), &sent);

        assert_eq!(sent.take(), [("w-1".to_owned(), paths(&["/a.md"]))]);
    }

    #[test]
    fn with_no_focused_window_ready_paths_go_to_main() {
        let mut queue = OpenQueue::default();
        let sent = Sent::default();
        queue.ready("w-1");
        queue.ready("main");
        queue.window_event("w-2", &WindowEvent::Focused(true), Some("w-2".to_owned()));

        queue.push(paths(&["/a.md"]), &sent);

        assert_eq!(sent.take(), [("main".to_owned(), paths(&["/a.md"]))]);
    }

    #[test]
    fn a_closed_window_gets_no_paths_and_the_next_in_focus_order_does() {
        let mut queue = OpenQueue::default();
        let sent = Sent::default();
        queue.ready("w-1");
        queue.ready("w-2");
        queue.window_event("w-1", &WindowEvent::Focused(true), Some("w-1".to_owned()));
        queue.window_event("w-1", &WindowEvent::Destroyed, Some("w-2".to_owned()));

        queue.push(paths(&["/a.md"]), &sent);
        assert_eq!(sent.take(), [("w-2".to_owned(), paths(&["/a.md"]))]);

        queue.window_event("w-2", &WindowEvent::Destroyed, None);
        queue.push(paths(&["/b.md"]), &sent);
        assert!(sent.take().is_empty(), "no window is left to send to");
        assert_eq!(queue.ready("w-3"), ["/b.md"]);
    }

    mod in_the_app {
        use super::*;
        use std::sync::Arc;
        use tauri::test::{mock_builder, mock_context, noop_assets};
        use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

        #[test]
        fn a_push_after_ready_reaches_only_the_ready_window() {
            let app = mock_builder()
                .manage(Mutex::new(OpenQueue::default()))
                .build(mock_context(noop_assets()))
                .unwrap();
            let mut heard = Vec::new();
            for label in ["main", "w-1"] {
                WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
                    .build()
                    .unwrap();
                let window = app.get_webview_window(label).unwrap();
                let log = Arc::new(Mutex::new(Vec::<String>::new()));
                let sink = Arc::clone(&log);
                window.listen(OPEN_FILES, move |e| {
                    sink.lock().unwrap().push(e.payload().to_owned())
                });
                heard.push(log);
            }
            let main = app.get_webview_window("main").unwrap().as_ref().window();

            open_from_outside(app.handle(), paths(&["/a.md"]));
            assert_eq!(frontend_ready(main, app.state()), ["/a.md"]);
            open_from_outside(app.handle(), paths(&["/b.md"]));

            assert_eq!(*heard[0].lock().unwrap(), [r#"{"paths":["/b.md"]}"#]);
            assert!(heard[1].lock().unwrap().is_empty());
        }
    }
}
