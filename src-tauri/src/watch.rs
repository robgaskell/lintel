//! Live reload: Rust watches the folder of each open file or lint config and tells every
//! window watching it when its bytes change or it goes away (spec: Live reload).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
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
/// Sent to the windows watching a file whose folder the OS would not watch.
pub const WATCH_FAILED: &str = "lintel://watch-failed";

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

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WatchFailedEvent {
    pub message: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    Changed(FileChangedEvent),
    Removed(FileRemovedEvent),
    Failed(WatchFailedEvent),
}

type Sink = Arc<dyn Fn(&str, Notice) + Send + Sync>;
type FolderWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// The OS watcher, or why it could not start, and the folders it watches. OS calls can
/// block on a stalled mount, so only the OS watcher thread and the event handler take this.
struct Folders {
    watcher: Result<FolderWatcher, String>,
    watching: HashSet<PathBuf>,
}

/// One debounced watcher for the whole app. It watches folders, not files, because editors
/// that save by renaming break a watch on the file itself. Each folder is watched once.
/// watch, unwatch, drop_window and saving touch only their own file and folder on disk:
/// no file I/O runs under the files lock, and OS watch calls run on their own thread
/// (Rulings 357, 358). A stalled share can still delay events, and the start of watching
/// other folders.
pub struct Watcher {
    files: Arc<Mutex<Files>>,
    sink: Sink,
    /// Owned by the OS watcher thread; tests look at it here.
    #[cfg(test)]
    folders: Arc<Mutex<Folders>>,
    os_requests: Sender<OsRequest>,
}

struct WatchRead {
    key: PathBuf,
    /// The version of the file's hash before the disk read; None when it was not watched.
    seen: Option<u64>,
    folder_back: bool,
    disk: Option<Option<String>>,
}

/// Work for the OS watcher thread, which callers hand over without waiting.
enum OsRequest {
    /// Watch or unwatch `folder` as the files need; `renew` first ends a watch the OS dropped.
    Sync { folder: PathBuf, renew: bool },
    /// Check these paths, as an event would.
    Check(HashSet<PathBuf>),
    /// Answers once every earlier request is done.
    #[cfg(test)]
    Flush(Sender<()>),
}

#[derive(Default)]
struct Files {
    by_key: HashMap<PathBuf, Watched>,
    folder_counts: HashMap<PathBuf, usize>,
    /// Watched folders that disappeared. Where the OS ends their watch, it is renewed when a
    /// file in them is watched or saved again.
    lost: HashSet<PathBuf>,
}

impl Files {
    /// Whether the OS should watch `folder` now.
    fn wants(&self, folder: &Path) -> bool {
        self.folder_counts.contains_key(folder)
            && (OS_WATCH_SURVIVES || !self.lost.contains(folder))
    }

    /// Counts one watched file fewer in `folder`. True when that was the last one.
    fn remove_folder(&mut self, folder: &Path) -> bool {
        let Some(count) = self.folder_counts.get_mut(folder) else {
            return false;
        };
        *count -= 1;
        if *count > 0 {
            return false;
        }
        self.folder_counts.remove(folder);
        self.lost.remove(folder);
        true
    }
}

struct Watched {
    /// How many watches each window holds, by the spelling it gave, which its events carry
    /// back. One window can watch a file as a doc and as a lint config (Ruling 283).
    subs: BTreeMap<(String, String), usize>,
    /// The last hash Lintel read, wrote or reported; None while the file is gone.
    hash: Option<String>,
    /// Goes up with each change of `hash`, so a read taken before it is known to be stale.
    version: u64,
    /// Lintel's own saves of the file still running. Checks leave the file alone meanwhile.
    saves: usize,
    /// An event came during a save, so the file is checked once the save ends.
    missed: bool,
}

impl Watched {
    fn new(hash: Option<String>) -> Self {
        Self {
            subs: BTreeMap::new(),
            hash,
            version: 0,
            saves: 0,
            missed: false,
        }
    }

    fn set_hash(&mut self, hash: Option<String>) {
        self.hash = hash;
        self.version += 1;
    }

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
                Notice::Failed(event) => app.emit_to(label, WATCH_FAILED, event),
            };
            if let Err(err) = sent {
                eprintln!("Could not tell {label} about a file change: {err}");
            }
        })
    }

    /// `sink` gets a watching window's label and the notice. Without a working OS watcher, Lintel
    /// still runs; each watch then gets a Failed notice with the reason.
    pub fn new(sink: impl Fn(&str, Notice) + Send + Sync + 'static) -> Self {
        let sink: Sink = Arc::new(sink);
        let files = Arc::new(Mutex::new(Files::default()));
        let folders = Arc::new(Mutex::new(Folders {
            watcher: Err(String::new()),
            watching: HashSet::new(),
        }));
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
                    drop_lost(&on_files, &on_folders, &lost);
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
        lock(&folders).watcher = started;
        let (os_requests, requests) = mpsc::channel();
        let (os_files, os_folders, os_sink) =
            (Arc::clone(&files), Arc::clone(&folders), Arc::clone(&sink));
        thread::spawn(move || serve_os_requests(&requests, &os_files, &os_folders, &os_sink));
        Self {
            files,
            sink,
            #[cfg(test)]
            folders,
            os_requests,
        }
    }

    /// Adds one watch of `path` for the window `label`. `known_hash` is the hash of the text
    /// the window has; a file that differs is reported to that window at once. Its folder is
    /// watched soon after; a failure there comes back as a Failed notice.
    pub fn watch(&self, label: &str, path: String, known_hash: &str) -> Result<(), String> {
        let read = self.read_for_watch(&path);
        self.finish_watch(label, path, known_hash, read);
        Ok(())
    }

    /// The reads watch() makes before it takes the lock, apart so a test can put a save
    /// between the two.
    fn read_for_watch(&self, path: &str) -> WatchRead {
        let key = watch_key(path);
        let seen = self.lock().by_key.get(&key).map(|w| w.version);
        let folder_back = folder_of(&key).is_dir();
        // An unreadable file counts as unchanged until an event shows otherwise.
        let disk = disk_hash(&key);
        WatchRead {
            key,
            seen,
            folder_back,
            disk,
        }
    }

    fn finish_watch(&self, label: &str, path: String, known_hash: &str, read: WatchRead) {
        let WatchRead {
            key,
            seen,
            folder_back,
            disk,
        } = read;
        let folder = folder_of(&key).to_path_buf();
        let mut notices = Vec::new();
        let mut files = self.lock();
        let renew = folder_back && files.lost.remove(&folder);
        let existed = files.by_key.contains_key(&key);
        if !existed {
            *files.folder_counts.entry(folder.clone()).or_insert(0) += 1;
        }
        let watched = files.by_key.entry(key).or_insert_with(|| {
            Watched::new(disk.clone().unwrap_or_else(|| Some(known_hash.to_owned())))
        });
        // A save or a check since the read knows better than the read.
        let fresh = match seen {
            None => !existed,
            Some(version) => existed && version == watched.version && watched.saves == 0,
        };
        // A change no event has reported yet goes to the other watches now, as an event would.
        if let Some(now) = disk.filter(|now| fresh && *now != watched.hash) {
            watched.set_hash(now);
            notices = watched.notices(|l, p| (l, p) != (label, path.as_str()));
        }
        if watched.hash.as_deref() != Some(known_hash) {
            notices.push((label.to_owned(), notice_for(&path, &watched.hash)));
        }
        *watched.subs.entry((label.to_owned(), path)).or_insert(0) += 1;
        drop(files);
        self.os_request(OsRequest::Sync { folder, renew });
        self.send(notices);
    }

    /// Removes one of the window's watches of `path`; other windows' watches stay.
    pub fn unwatch(&self, label: &str, path: &str) {
        let sub = (label.to_owned(), path.to_owned());
        let given = watch_key(path);
        let mut files = self.lock();
        // A file gone since it was watched may no longer resolve to its key.
        let key = Some(given)
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
        if !watched.subs.is_empty() {
            return;
        }
        files.by_key.remove(&key);
        let folder = folder_of(&key);
        if files.remove_folder(folder) {
            drop(files);
            self.os_request(OsRequest::Sync {
                folder: folder.to_path_buf(),
                renew: false,
            });
        }
    }

    /// Drops every watch of a closed window. It runs on the main thread, so it changes the
    /// counts only; the OS watches end on the OS watcher thread.
    pub fn drop_window(&self, label: &str) {
        let mut files = self.lock();
        let mut emptied = Vec::new();
        for (key, watched) in files.by_key.iter_mut() {
            watched.subs.retain(|(l, _), _| l != label);
            if watched.subs.is_empty() {
                emptied.push(key.clone());
            }
        }
        let mut unwatched = Vec::new();
        for key in emptied {
            files.by_key.remove(&key);
            let folder = folder_of(&key).to_path_buf();
            if files.remove_folder(&folder) {
                unwatched.push(folder);
            }
        }
        drop(files);
        for folder in unwatched {
            self.os_request(OsRequest::Sync {
                folder,
                renew: false,
            });
        }
    }

    /// Runs Lintel's own write of `path` and records the hash it returns. The saving window
    /// hears nothing; other windows watching the file hear the change. Checks leave the file
    /// alone while the write runs, so none can see the new bytes before the new hash.
    pub fn saving(
        &self,
        label: &str,
        path: &str,
        write: impl FnOnce() -> Result<String, String>,
    ) -> Result<String, String> {
        let key = watch_key(path);
        if let Some(watched) = self.lock().by_key.get_mut(&key) {
            watched.saves += 1;
        }
        let written = write();
        let folder = folder_of(&key);
        let mut notices = Vec::new();
        let mut recheck = false;
        let mut files = self.lock();
        // The write landed in the folder, so it is back.
        let renew = written.is_ok() && files.lost.remove(folder);
        if let Some(watched) = files.by_key.get_mut(&key) {
            // An unwatch and a new watch during the write start the count afresh.
            watched.saves = watched.saves.saturating_sub(1);
            if let Ok(hash) = &written {
                if watched.hash.as_deref() != Some(hash.as_str()) {
                    watched.set_hash(Some(hash.clone()));
                    notices = watched.notices(|l, _| l != label);
                }
            }
            recheck = watched.saves == 0 && std::mem::take(&mut watched.missed);
        }
        drop(files);
        if renew {
            self.os_request(OsRequest::Sync {
                folder: folder.to_path_buf(),
                renew: true,
            });
        }
        // A check stats every watched folder, so it runs on the OS watcher thread.
        if recheck {
            self.os_request(OsRequest::Check(HashSet::from([key.clone()])));
        }
        self.send(notices);
        written
    }

    fn os_request(&self, request: OsRequest) {
        // Fails only once the thread has ended: when the Watcher drops, or after a panic.
        let _ = self.os_requests.send(request);
    }

    /// Waits until the OS watcher thread has done every request sent so far.
    #[cfg(test)]
    fn flush(&self) {
        let (done, finished) = mpsc::channel();
        self.os_request(OsRequest::Flush(done));
        // A stuck thread fails the test instead of hanging it.
        finished
            .recv_timeout(Duration::from_secs(10))
            .expect("the OS watcher thread did not answer within 10 s");
    }

    fn send(&self, notices: Vec<(String, Notice)>) {
        send(&self.sink, notices);
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

fn send(sink: &Sink, notices: Vec<(String, Notice)>) {
    for (label, notice) in notices {
        sink(&label, notice);
    }
}

/// The OS watcher thread: the one place that may wait for an OS watch call.
fn serve_os_requests(
    requests: &Receiver<OsRequest>,
    files: &Mutex<Files>,
    folders: &Arc<Mutex<Folders>>,
    sink: &Sink,
) {
    for request in requests {
        let checked = match request {
            OsRequest::Sync { folder, renew } => match sync_folder(files, folders, &folder, renew) {
                // Catches a change made before the watch began.
                Ok(true) => HashSet::from([folder]),
                Ok(false) => continue,
                Err(message) => {
                    eprintln!("{message}");
                    send(sink, failed(files, &folder, &message));
                    continue;
                }
            },
            OsRequest::Check(paths) => paths,
            #[cfg(test)]
            OsRequest::Flush(done) => {
                let _ = done.send(());
                continue;
            }
        };
        let (notices, lost) = check(files, checked, false);
        drop_lost(files, &Arc::downgrade(folders), &lost);
        send(sink, notices);
    }
}

/// A Failed notice for each window watching a file in `folder`.
fn failed(files: &Mutex<Files>, folder: &Path, message: &str) -> Vec<(String, Notice)> {
    let files = lock(files);
    let labels: BTreeSet<&str> = files
        .by_key
        .iter()
        .filter(|(key, _)| folder_of(key) == folder)
        .flat_map(|(_, watched)| watched.subs.keys().map(|(label, _)| label.as_str()))
        .collect();
    let event = WatchFailedEvent {
        message: message.to_owned(),
    };
    labels
        .into_iter()
        .map(|label| (label.to_owned(), Notice::Failed(event.clone())))
        .collect()
}

/// Brings the OS watch of `folder` in line with what `files` wants. `renew` ends a watch the
/// OS has already dropped before watching again, as where the folder was lost. True when a
/// new watch began.
fn sync_folder(
    files: &Mutex<Files>,
    folders: &Mutex<Folders>,
    folder: &Path,
    renew: bool,
) -> Result<bool, String> {
    let mut guard = lock(folders);
    let os = &mut *guard;
    let wanted = lock(files).wants(folder);
    let mut watching = os.watching.contains(folder);
    if watching && (!wanted || (renew && !OS_WATCH_SURVIVES)) {
        if let Ok(watcher) = os.watcher.as_mut() {
            // The folder may be gone already, which ends its watch anyway.
            let _ = watcher.unwatch(folder);
        }
        os.watching.remove(folder);
        watching = false;
    }
    if !wanted || watching {
        return Ok(false);
    }
    let watcher = os.watcher.as_mut().map_err(|err| err.clone())?;
    watcher
        .watch(folder, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Could not watch {}: {e}", folder.display()))?;
    os.watching.insert(folder.to_path_buf());
    Ok(true)
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
    let reads = read_disk(files, &paths, rescan);
    apply_reads(files, reads)
}

/// What a check found on disk, read outside the files lock.
struct DiskReads {
    vanished: HashSet<PathBuf>,
    /// Each touched file, the version of its hash before the read, and what the read found.
    files: Vec<(PathBuf, u64, Option<Option<String>>)>,
}

fn read_disk(files: &Mutex<Files>, paths: &HashSet<PathBuf>, rescan: bool) -> DiskReads {
    let (folders, snapshot): (Vec<PathBuf>, Vec<(PathBuf, u64)>) = {
        let files = lock(files);
        let folders = files.folder_counts.keys().cloned().collect();
        let keys = files.by_key.iter().map(|(k, w)| (k.clone(), w.version));
        (folders, keys.collect())
    };
    // Windows sends no event for its watched folder's own rename, so any batch checks
    // whether a watched folder is gone; a rename alone is noticed at the next event.
    let vanished: HashSet<PathBuf> = folders.into_iter().filter(|f| !f.is_dir()).collect();
    let mut reads = Vec::new();
    for (key, version) in snapshot {
        let folder = folder_of(&key);
        let touched = rescan
            || paths.contains(&key)
            || paths.iter().any(|path| folder.starts_with(path))
            || vanished.contains(folder);
        if !touched {
            continue;
        }
        // Windows may refuse to stat a file in a folder that is pending deletion.
        let now = if vanished.contains(folder) {
            Some(None)
        } else {
            disk_hash(&key)
        };
        reads.push((key, version, now));
    }
    DiskReads {
        vanished,
        files: reads,
    }
}

fn apply_reads(files: &Mutex<Files>, reads: DiskReads) -> (Vec<(String, Notice)>, Vec<PathBuf>) {
    let DiskReads { vanished, files: reads } = reads;
    let mut files = lock(files);
    let mut notices = Vec::new();
    for (key, version, now) in reads {
        let Some(watched) = files.by_key.get_mut(&key) else {
            continue;
        };
        if watched.saves > 0 {
            watched.missed = true;
            continue;
        }
        // A save or another check has a newer hash than this read.
        if watched.version != version {
            continue;
        }
        let Some(now) = now else { continue };
        if now == watched.hash {
            continue;
        }
        watched.set_hash(now);
        notices.extend(watched.notices(|_, _| true));
    }
    if OS_WATCH_SURVIVES {
        files.lost.retain(|folder| vanished.contains(folder));
    }
    let gone: Vec<PathBuf> = vanished
        .into_iter()
        .filter(|f| files.folder_counts.contains_key(f) && !files.lost.contains(f))
        .collect();
    files.lost.extend(gone.iter().cloned());
    (notices, gone)
}

/// Inotify and ReadDirectoryChangesW end a watch whose folder is deleted; dropping it here
/// keeps the OS watcher's own list in step. FSEvents keeps its watch.
fn drop_lost(files: &Mutex<Files>, folders: &Weak<Mutex<Folders>>, lost: &[PathBuf]) {
    if OS_WATCH_SURVIVES || lost.is_empty() {
        return;
    }
    let Some(folders) = folders.upgrade() else {
        return;
    };
    for folder in lost {
        let _ = sync_folder(files, &folders, folder, false);
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

    /// Watches `path` and waits until its folder is watched, so a write straight after is seen.
    fn watch_now(watcher: &Watcher, label: &str, path: String, known_hash: &str) {
        watcher.watch(label, path, known_hash).unwrap();
        watcher.flush();
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
        watcher.flush();
        let folders = lock(&watcher.folders);
        let watcher = folders.watcher.as_ref().unwrap();
        watcher.watched_paths().unwrap().len()
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
            watch_now(watcher, "main", path.clone(), &hash(name));
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
        watch_now(&watcher, "main", path.clone(), &hash("old"));

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
        watch_now(&watcher, "main", path.clone(), &hash("same"));

        fs::write(&path, "same").unwrap();

        assert_quiet(&notices);
    }

    #[test]
    fn lintel_s_own_save_is_not_reported() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watch_now(&watcher, "main", path.clone(), &hash("old"));

        let saved = watcher.saving("main", &path, || files::write_text(&path, "mine"));

        assert_eq!(saved, Ok(hash("mine")));
        assert_quiet(&notices);
    }

    #[test]
    fn an_atomic_rename_save_is_one_change_not_a_removal() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watch_now(&watcher, "main", path.clone(), &hash("old"));

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
        watch_now(&watcher, "main", path.clone(), &hash("old"));

        fs::remove_file(&path).unwrap();
        let removed = Notice::Removed(FileRemovedEvent { path: path.clone() });
        assert_eq!(next(&notices, "a delete"), ("main".to_owned(), removed));

        fs::write(&path, "back").unwrap();
        let notice = next(&notices, "a file put back");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "back")));
    }

    /// A lint config made again is heard even with its old text (Ruling 346).
    #[test]
    fn a_deleted_config_made_again_with_the_same_text_is_reported_as_a_change() {
        let dir = TempDir::new();
        let path = dir.file(".markdownlint.json", "{}");
        let (watcher, notices) = watcher();
        watch_now(&watcher, "main", path.clone(), &hash("{}"));

        fs::remove_file(&path).unwrap();
        let notice = next(&notices, "a delete");
        assert_eq!(notice, ("main".to_owned(), removed(&path)));

        fs::write(&path, "{}").unwrap();
        let notice = next(&notices, "the same file made again");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "{}")));
        assert_quiet(&notices);
    }

    #[test]
    fn two_watched_files_in_one_folder_share_one_folder_watch() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let b = dir.file("b.md", "b");
        let (watcher, _notices) = watcher();

        watch_now(&watcher, "main", a.clone(), &hash("a"));
        watch_now(&watcher, "main", b.clone(), &hash("b"));
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

        watch_now(&watcher, "main", path.clone(), &hash("older"));
        watch_now(&watcher, "main", gone.clone(), &hash("older"));

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
        watch_now(&watcher, "w-1", path.clone(), &hash("old"));
        watch_now(&watcher, "w-2", path.clone(), &hash("old"));

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
        watch_now(&watcher, "w-1", path.clone(), &hash("old"));
        watch_now(&watcher, "w-2", path.clone(), &hash("old"));

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
        watch_now(&watcher, "main", path.clone(), &hash("{}"));
        watch_now(&watcher, "main", path.clone(), &hash("{}"));

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
        watch_now(&watcher, "main", path.clone(), &hash("now"));

        watch_now(&watcher, "w-1", path.clone(), &hash("before"));

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
        watch_now(&watcher, "main", path.clone(), &hash("new"));
        // As if the file changed and its folder's event has not arrived yet.
        watcher.lock().by_key.values_mut().next().unwrap().hash = Some(hash("old"));

        watch_now(&watcher, "w-1", path.clone(), &hash("new"));

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
        watch_now(&watcher, "main", path.clone(), &hash("new"));
        watcher.lock().by_key.values_mut().next().unwrap().hash = Some(hash("old"));

        watch_now(&watcher, "main", other, &hash("new"));

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
        watch_now(&watcher, "main", path.clone(), &hash("old"));
        watch_now(&watcher, "w-1", path.clone(), &hash("old"));

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
        watch_now(&watcher, "w-1", a.clone(), &hash("a"));
        watch_now(&watcher, "w-1", b.clone(), &hash("b"));
        watch_now(&watcher, "w-1", b.clone(), &hash("b"));
        watch_now(&watcher, "main", b.clone(), &hash("b"));

        watcher.drop_window("w-1");

        let files = watcher.lock();
        let left: Vec<_> = files.by_key.values().flat_map(|w| w.subs.clone()).collect();
        assert_eq!(left, [(("main".to_owned(), b.clone()), 1)]);
        assert_eq!(
            files.folder_counts.values().copied().collect::<Vec<_>>(),
            [1]
        );
    }

    /// Starts a save of `path` that takes `slow`, as on a stalled network share, and
    /// returns once the write has begun.
    fn slow_save(
        watcher: &Arc<Watcher>,
        path: &str,
        slow: Duration,
    ) -> thread::JoinHandle<Result<String, String>> {
        let (started, begun) = mpsc::channel();
        let (watcher, path) = (Arc::clone(watcher), path.to_owned());
        let handle = thread::spawn(move || {
            watcher.saving("main", &path, || {
                started.send(()).unwrap();
                thread::sleep(slow);
                files::write_text(&path, "slow")
            })
        });
        begun.recv().unwrap();
        handle
    }

    // Ruling 357: one stalled share must not hold up the rest of the app.
    #[test]
    fn a_save_does_not_wait_for_a_slow_write_to_another_file() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let b = dir.file("b.md", "b");
        let watcher = Arc::new(watcher().0);
        watch_now(&watcher, "main", a.clone(), &hash("a"));
        watch_now(&watcher, "w-1", b.clone(), &hash("b"));
        let slow = slow_save(&watcher, &a, Duration::from_secs(3));

        let begun = Instant::now();
        let saved = watcher.saving("w-1", &b, || files::write_text(&b, "quick"));
        let waited = begun.elapsed();

        assert_eq!(saved, Ok(hash("quick")));
        assert!(waited < Duration::from_millis(1500), "waited {waited:?}");
        assert_eq!(slow.join().unwrap(), Ok(hash("slow")));
    }

    #[test]
    fn a_watch_does_not_wait_for_a_slow_write_to_another_file() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let b = dir.file("b.md", "b");
        let watcher = Arc::new(watcher().0);
        watch_now(&watcher, "main", a.clone(), &hash("a"));
        let slow = slow_save(&watcher, &a, Duration::from_secs(3));

        let begun = Instant::now();
        watch_now(&watcher, "w-1", b, &hash("b"));
        let waited = begun.elapsed();

        assert!(waited < Duration::from_millis(1500), "waited {waited:?}");
        slow.join().unwrap().unwrap();
    }

    // drop_window runs on the main thread, so it must not wait for an OS watcher call.
    #[test]
    fn a_closed_window_s_watches_drop_while_the_os_watcher_is_busy() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let watcher = Arc::new(watcher().0);
        watch_now(&watcher, "w-1", a, &hash("a"));
        let busy = lock(&watcher.folders);
        let (done, finished) = mpsc::channel();
        let closing = Arc::clone(&watcher);
        thread::spawn(move || {
            closing.drop_window("w-1");
            done.send(()).unwrap();
        });

        let returned = finished.recv_timeout(Duration::from_secs(1));
        drop(busy);

        assert!(returned.is_ok(), "drop_window waited for the OS watcher");
        assert_eq!(folder_count(&watcher), 0);
        let begun = Instant::now();
        while os_watched_folders(&watcher) > 0 && begun.elapsed() < WAIT {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(os_watched_folders(&watcher), 0);
    }

    /// Runs `call` on another thread while the OS watcher is held busy, as by a watch call
    /// stuck on a stalled share. None when `call` did not return within a second.
    fn while_os_watcher_busy<T: Send + 'static>(
        watcher: &Arc<Watcher>,
        call: impl FnOnce(&Watcher) -> T + Send + 'static,
    ) -> Option<T> {
        let busy = lock(&watcher.folders);
        let (done, finished) = mpsc::channel();
        let caller = Arc::clone(watcher);
        thread::spawn(move || {
            let _ = done.send(call(&caller));
        });
        let returned = finished.recv_timeout(Duration::from_secs(1)).ok();
        drop(busy);
        returned
    }

    // Ruling 358: opening a file must not wait for another folder's OS watch call.
    #[test]
    fn a_watch_does_not_wait_while_the_os_watcher_is_busy() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let watcher = Arc::new(watcher().0);

        let returned = while_os_watcher_busy(&watcher, move |w| w.watch("main", a, &hash("a")));

        assert_eq!(returned, Some(Ok(())), "watch waited for the OS watcher");
        assert_eq!(os_watched_folders(&watcher), 1);
    }

    // watch() no longer waits for the OS, so a folder it cannot watch is reported later.
    #[test]
    fn a_folder_the_os_will_not_watch_is_reported_to_the_watching_window() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let (watcher, notices) = watcher();
        lock(&watcher.folders).watcher = Err("the file watcher could not start".to_owned());

        assert_eq!(watcher.watch("w-1", a, &hash("a")), Ok(()));

        let failed = Notice::Failed(WatchFailedEvent {
            message: "the file watcher could not start".to_owned(),
        });
        assert_eq!(next(&notices, "a watch that failed"), ("w-1".to_owned(), failed));
        assert_quiet(&notices);
    }

    #[test]
    fn a_save_into_a_folder_put_back_does_not_wait_while_the_os_watcher_is_busy() {
        let dir = TempDir::new();
        let (watcher, notices) = watcher();
        let watcher = Arc::new(watcher);
        let (folder, a, _) = watched_folder(&dir, &watcher);
        fs::remove_dir_all(&folder).unwrap();
        two_notices(&notices, "a deleted folder");
        fs::create_dir(&folder).unwrap();

        let path = a.clone();
        let returned = while_os_watcher_busy(&watcher, move |w| {
            w.saving("main", &path, || files::write_text(&path, "mine"))
        });

        assert_eq!(returned, Some(Ok(hash("mine"))), "the save waited for the OS watcher");
        assert_eq!(os_watched_folders(&watcher), 1);
        fs::write(&a, "theirs").unwrap();
        let notice = next(&notices, "a change after a save into a folder put back");
        assert_eq!(notice, ("main".to_owned(), changed(&a, "theirs")));
    }

    // The three guards below keep a stale read from undoing a save (Ruling 358).
    #[test]
    fn a_check_that_read_before_a_save_does_not_put_the_older_hash_back() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, _notices) = watcher();
        watch_now(&watcher, "main", path.clone(), &hash("old"));
        let reads = read_disk(&watcher.files, &HashSet::from([watch_key(&path)]), false);

        watcher
            .saving("main", &path, || files::write_text(&path, "mine"))
            .unwrap();
        let (sent, _) = apply_reads(&watcher.files, reads);

        assert!(sent.is_empty(), "{sent:?}");
        let hash_now = watcher.lock().by_key.values().next().unwrap().hash.clone();
        assert_eq!(hash_now, Some(hash("mine")));
    }

    #[test]
    fn a_check_during_a_save_leaves_the_file_to_the_save() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watch_now(&watcher, "main", path.clone(), &hash("old"));
        let key = watch_key(&path);
        let mut during = Vec::new();

        watcher
            .saving("main", &path, || {
                let written = files::write_text(&path, "mine");
                during = check(&watcher.files, HashSet::from([key]), false).0;
                written
            })
            .unwrap();

        assert!(during.is_empty(), "{during:?}");
        assert_quiet(&notices);
    }

    #[test]
    fn a_watch_during_a_save_leaves_the_change_for_the_save_to_report() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watch_now(&watcher, "main", path.clone(), &hash("old"));

        watcher
            .saving("main", &path, || {
                let written = files::write_text(&path, "mine");
                watcher.watch("w-1", path.clone(), &hash("old")).unwrap();
                written
            })
            .unwrap();

        let got: Vec<_> = notices.try_iter().collect();
        assert_eq!(got, [("w-1".to_owned(), changed(&path, "mine"))]);
        assert_quiet(&notices);
    }

    /// Runs `call` on another thread and gives up after a second, so a regression that
    /// blocks fails the test instead of hanging it.
    fn within_a_second<T: Send + 'static>(call: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            let _ = done.send(call());
        });
        finished.recv_timeout(Duration::from_secs(1)).ok()
    }

    // Ruling 359: a save that ends while watch() reads the disk knows better than the read.
    #[test]
    fn a_save_that_ends_while_a_watch_reads_keeps_its_hash() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watch_now(&watcher, "main", path.clone(), &hash("old"));
        let read = watcher.read_for_watch(&path);

        watcher
            .saving("main", &path, || files::write_text(&path, "mine"))
            .unwrap();
        watcher.finish_watch("w-1", path.clone(), &hash("old"), read);

        let got: Vec<_> = notices.try_iter().collect();
        assert_eq!(got, [("w-1".to_owned(), changed(&path, "mine"))]);
        let hash_now = watcher.lock().by_key.values().next().unwrap().hash.clone();
        assert_eq!(hash_now, Some(hash("mine")));
    }

    // The file was not watched when this watch read it, but another watch and a save came first.
    #[test]
    fn a_watch_that_read_before_the_file_was_watched_does_not_undo_a_save() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        let read = watcher.read_for_watch(&path);

        watch_now(&watcher, "main", path.clone(), &hash("old"));
        watcher
            .saving("main", &path, || files::write_text(&path, "mine"))
            .unwrap();
        watcher.finish_watch("w-1", path.clone(), &hash("old"), read);

        let got: Vec<_> = notices.try_iter().collect();
        assert_eq!(got, [("w-1".to_owned(), changed(&path, "mine"))]);
        let hash_now = watcher.lock().by_key.values().next().unwrap().hash.clone();
        assert_eq!(hash_now, Some(hash("mine")));
    }

    #[test]
    fn an_unwatch_does_not_wait_while_the_os_watcher_is_busy() {
        let dir = TempDir::new();
        let a = dir.file("a.md", "a");
        let watcher = Arc::new(watcher().0);
        watch_now(&watcher, "main", a.clone(), &hash("a"));

        let returned = while_os_watcher_busy(&watcher, move |w| w.unwatch("main", &a));

        assert_eq!(returned, Some(()), "unwatch waited for the OS watcher");
        assert_eq!(os_watched_folders(&watcher), 0);
    }

    // The re-check stats every watched folder, so it must not run on the saving thread.
    #[test]
    fn a_save_s_re_check_runs_on_the_os_watcher_thread() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        let watcher = Arc::new(watcher);
        // Its folder is not watched yet, so no event reports the change below.
        let busy = lock(&watcher.folders);
        let saver = Arc::clone(&watcher);
        let saving = path.clone();
        let saved = within_a_second(move || {
            saver.watch("main", saving.clone(), &hash("old")).unwrap();
            let key = watch_key(&saving);
            saver.saving("main", &saving, || {
                let written = files::write_text(&saving, "mine");
                fs::write(&saving, "theirs").unwrap();
                // As an event during the save would.
                check(&saver.files, HashSet::from([key]), false);
                written
            })
        });
        let heard_while_busy = notices.try_recv().ok();
        drop(busy);

        assert_eq!(saved, Some(Ok(hash("mine"))), "the save waited");
        assert_eq!(heard_while_busy, None, "the re-check ran on the saving thread");
        let notice = next(&notices, "a change during a save, after the thread is free");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "theirs")));
        assert_quiet(&notices);
    }

    // A change between watch() and the start of its folder's OS watch has no event.
    #[test]
    fn a_change_before_the_os_watch_starts_is_reported_once_it_does() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "new");
        let (watcher, notices) = watcher();
        let watcher = Arc::new(watcher);
        let busy = lock(&watcher.folders);
        let opener = Arc::clone(&watcher);
        let opening = path.clone();
        let watched = within_a_second(move || opener.watch("main", opening, &hash("new")));
        // As if the file changed after watch() read it. FSEvents can report a write made
        // just before its watch starts, so a real write would not test the check.
        watcher.lock().by_key.values_mut().next().unwrap().hash = Some(hash("old"));
        drop(busy);

        assert_eq!(watched, Some(Ok(())), "watch waited");
        let notice = next(&notices, "a change before the OS watch started");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "new")));
        assert_quiet(&notices);
    }

    #[test]
    fn a_failed_folder_is_reported_only_to_the_windows_watching_it() {
        let dir = TempDir::new();
        let b = dir.file("b.md", "b");
        let gone = dir.0.join("gone").join("x.md").to_str().unwrap().to_owned();
        let (watcher, notices) = watcher();
        watch_now(&watcher, "w-2", b, &hash("b"));

        watch_now(&watcher, "w-1", gone.clone(), &hash("x"));

        let got: Vec<_> = notices.try_iter().collect();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0], ("w-1".to_owned(), removed(&gone)));
        assert_eq!(got[1].0, "w-1");
        assert!(matches!(got[1].1, Notice::Failed(_)), "{got:?}");
        assert_quiet(&notices);
    }

    #[test]
    fn a_change_by_another_program_during_a_save_is_reported_after_it() {
        let dir = TempDir::new();
        let path = dir.file("a.md", "old");
        let (watcher, notices) = watcher();
        watch_now(&watcher, "main", path.clone(), &hash("old"));

        let saved = watcher.saving("main", &path, || {
            let written = files::write_text(&path, "mine");
            fs::write(&path, "theirs").unwrap();
            // Lets the event arrive while the save still runs.
            thread::sleep(DEBOUNCE * 4);
            written
        });

        assert_eq!(saved, Ok(hash("mine")));
        let notice = next(&notices, "a change during a save");
        assert_eq!(notice, ("main".to_owned(), changed(&path, "theirs")));
        assert_quiet(&notices);
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
        watch_now(&watcher, "main", a.clone(), &hash("back"));
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
            watch_now(&watcher, "main", a.clone(), &hash("back"));
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
        watch_now(&watcher, "main", path.clone(), &hash("old"));
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
            ..Watched::new(Some(hash("old")))
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

        watch_now(&watcher, "main", path.clone(), &hash("known"));

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
        use tauri::test::{mock_builder, MockRuntime};
        use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

        fn app() -> tauri::App<MockRuntime> {
            let app = mock_builder()
                .manage(PathRegistry::default())
                .manage(FocusOrder::default())
                .manage(Mutex::new(OpenQueue::default()))
                .build(crate::test_support::mock_context())
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
                None,
            ))
            .unwrap();

            let watcher = app.state::<Watcher>();
            let files = watcher.lock();
            let watched = files.by_key.values().next().unwrap();
            assert_eq!(watched.hash, Some(hash("mine")));
        }

        #[test]
        fn write_text_file_refuses_a_file_changed_since_the_hash_it_expects() {
            let dir = TempDir::new();
            let path = dir.file("a.md", "theirs");
            let app = app();
            let main = window(&app, "main");

            let saved = block_on(files::write_text_file(
                main,
                app.state(),
                path.clone(),
                "mine".to_owned(),
                Some(hash("base")),
            ));

            assert_eq!(saved, Err(files::CHANGED_ON_DISK.to_owned()));
            assert_eq!(fs::read_to_string(&path).unwrap(), "theirs");
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
                None,
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
