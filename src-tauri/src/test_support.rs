//! Helpers shared by the tests. No test may touch the user's own folders (Ruling 351).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::test::{noop_assets, MockRuntime};

/// A path in the temp folder, unique to this call and not yet made.
pub fn temp_path(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "lintel-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&path);
    path
}

/// A fresh empty folder, so tests can run in parallel.
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = temp_path(name);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Tauri's mock context with every app folder inside `dir`: each app folder is a user
/// folder joined to the identifier, and joining an absolute path replaces the folder.
pub fn mock_context_in(dir: &Path) -> tauri::Context<MockRuntime> {
    let mut context = tauri::test::mock_context(noop_assets());
    context.config_mut().identifier = dir.to_string_lossy().into_owned();
    context
}

/// As mock_context_in, in a temp folder made only if a test writes there.
pub fn mock_context() -> tauri::Context<MockRuntime> {
    mock_context_in(&temp_path("app"))
}

/// An app running the mock event loop on a thread of its own, which is its main thread.
/// The mock loop takes one message a second.
pub struct Running {
    pub handle: tauri::AppHandle<MockRuntime>,
    pub main_thread: std::thread::ThreadId,
    finished: std::sync::mpsc::Receiver<()>,
}

pub fn run_app(
    build: impl FnOnce() -> tauri::App<MockRuntime> + Send + 'static,
    mut on_event: impl FnMut(&tauri::AppHandle<MockRuntime>, tauri::RunEvent) + Send + 'static,
) -> Running {
    let (ready, started) = std::sync::mpsc::channel();
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let app = build();
        let _ = ready.send((app.handle().clone(), std::thread::current().id()));
        app.run(move |handle, event| on_event(handle, event));
        let _ = done.send(());
    });
    let (handle, main_thread) = started.recv().unwrap();
    Running {
        handle,
        main_thread,
        finished,
    }
}

impl Running {
    /// Runs `work` on the app's main thread, at the loop's next turn.
    pub fn on_main(&self, work: impl FnOnce(&tauri::AppHandle<MockRuntime>) + Send + 'static) {
        let handle = self.handle.clone();
        self.handle
            .run_on_main_thread(move || work(&handle))
            .unwrap();
    }

    /// Whether the loop ended within `wait`.
    pub fn ended_within(&self, wait: std::time::Duration) -> bool {
        self.finished.recv_timeout(wait).is_ok()
    }
}

/// Waits up to `wait` for `done`.
pub fn wait_for(wait: std::time::Duration, done: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + wait;
    while !done() {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    #[test]
    fn mock_apps_keep_every_app_folder_in_the_temp_folder() {
        let app = tauri::test::mock_builder().build(mock_context()).unwrap();
        let path = app.path();
        let temp = std::env::temp_dir();
        for dir in [
            path.app_data_dir(),
            path.app_config_dir(),
            path.app_local_data_dir(),
            path.app_cache_dir(),
            path.app_log_dir(),
        ] {
            let dir = dir.unwrap();
            assert!(dir.starts_with(&temp), "{} is outside {}", dir.display(), temp.display());
        }
    }
}
