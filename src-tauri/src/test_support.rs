//! Helpers shared by the tests. No test may touch the user's own folders (Ruling 351).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

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

/// How long a test waits on the mock loop before it fails. A wait ends as soon as the
/// loop gets there, so the limit only matters on a very slow runner.
pub const LOOP_LIMIT: std::time::Duration = std::time::Duration::from_secs(30);

/// An app running the mock event loop on a thread of its own, which is its main thread.
/// The mock loop takes one message a second.
pub struct Running {
    pub handle: tauri::AppHandle<MockRuntime>,
    pub main_thread: std::thread::ThreadId,
    ended: Arc<AtomicBool>,
}

pub fn run_app(
    build: impl FnOnce() -> tauri::App<MockRuntime> + Send + 'static,
    mut on_event: impl FnMut(&tauri::AppHandle<MockRuntime>, tauri::RunEvent) + Send + 'static,
) -> Running {
    let (ready, started) = std::sync::mpsc::channel();
    let ended = Arc::new(AtomicBool::new(false));
    let loop_ended = Arc::clone(&ended);
    std::thread::spawn(move || {
        let app = build();
        let mut ready = Some(ready);
        app.run(move |handle, event| {
            // Until Ready, the mock runs a main-thread task at once on the caller's thread.
            if matches!(event, tauri::RunEvent::Ready) {
                if let Some(ready) = ready.take() {
                    let _ = ready.send((handle.clone(), std::thread::current().id()));
                }
            }
            on_event(handle, event);
        });
        loop_ended.store(true, Ordering::SeqCst);
    });
    let (handle, main_thread) = started.recv().unwrap();
    Running {
        handle,
        main_thread,
        ended,
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

    /// Runs `work` on the main thread and waits until the loop has handled it and every
    /// message it sent. False if the loop ended first; panics naming `step` after LOOP_LIMIT.
    pub fn step(
        &self,
        step: &str,
        work: impl FnOnce(&tauri::AppHandle<MockRuntime>) + Send + 'static,
    ) -> bool {
        self.on_main(work);
        // The loop takes messages in order: the first marker queues behind `work`, the
        // second behind the messages `work` sent.
        self.reach_marker(step) && self.reach_marker(step)
    }

    fn reach_marker(&self, step: &str) -> bool {
        let (reached, heard) = std::sync::mpsc::channel();
        let sent = self.handle.run_on_main_thread(move || {
            let _ = reached.send(());
        });
        if sent.is_err() {
            return false;
        }
        let deadline = std::time::Instant::now() + LOOP_LIMIT;
        loop {
            if heard.try_recv().is_ok() {
                return true;
            }
            if self.ended.load(Ordering::SeqCst) {
                return heard.try_recv().is_ok();
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the mock loop did not finish \"{step}\" within {LOOP_LIMIT:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    /// Whether the loop ended within `wait`.
    pub fn ended_within(&self, wait: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + wait;
        while !self.ended.load(Ordering::SeqCst) {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        true
    }
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
