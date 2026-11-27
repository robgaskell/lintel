//! Live reload: Rust watches the folder of each open file or lint config and tells every
//! window watching it when its bytes change or it goes away (spec: Live reload).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State, Window};

use crate::files;

pub const FILE_CHANGED: &str = "lintel://file-changed";
pub const FILE_REMOVED: &str = "lintel://file-removed";

const DEBOUNCE: Duration = Duration::from_millis(200);
// Another program may still have the file open; Windows then refuses the read.
const READ_RETRY: Duration = Duration::from_millis(100);
// FSEvents keeps watching a folder that goes away and reports it when it is put back;
// inotify and ReadDirectoryChangesW end that watch (Ruling 278).
const OS_WATCH_SURVIVES: bool = cfg!(target_os = "macos");

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileChangedEvent {
    pub path: String,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileRemovedEvent {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    Changed(FileChangedEvent),
    Removed(FileRemovedEvent),
}

type Sink = Arc<dyn Fn(&str, Notice) + Send + Sync>;
type FolderWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;
/// The OS watcher, or why it could not start.
type Folders = Mutex<Result<FolderWatcher, String>>;

/// One debounced watcher for the whole app. It watches folders, not files, because editors
/// that save by renaming break a watch on the file itself. Each folder is watched once,
/// however many open files it holds.
pub struct Watcher {
    files: Arc<Mutex<Files>>,
    sink: Sink,
    folders: Arc<Folders>,
}

#[derive(Default)]
struct Files {
    by_key: HashMap<PathBuf, Watched>,
    folder_counts: HashMap<PathBuf, usize>,
    /// Watched folders that disappeared. Where the OS ends their watch, it is renewed when a
    /// file in them is watched or saved again.
    lost: HashSet<PathBuf>,
}

struct Watched {
    /// How many watches each window holds, by the spelling it gave, which its events carry
    /// back. One window can watch a file as a doc and as a lint config (Ruling 283).
    subs: BTreeMap<(String, String), usize>,
    /// The last hash Lintel read, wrote or reported; None while the file is gone.
    hash: Option<String>,
}

impl Watched {
    /// A notice of `hash` for each watch that `send_to` accepts, by label and spelling.
    fn notices(&self, send_to: impl Fn(&str, &str) -> bool) -> Vec<(String, Notice)> {
        self.subs
            .keys()
            .filter(|(label, path)| send_to(label, path))
            .map(|(label, path)| (label.clone(), notice_for(path, &self.hash)))
            .collect()
    }
}

impl Watcher {
    /// Sends each change to the windows that watch the file.
    pub fn for_app<R: Runtime>(app: AppHandle<R>) -> Self {
        Self::new(move |label, notice| {
            let sent = match &notice {
                Notice::Changed(event) => app.emit_to(label, FILE_CHANGED, event),
                Notice::Removed(event) => app.emit_to(label, FILE_REMOVED, event),
            };
            if let Err(err) = sent {
                eprintln!("Could not tell {label} about a file change: {err}");
            }
        })
    }

    /// `sink` gets a watching window's label and the notice. Without a working OS watcher, Lintel
    /// still runs; `watch` then fails with the reason.
    pub fn new(sink: impl Fn(&str, Notice) + Send + Sync + 'static) -> Self {
        let sink: Sink = Arc::new(sink);
        let files = Arc::new(Mutex::new(Files::default()));
        let folders: Arc<Folders> = Arc::new(Mutex::new(Err(String::new())));
        let (on_files, on_sink) = (Arc::clone(&files), Arc::clone(&sink));
        // Weak: the OS watcher owns this handler, so a strong reference would keep it alive.
        let on_folders = Arc::downgrade(&folders);
        let started = new_debouncer(
            DEBOUNCE,
            None,
            move |result: DebounceEventResult| match result {
                Ok(events) => {
                    let rescan = events.iter().any(|e| e.event.need_rescan());
                    let paths = events.iter().flat_map(|e| e.event.paths.iter().cloned());
                    let (notices, lost) = check(&on_files, paths.collect(), rescan);
                    drop_lost(&on_folders, &lost);
                    for (label, notice) in notices {
                        on_sink(&label, notice);
                    }
                }
                Err(errors) => {
                    for err in errors {
                        eprintln!("File watcher error: {err}");
                    }
                }
            },
        )
        .map_err(|e| format!("the file watcher could not start: {e}"));
        if let Err(err) = &started {
            eprintln!("{err}");
        }
        *lock(&folders) = started;
        Self {
            files,
            sink,
            folders,
        }
    }

    /// Adds one watch of `path` for the window `label`. `known_hash` is the hash of the text
    /// the window has; a file that differs is reported to that window at once.
    pub fn watch(&self, label: &str, path: String, known_hash: &str) -> Result<(), String> {
        let key = watch_key(&path);
        let mut files = self.lock();
        if files.by_key.contains_key(&key) {
            self.rearm_if_lost(&mut files, folder_of(&key))?;
        } else {
            self.add_folder(&mut files, folder_of(&key))?;
        }
        // An unreadable file counts as unchanged until an event shows otherwise.
        let disk = disk_hash(&key);
        let mut notices = Vec::new();
        let watched = files.by_key.entry(key).or_insert_with(|| Watched {
            subs: BTreeMap::new(),
            hash: disk.clone().unwrap_or_else(|| Some(known_hash.to_owned())),
        });
        // A change no event has reported yet goes to the other watches now, as an event would.
        if let Some(now) = disk.filter(|now| *now != watched.hash) {
            watched.hash = now;
            notices = watched.notices(|l, p| (l, p) != (label, path.as_str()));
        }
        if watched.hash.as_deref() != Some(known_hash) {
            notices.push((label.to_owned(), notice_for(&path, &watched.hash)));
        }
        *watched.subs.entry((label.to_owned(), path)).or_insert(0) += 1;
        drop(files);
        self.send(notices);
        Ok(())
    }

    /// Removes one of the window's watches of `path`; other windows' watches stay.
    pub fn unwatch(&self, label: &str, path: &str) {
        let mut files = self.lock();
        let sub = (label.to_owned(), path.to_owned());
        // A file gone since it was watched may no longer resolve to its key.
        let key = Some(watch_key(path))
            .filter(|key| {
                files
                    .by_key
                    .get(key)
                    .is_some_and(|w| w.subs.contains_key(&sub))
            })
            .or_else(|| {
                let found = files.by_key.iter().find(|(_, w)| w.subs.contains_key(&sub));
                found.map(|(key, _)| key.clone())
            });
        let Some(key) = key else { return };
        let Some(watched) = files.by_key.get_mut(&key) else {
            return;
        };
        if let Some(count) = watched.subs.get_mut(&sub) {
            *count -= 1;
            if *count == 0 {
                watched.subs.remove(&sub);
            }
        }
        if watched.subs.is_empty() {
            files.by_key.remove(&key);
            self.remove_folder(&mut files, folder_of(&key));
        }
    }

    /// Drops every watch of a closed window.
    pub fn drop_window(&self, label: &str) {
        let mut files = self.lock();
        let mut emptied = Vec::new();
        for (key, watched) in files.by_key.iter_mut() {
            watched.subs.retain(|(l, _), _| l != label);
            if watched.subs.is_empty() {
                emptied.push(key.clone());
            }
        }
        for key in emptied {
            files.by_key.remove(&key);
            self.remove_folder(&mut files, folder_of(&key));
        }
    }

    /// Runs Lintel's own write of `path` and records the hash it returns. The saving window
    /// hears nothing; other windows watching the file hear the change. Events are checked
    /// under the same lock, so none can see the new bytes before the new hash.
    pub fn saving(
        &self,
        label: &str,
        path: &str,
        write: impl FnOnce() -> Result<String, String>,
    ) -> Result<String, String> {
        let mut files = self.lock();
        let hash = write()?;
        let key = watch_key(path);
        if let Err(err) = self.rearm_if_lost(&mut files, folder_of(&key)) {
            eprintln!("{err}");
        }
        let mut notices = Vec::new();
        if let Some(watched) = files.by_key.get_mut(&key) {
            if watched.hash.as_deref() != Some(hash.as_str()) {
                watched.hash = Some(hash.clone());
                notices = watched.notices(|l, _| l != label);
            }
        }
        drop(files);
        self.send(notices);
        Ok(hash)
    }

    fn send(&self, notices: Vec<(String, Notice)>) {
        for (label, notice) in notices {
            (self.sink)(&label, notice);
        }
    }

    fn add_folder(&self, files: &mut Files, folder: &Path) -> Result<(), String> {
        if !files.folder_counts.contains_key(folder) {
            self.watch_folder(folder)?;
        }
        self.rearm_if_lost(files, folder)?;
        *files.folder_counts.entry(folder.to_path_buf()).or_insert(0) += 1;
        Ok(())
    }

    /// A folder put back after it disappeared is watched afresh, its old watch being dead.
    fn rearm_if_lost(&self, files: &mut Files, folder: &Path) -> Result<(), String> {
        if !files.lost.contains(folder) || !folder.is_dir() {
            return Ok(());
        }
        if !OS_WATCH_SURVIVES {
            self.watch_folder(folder)?;
        }
        files.lost.remove(folder);
        Ok(())
    }

    fn watch_folder(&self, folder: &Path) -> Result<(), String> {
        let mut folders = lock(&self.folders);
        let watcher = folders.as_mut().map_err(|err| err.clone())?;
        watcher
            .watch(folder, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Could not watch {}: {e}", folder.display()))
    }

    fn remove_folder(&self, files: &mut Files, folder: &Path) {
        let Some(count) = files.folder_counts.get_mut(folder) else {
            return;
        };
        *count -= 1;
        if *count > 0 {
            return;
        }
        files.folder_counts.remove(folder);
        if files.lost.remove(folder) && !OS_WATCH_SURVIVES {
            return;
        }
        if let Ok(watcher) = lock(&self.folders).as_mut() {
            // The folder may be gone already, which ends its watch anyway.
            let _ = watcher.unwatch(folder);
        }
    }

    fn lock(&self) -> MutexGuard<'_, Files> {
        lock(&self.files)
    }
}

/// Watches are counted per window, so each `watch_path` needs its own `unwatch_path`.
#[tauri::command]
pub async fn watch_path<R: Runtime>(
    window: Window<R>,
    watcher: State<'_, Watcher>,
    path: String,
    known_hash: String,
) -> Result<(), String> {
    watcher.watch(window.label(), path, &known_hash)
}

#[tauri::command]
pub async fn unwatch_path<R: Runtime>(
    window: Window<R>,
    watcher: State<'_, Watcher>,
    path: String,
) -> Result<(), String> {
    watcher.unwatch(window.label(), &path);
    Ok(())
}

/// Decides each watched file the batch touched by what is on disk now, never by the event
/// kind: one batch can hold a remove for a file that a rename has already put back. An
/// event on a watched folder, or a folder above it, touches every file in it. Also returns
/// the watched folders found gone, now marked lost.
fn check(
    files: &Mutex<Files>,
    paths: HashSet<PathBuf>,
    rescan: bool,
) -> (Vec<(String, Notice)>, Vec<PathBuf>) {
    let mut files = lock(files);
    // Windows sends no event for its watched folder's own rename, so any batch checks
    // whether a watched folder is gone; a rename alone is noticed at the next event.
    let vanished: HashSet<PathBuf> = files
        .folder_counts
        .keys()
        .filter(|folder| !folder.is_dir())
        .cloned()
        .collect();
    let mut notices = Vec::new();
    for (key, watched) in files.by_key.iter_mut() {
        let folder = folder_of(key);
        let touched = rescan
            || paths.contains(key)
            || paths.iter().any(|path| folder.starts_with(path))
            || vanished.contains(folder);
        if !touched {
            continue;
        }
        // Windows may refuse to stat a file in a folder that is pending deletion.
        let now = if vanished.contains(folder) {
            Some(None)
        } else {
            disk_hash(key)
        };
        let Some(now) = now else { continue };
        if now == watched.hash {
            continue;
        }
        watched.hash = now;
        notices.extend(watched.notices(|_, _| true));
    }
    if OS_WATCH_SURVIVES {
        files.lost.retain(|folder| vanished.contains(folder));
    }
    let gone: Vec<PathBuf> = vanished
        .into_iter()
        .filter(|folder| !files.lost.contains(folder))
        .collect();
    files.lost.extend(gone.iter().cloned());
    (notices, gone)
}

/// Inotify and ReadDirectoryChangesW end a watch whose folder is deleted; dropping it here
/// keeps the OS watcher's own list in step. FSEvents keeps its watch.
fn drop_lost(folders: &Weak<Folders>, lost: &[PathBuf]) {
    if OS_WATCH_SURVIVES || lost.is_empty() {
        return;
    }
    let Some(folders) = folders.upgrade() else {
        return;
    };
    let mut guard = lock(&folders);
    if let Ok(watcher) = guard.as_mut() {
        for folder in lost {
            let _ = watcher.unwatch(folder);
        }
    }
}

fn notice_for(path: &str, hash: &Option<String>) -> Notice {
    let path = path.to_owned();
    match hash {
        Some(hash) => Notice::Changed(FileChangedEvent {
            path,
            hash: hash.clone(),
        }),
        None => Notice::Removed(FileRemovedEvent { path }),
    }
}

/// `Some(None)` when the file is gone, `None` when it cannot be read even after a retry.
fn disk_hash(path: &Path) -> Option<Option<String>> {
    for attempt in 0..2 {
        if attempt > 0 {
            thread::sleep(READ_RETRY);
        }
        match fs::metadata(path) {
            Ok(meta) if !meta.is_file() => return Some(None),
            Err(e) if is_gone(&e) => return Some(None),
            _ => {}
        }
        if let Ok(bytes) = fs::read(path) {
            return Some(Some(files::sha256_hex(&bytes)));
        }
    }
    None
}

fn is_gone(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

/// The canonical path, as `normalize_path` gives it, so a save and a watch agree. A missing
/// file keeps its name in its folder's canonical path.
fn watch_key(path: &str) -> PathBuf {
    let given = Path::new(path);
    files::canonical(given)
        .ok()
        .or_else(|| {
            Some(
                files::canonical(given.parent()?)
                    .ok()?
                    .join(given.file_name()?),
            )
        })
        .unwrap_or_else(|| given.to_path_buf())
}

fn folder_of(key: &Path) -> &Path {
    key.parent().unwrap_or(key)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::time::Instant;

    // Hosted CI runners are slower than this machine; the manual check holds the 1 s figure.
    const WAIT: Duration = Duration::from_secs(3);
    const QUIET: Duration = Duration::from_millis(1500);

    /// A fresh folder per test, removed when the test ends.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "lintel-watch-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, name: &str, text: &str) -> String {
            let path = self.0.join(name);
            fs::write(&path, text).unwrap();
            path.to_str().unwrap().to_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn watcher() -> (Watcher, Receiver<(String, Notice)>) {
        let (send, notices) = mpsc::channel();
        let watcher = Watcher::new(move |owner, notice| {
            let _ = send.send((owner.to_owned(), notice));
        });
        (watcher, notices)
    }

    fn hash(text: &str) -> String {
        files::sha256_hex(text.as_bytes())
    }

    fn changed(path: &str, text: &str) -> Notice {
        Notice::Changed(FileChangedEvent {
            path: path.to_owned(),
            hash: hash(text),
        })
    }

    fn next(notices: &Receiver<(String, Notice)>, what: &str) -> (String, Notice) {
        let started = Instant::now();
        let notice = notices
            .recv_timeout(WAIT)
            .unwrap_or_else(|_| panic!("no notice for {what} within {WAIT:?}"));
        println!("{what}: reported after {:?}", started.elapsed());
        notice
    }

    fn assert_quiet(notices: &Receiver<(String, Notice)>) {
        match notices.recv_timeout(QUIET) {
            Err(RecvTimeoutError::Timeout) => {}
            other => panic!("expected no notice, got {other:?}"),
        }
    }

    fn folder_count(watcher: &Watcher) -> usize {
        watcher.lock().folder_counts.len()
    }

    fn os_watched_folders(watcher: &Watcher) -> usize {
        let folders = lock(&watcher.folders);
        folders.as_ref().unwrap().watched_paths().unwrap().len()
    }

    fn lost_folders(watcher: &Watcher) -> usize {
        watcher.lock().lost.len()
    }

    fn removed(path: &str) -> Notice {
        Notice::Removed(FileRemovedEvent {
            path: path.to_owned(),
        })
    }

    /// A folder in the test folder holding a.md and b.md, both watched by "main".
    fn watched_folder(dir: &TempDir, watcher: &Watcher) -> (PathBuf, String, String) {
        let folder = dir.0.join("notes");
        fs::create_dir(&folder).unwrap();
        let file = |name: &str| {
            let path = folder.join(name);
            fs::write(&path, name).unwrap();
            let path = path.to_str().unwrap().to_owned();
            watcher.watch("main", path.clone(), &hash(name)).unwrap();
            path
        };
        let (a, b) = (file("a.md"), file("b.md"));
        // Lets the events of setting up pass, so the test sees only those it causes.
        thread::sleep(DEBOUNCE * 2);
        (folder, a, b)
    }

    fn two_notices(notices: &Receiver<(String, Notice)>, what: &str) -> Vec<Notice> {
        let mut got = vec![next(notices, what).1, next(notices, what).1];
        got.sort_by_key(|notice| format!("{notice:?}"));
        got
    }

    #[test]
    fn a_write_by_another_program_is_reported_once() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("old")).unwrap();

        fs::write(&path, "new").unwrap();

        let notice = next(&notices, "a write by another program");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "new")));
        assert_quiet(&notices);
    }

    #[test]
    fn writing_the_same_bytes_is_not_reported() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "same");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("same")).unwrap();

        fs::write(&path, "same").unwrap();

        assert_quiet(&notices);
    }

    #[test]
    fn lintel_s_own_save_is_not_reported() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("old")).unwrap();

        let saved = watcher.saving("main", &path, || files::write_text(&path, "mine"));

        assert_eq!(saved, Ok(hash("mine")));
        assert_quiet(&notices);
    }

    #[test]
    fn an_atomic_rename_save_is_one_change_not_a_removal() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("old")).unwrap();

        let temp = dir.file(".a.md.tmp", "renamed");
        fs::rename(&temp, &path).unwrap();

        let notice = next(&notices, "an atomic rename save");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "renamed")));
        assert_quiet(&notices);
    }

    #[test]
    fn a_deleted_file_is_reported_removed_and_its_return_as_a_change() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("old")).unwrap();

        fs::remove_file(&path).unwrap();
        let removed = Notice::Removed(FileRemovedEvent { path: path.clone() });
        assert_eq!(next(&notices, "a delete"), ("main".to_owned(), removed));

        fs::write(&path, "back").unwrap();
        let notice = next(&notices, "a file put back");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "back")));
    }

    #[test]
    fn two_watched_files_in_one_folder_share_one_folder_watch() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let b = dir.file("b.md", "b");
        let (watcher, _notices) = watcher();

        watcher.watch("main", a.clone(), &hash("a")).unwrap();
        watcher.watch("main", b.clone(), &hash("b")).unwrap();
        assert_eq!(folder_count(&watcher), 1);
        assert_eq!(os_watched_folders(&watcher), 1);

        watcher.unwatch("main", &a);
        assert_eq!(os_watched_folders(&watcher), 1);
        watcher.unwatch("main", &b);
        assert_eq!(folder_count(&watcher), 0);
        assert_eq!(os_watched_folders(&watcher), 0);
    }

    #[test]
    fn a_file_that_changed_since_the_window_read_it_is_reported_at_once() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "newer");
        let gone = dir.0.join("gone.md").to_str().unwrap().to_owned();
        let (watcher, notices) = watcher();

        watcher.watch("main", path.clone(), &hash("older")).unwrap();
        watcher.watch("main", gone.clone(), &hash("older")).unwrap();

        let removed = Notice::Removed(FileRemovedEvent { path: gone });
        assert_eq!(
            notices.try_recv(),
            Ok(("main".to_owned(), changed(&path, "newer")))
        );
        assert_eq!(notices.try_recv(), Ok(("main".to_owned(), removed)));
    }

    #[test]
    fn every_window_watching_a_file_hears_its_change() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watcher.watch("w-1", path.clone(), &hash("old")).unwrap();
        watcher.watch("w-2", path.clone(), &hash("old")).unwrap();

        fs::write(&path, "new").unwrap();

        let mut got = vec![
            next(&notices, "a write, first window"),
            next(&notices, "a write, second window"),
        ];
        got.sort_by(|a, b| a.0.cmp(&b.0));
        let new = changed(&path, "new");
        assert_eq!(
            got,
            [("w-1".to_owned(), new.clone()), ("w-2".to_owned(), new)]
        );
        assert_quiet(&notices);
    }

    #[test]
    fn a_hand_over_keeps_the_watch_with_the_window_that_took_the_file() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watcher.watch("w-1", path.clone(), &hash("old")).unwrap();
        watcher.watch("w-2", path.clone(), &hash("old")).unwrap();

        watcher.unwatch("w-1", &path);
        watcher.unwatch("w-1", &path);
        fs::write(&path, "new").unwrap();

        let notice = next(&notices, "a write after a hand-over");
        assert_eq!(notice, ("w-2".to_owned(), changed(&path, "new")));
        assert_quiet(&notices);
        assert_eq!(folder_count(&watcher), 1);
    }

    #[test]
    fn a_window_s_watches_are_counted_so_one_unwatch_keeps_the_other() {
        let dir = TempDir::new();
        let path = dir.file(".markdownlint.json", "{}");
        let (watcher, notices) = watcher();
        // Once as an open doc, once as the lint config of another doc.
        watcher.watch("main", path.clone(), &hash("{}")).unwrap();
        watcher.watch("main", path.clone(), &hash("{}")).unwrap();

        watcher.unwatch("main", &path);
        fs::write(&path, "{ }").unwrap();

        let notice = next(&notices, "a write after one of two unwatches");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "{ }")));
        watcher.unwatch("main", &path);
        assert_eq!(folder_count(&watcher), 0);
        assert_eq!(os_watched_folders(&watcher), 0);
    }

    #[test]
    fn a_watch_with_an_old_hash_is_answered_to_that_window_only() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "now");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("now")).unwrap();

        watcher.watch("w-1", path.clone(), &hash("before")).unwrap();

        assert_eq!(
            notices.try_recv(),
            Ok(("w-1".to_owned(), changed(&path, "now")))
        );
        assert!(notices.try_recv().is_err());
    }

    #[test]
    fn a_change_found_by_a_later_watch_reaches_the_earlier_window_too() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "new");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("new")).unwrap();
        // As if the file changed and its folder's event has not arrived yet.
        watcher.lock().by_key.values_mut().next().unwrap().hash = Some(hash("old"));

        watcher.watch("w-1", path.clone(), &hash("new")).unwrap();

        assert_eq!(
            notices.try_recv(),
            Ok(("main".to_owned(), changed(&path, "new")))
        );
        assert!(notices.try_recv().is_err());
    }

    // As a doc and its lint config can be in one window, under two spellings (Ruling 298).
    #[test]
    fn a_change_found_by_a_watch_reaches_the_same_window_s_other_spelling() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "new");
        let other = dir.0.join(".").join("a.md").to_str().unwrap().to_owned();
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("new")).unwrap();
        watcher.lock().by_key.values_mut().next().unwrap().hash = Some(hash("old"));

        watcher.watch("main", other, &hash("new")).unwrap();

        assert_eq!(
            notices.try_recv(),
            Ok(("main".to_owned(), changed(&path, "new")))
        );
        assert!(notices.try_recv().is_err());
    }

    #[test]
    fn lintel_s_own_save_is_sent_to_the_other_windows_only() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("old")).unwrap();
        watcher.watch("w-1", path.clone(), &hash("old")).unwrap();

        let saved = watcher.saving("main", &path, || files::write_text(&path, "mine"));

        assert_eq!(saved, Ok(hash("mine")));
        assert_eq!(
            notices.try_recv(),
            Ok(("w-1".to_owned(), changed(&path, "mine")))
        );
        assert_quiet(&notices);
    }

    #[test]
    fn a_closed_window_drops_its_watches_only() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let b = dir.file("b.md", "b");
        let (watcher, _notices) = watcher();
        watcher.watch("w-1", a.clone(), &hash("a")).unwrap();
        watcher.watch("w-1", b.clone(), &hash("b")).unwrap();
        watcher.watch("w-1", b.clone(), &hash("b")).unwrap();
        watcher.watch("main", b.clone(), &hash("b")).unwrap();

        watcher.drop_window("w-1");

        let files = watcher.lock();
        let left: Vec<_> = files.by_key.values().flat_map(|w| w.subs.clone()).collect();
        assert_eq!(left, [(("main".to_owned(), b.clone()), 1)]);
        assert_eq!(
            files.folder_counts.values().copied().collect::<Vec<_>>(),
            [1]
        );
    }

    #[test]
    fn deleting_the_folder_reports_each_file_in_it_removed() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let (folder, a, b) = watched_folder(&dir, &watcher);

        fs::remove_dir_all(&folder).unwrap();

        let got = two_notices(&notices, "a deleted folder");
        assert_eq!(got, [removed(&a), removed(&b)]);
        assert_eq!(lost_folders(&watcher), 1);
        let kept = if OS_WATCH_SURVIVES { 1 } else { 0 };
        assert_eq!(os_watched_folders(&watcher), kept);
    }

    #[test]
    #[cfg_attr(
        windows,
        ignore = "ReadDirectoryChangesW sends no event when its own folder is renamed"
    )]
    fn renaming_the_folder_reports_each_file_in_it_removed() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let (folder, a, b) = watched_folder(&dir, &watcher);

        fs::rename(&folder, dir.0.join("moved")).unwrap();

        let got = two_notices(&notices, "a renamed folder");
        assert_eq!(got, [removed(&a), removed(&b)]);
    }

    #[test]
    fn removing_the_files_then_their_folder_reports_each_removed() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let (folder, a, b) = watched_folder(&dir, &watcher);

        fs::remove_file(&a).unwrap();
        fs::remove_file(&b).unwrap();
        fs::remove_dir(&folder).unwrap();

        let got = two_notices(&notices, "files then their folder removed");
        assert_eq!(got, [removed(&a), removed(&b)]);
    }

    #[test]
    fn a_folder_put_back_is_watched_again_by_a_later_watch() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let (folder, a, _) = watched_folder(&dir, &watcher);
        fs::remove_dir_all(&folder).unwrap();
        two_notices(&notices, "a deleted folder");

        fs::create_dir(&folder).unwrap();
        fs::write(&a, "back").unwrap();
        watcher.watch("main", a.clone(), &hash("back")).unwrap();
        assert_eq!(lost_folders(&watcher), 0);
        assert_eq!(os_watched_folders(&watcher), 1);
        fs::write(&a, "changed").unwrap();

        let notice = next(&notices, "a change in a folder put back");
        assert_eq!(notice, ("main".to_owned(), changed(&a, "changed")));
    }

    #[test]
    fn a_folder_put_back_is_watched_again_by_a_save_into_it() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let (folder, a, _) = watched_folder(&dir, &watcher);
        fs::remove_dir_all(&folder).unwrap();
        two_notices(&notices, "a deleted folder");

        fs::create_dir(&folder).unwrap();
        watcher
            .saving("main", &a, || files::write_text(&a, "mine"))
            .unwrap();
        assert_eq!(lost_folders(&watcher), 0);
        assert_eq!(os_watched_folders(&watcher), 1);
        fs::write(&a, "theirs").unwrap();

        let notice = next(&notices, "a change after a save into a folder put back");
        assert_eq!(notice, ("main".to_owned(), changed(&a, "theirs")));
    }

    // FSEvents keeps watching a folder that goes away; inotify and ReadDirectoryChangesW
    // end the watch, so there a folder put back waits for a save or a watch (Ruling 278).
    #[cfg(target_os = "macos")]
    #[test]
    fn a_folder_put_back_is_reported_without_a_save() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let (folder, a, b) = watched_folder(&dir, &watcher);
        let trash = dir.0.join("trash");
        fs::rename(&folder, &trash).unwrap();
        two_notices(&notices, "a folder moved away");

        fs::rename(&trash, &folder).unwrap();

        let got = two_notices(&notices, "a folder put back");
        assert_eq!(got, [changed(&a, "a.md"), changed(&b, "b.md")]);
        assert_eq!(lost_folders(&watcher), 0);
    }

    // Ruling 289: where the OS keeps a lost folder's watch, the last unwatch must end it.
    #[test]
    fn unwatching_the_files_of_a_deleted_folder_leaves_no_os_watch() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let (folder, a, b) = watched_folder(&dir, &watcher);
        fs::remove_dir_all(&folder).unwrap();
        two_notices(&notices, "a deleted folder");

        watcher.unwatch("main", &a);
        watcher.unwatch("main", &b);

        assert_eq!(folder_count(&watcher), 0);
        assert_eq!(lost_folders(&watcher), 0);
        assert_eq!(os_watched_folders(&watcher), 0);
    }

    // Ruling 289: a watch can come before the event that says the folder is back. A second
    // OS watch of the folder shows as a late event that reads a half-written file.
    #[test]
    fn a_folder_put_back_and_watched_at_once_has_one_os_watch_and_reports_once() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let (folder, a, b) = watched_folder(&dir, &watcher);
        watcher.unwatch("main", &b);
        for round in 0..3 {
            fs::remove_dir_all(&folder).unwrap();
            assert_eq!(
                next(&notices, "a deleted folder"),
                ("main".to_owned(), removed(&a))
            );
            assert_quiet(&notices);

            fs::create_dir(&folder).unwrap();
            fs::write(&a, "back").unwrap();
            watcher.watch("main", a.clone(), &hash("back")).unwrap();
            watcher.unwatch("main", &a);
            assert_eq!(lost_folders(&watcher), 0);
            assert_eq!(os_watched_folders(&watcher), 1);
            let text = format!("changed {round}");
            fs::write(&a, &text).unwrap();

            let notice = next(&notices, "a change in a folder put back");
            assert_eq!(notice, ("main".to_owned(), changed(&a, &text)));
            assert_quiet(&notices);
        }
    }

    #[test]
    fn a_reported_change_is_not_reported_again() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watcher.watch("main", path.clone(), &hash("old")).unwrap();
        fs::write(&path, "new").unwrap();
        next(&notices, "a write by another program");

        fs::write(&path, "new").unwrap();

        assert_quiet(&notices);
    }

    #[test]
    fn a_rescan_checks_every_watched_file() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "new");
        let files = Mutex::new(Files::default());
        let watched = Watched {
            subs: BTreeMap::from([(("main".to_owned(), path.clone()), 1)]),
            hash: Some(hash("old")),
        };
        lock(&files).by_key.insert(watch_key(&path), watched);

        assert!(check(&files, HashSet::new(), false).0.is_empty());
        let (notices, _) = check(&files, HashSet::new(), true);

        assert_eq!(notices, [("main".to_owned(), changed(&path, "new"))]);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_unreadable_when_watched_counts_as_unchanged() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let path = dir.file("a.md", "secret");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let (watcher, notices) = watcher();

        watcher.watch("main", path.clone(), &hash("known")).unwrap();

        assert!(notices.try_recv().is_err());
        let files = watcher.lock();
        assert_eq!(
            files.by_key.values().next().unwrap().hash,
            Some(hash("known"))
        );
    }

    mod in_the_app {
        use super::*;
        use crate::open_queue::OpenQueue;
        use crate::windows::{self, FocusOrder, PathRegistry};
        use tauri::async_runtime::block_on;
        use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
        use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

        fn app() -> tauri::App<MockRuntime> {
            let app = mock_builder()
                .manage(PathRegistry::default())
                .manage(FocusOrder::default())
                .manage(Mutex::new(OpenQueue::default()))
                .build(mock_context(noop_assets()))
                .unwrap();
            app.manage(Watcher::for_app(app.handle().clone()));
            app
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
        fn a_change_goes_to_the_window_that_watches_the_file_only() {
            let dir = TempDir::new();
            let path = dir.file("a.md", "new");
            let app = app();
            let main = window(&app, "main");
            let w1 = window(&app, "w-1");
            let in_main = heard(&main, FILE_CHANGED);
            let in_w1 = heard(&w1, FILE_CHANGED);

            block_on(watch_path(w1, app.state(), path.clone(), hash("old"))).unwrap();

            let event = FileChangedEvent {
                path,
                hash: hash("new"),
            };
            let payload = serde_json::to_string(&event).unwrap();
            assert_eq!(*in_w1.lock().unwrap(), [payload]);
            assert!(in_main.lock().unwrap().is_empty());
        }

        #[test]
        fn write_text_file_records_the_hash_it_wrote() {
            let dir = TempDir::new();
            let path = dir.file("a.md", "old");
            let app = app();
            let main = window(&app, "main");
            block_on(watch_path(
                main.clone(),
                app.state(),
                path.clone(),
                hash("old"),
            ))
            .unwrap();

            block_on(files::write_text_file(
                main,
                app.state(),
                path.clone(),
                "mine".to_owned(),
            ))
            .unwrap();

            let watcher = app.state::<Watcher>();
            let files = watcher.lock();
            let watched = files.by_key.values().next().unwrap();
            assert_eq!(watched.hash, Some(hash("mine")));
        }

        #[test]
        fn a_save_is_sent_to_the_other_windows_watching_the_file() {
            let dir = TempDir::new();
            let path = dir.file(".markdownlint.json", "{}");
            let app = app();
            let main = window(&app, "main");
            let w1 = window(&app, "w-1");
            let in_main = heard(&main, FILE_CHANGED);
            let in_w1 = heard(&w1, FILE_CHANGED);
            for window in [&main, &w1] {
                let watching = watch_path(window.clone(), app.state(), path.clone(), hash("{}"));
                block_on(watching).unwrap();
            }

            block_on(files::write_text_file(
                main,
                app.state(),
                path.clone(),
                "{ }".to_owned(),
            ))
            .unwrap();

            let event = FileChangedEvent {
                path,
                hash: hash("{ }"),
            };
            let payload = serde_json::to_string(&event).unwrap();
            assert_eq!(*in_w1.lock().unwrap(), [payload]);
            assert!(in_main.lock().unwrap().is_empty());
        }

        #[test]
        fn a_destroyed_window_loses_its_watches_and_another_window_cannot_unwatch_them() {
            let dir = TempDir::new();
            let path = dir.file("a.md", "old");
            let app = app();
            let main = window(&app, "main");
            let w1 = window(&app, "w-1");
            block_on(watch_path(
                w1.clone(),
                app.state(),
                path.clone(),
                hash("old"),
            ))
            .unwrap();

            block_on(unwatch_path(main, app.state(), path.clone())).unwrap();
            assert_eq!(folder_count(&app.state::<Watcher>()), 1);
            windows::on_doc_window_event(&w1, &WindowEvent::Destroyed);

            assert_eq!(folder_count(&app.state::<Watcher>()), 0);
        }
    }
}
