//! Finds the markdownlint config file that applies to a document (spec end state 21).

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::files;

// 1 MB = 1,000,000 bytes, as for the large-file guard (Ruling 357).
const MAX_CONFIG_BYTES: u64 = 1_000_000;
const TOO_LARGE: &str = "Lintel does not read lint config files over 1 MB.";

/// Checked in this order in each folder. `.cjs` and `.mjs` configs are code, so never read.
const CONFIG_FILES: [(&str, &str); 4] = [
    (".markdownlint.json", "json"),
    (".markdownlint.jsonc", "jsonc"),
    (".markdownlint.yaml", "yaml"),
    (".markdownlint.yml", "yaml"),
];

#[derive(Debug, PartialEq, Serialize)]
pub struct LintConfigResult {
    pub path: String,
    pub format: &'static str,
    pub text: String,
    /// Used as `watch_path`'s known hash, so watching the config reports nothing at once.
    pub hash: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindError {
    /// The config file that could not be read, when the search found one.
    pub path: Option<String>,
    pub message: String,
    /// The search ran out of time; the window then keeps the config it has (Ruling 298).
    pub timed_out: bool,
}

impl FindError {
    fn timed_out() -> Self {
        Self {
            path: None,
            message: "Looking for a lint config took too long.".to_owned(),
            timed_out: true,
        }
    }

    fn crashed() -> Self {
        Self {
            path: None,
            message: "Looking for a lint config failed unexpectedly.".to_owned(),
            timed_out: false,
        }
    }
}

type Finder = fn(&Path) -> Result<Option<LintConfigResult>, FindError>;

/// How the command searches, and the doc folders whose search is still running. A stat on
/// a mount whose server is gone can block for minutes, so each folder has at most one
/// search at a time (Ruling 310).
pub struct Searches {
    finder: Finder,
    running: Arc<Mutex<HashSet<PathBuf>>>,
}

impl Default for Searches {
    fn default() -> Self {
        Self {
            finder: find,
            running: Arc::default(),
        }
    }
}

/// Off the async workers and within paths_exist's time budget. A search of a folder that
/// is still being searched answers "timed out" at once.
#[tauri::command]
pub async fn find_lint_config(
    searches: State<'_, Searches>,
    doc_path: String,
) -> Result<Option<LintConfigResult>, FindError> {
    let folder = Path::new(&doc_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let Some(running) = Running::start(&searches.running, folder) else {
        return Err(FindError::timed_out());
    };
    let finder = searches.finder;
    let search = move || {
        let _running = running;
        finder(Path::new(&doc_path))
    };
    tauri::async_runtime::spawn_blocking(move || within(files::CHECK_BUDGET, search))
        .await
        .unwrap_or_else(|_| Err(FindError::crashed()))
}

/// A folder's place in the running set, given up when the search ends, even by a panic.
struct Running {
    set: Arc<Mutex<HashSet<PathBuf>>>,
    folder: PathBuf,
}

impl Running {
    fn start(set: &Arc<Mutex<HashSet<PathBuf>>>, folder: PathBuf) -> Option<Self> {
        let started = lock(set).insert(folder.clone());
        started.then(|| Self {
            set: Arc::clone(set),
            folder,
        })
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        lock(&self.set).remove(&self.folder);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs `search` on its own thread. Past `budget` it is left to finish on its own.
fn within<T: Send + 'static>(
    budget: Duration,
    search: impl FnOnce() -> Result<T, FindError> + Send + 'static,
) -> Result<T, FindError> {
    let (send, answer) = mpsc::channel();
    thread::spawn(move || {
        let _ = send.send(search());
    });
    match answer.recv_timeout(budget) {
        Ok(found) => found,
        Err(RecvTimeoutError::Timeout) => Err(FindError::timed_out()),
        // The search panicked, so its sender went without an answer.
        Err(RecvTimeoutError::Disconnected) => Err(FindError::crashed()),
    }
}

/// Searches from the document's folder up, stopping after the first folder that holds
/// `.git` (a folder, or a file in worktrees and submodules) or at the root.
pub fn find(doc_path: &Path) -> Result<Option<LintConfigResult>, FindError> {
    let Some(folder) = doc_path.parent() else {
        return Ok(None);
    };
    let folder = files::canonical(folder).unwrap_or_else(|_| folder.to_path_buf());
    for dir in folder.ancestors() {
        for (name, format) in CONFIG_FILES {
            let path = dir.join(name);
            if path.is_file() {
                return read(&path, format).map(Some);
            }
        }
        if fs::symlink_metadata(dir.join(".git")).is_ok() {
            break;
        }
    }
    Ok(None)
}

fn read(path: &Path, format: &'static str) -> Result<LintConfigResult, FindError> {
    // As normalize_path spells it, links resolved, so its watch and a save in Lintel agree.
    let path = files::canonical(path).unwrap_or_else(|_| path.to_path_buf());
    let shown = path.to_string_lossy().into_owned();
    let fail = |message: String| FindError {
        path: Some(shown.clone()),
        message,
        timed_out: false,
    };
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|file| file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| fail(format!("Could not read the file: {e}")))?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(fail(TOO_LARGE.to_owned()));
    }
    let hash = files::sha256_hex(&bytes);
    let text = String::from_utf8(bytes)
        .map_err(|_| fail("Lintel reads lint config files in UTF-8 only.".to_owned()))?;
    Ok(LintConfigResult {
        path: shown,
        format,
        text,
        hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fresh folder per test with a `.git` marker, so no search leaves it (Ruling 286).
    struct Repo(PathBuf);

    impl Repo {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "lintel-config-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join(".git")).unwrap();
            Self(files::canonical(&dir).unwrap())
        }

        fn file(&self, rel: &str, text: &str) -> PathBuf {
            // Joined part by part, so Windows paths use backslashes throughout.
            let path = rel
                .split('/')
                .fold(self.0.clone(), |path, part| path.join(part));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path
        }

        fn doc(&self, rel: &str) -> PathBuf {
            self.file(rel, "# Doc\n")
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn found(doc: &Path) -> Option<String> {
        find(doc).unwrap().map(|r| r.path)
    }

    fn path_str(path: PathBuf) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_config_two_folders_up_is_found_with_its_text_format_and_hash() {
        let repo = Repo::new();
        let config = repo.file(".markdownlint.json", "{ \"MD013\": false }");
        let doc = repo.doc("a/b/doc.md");

        let result = find(&doc).unwrap().unwrap();

        assert_eq!(
            result,
            LintConfigResult {
                path: path_str(config),
                format: "json",
                text: "{ \"MD013\": false }".to_owned(),
                hash: files::sha256_hex(b"{ \"MD013\": false }"),
            }
        );
    }

    #[test]
    fn the_nearest_config_wins() {
        let repo = Repo::new();
        repo.file(".markdownlint.json", "{}");
        let near = repo.file("a/.markdownlint.yaml", "MD013: false");
        let doc = repo.doc("a/doc.md");

        assert_eq!(found(&doc), Some(path_str(near)));
    }

    #[test]
    fn a_config_above_a_folder_holding_git_is_not_found() {
        let repo = Repo::new();
        repo.file(".markdownlint.json", "{}");
        fs::create_dir_all(repo.0.join("inner/.git")).unwrap();
        let doc = repo.doc("inner/docs/doc.md");

        assert_eq!(found(&doc), None);
    }

    #[test]
    fn a_git_file_also_ends_the_search() {
        let repo = Repo::new();
        repo.file(".markdownlint.json", "{}");
        repo.file("worktree/.git", "gitdir: ../.git/worktrees/w");
        let doc = repo.doc("worktree/doc.md");

        assert_eq!(found(&doc), None);
    }

    #[test]
    fn a_config_beside_git_is_found() {
        let repo = Repo::new();
        let config = repo.file(".markdownlint.yml", "default: true");
        let doc = repo.doc("doc.md");

        let result = find(&doc).unwrap().unwrap();

        assert_eq!((result.path, result.format), (path_str(config), "yaml"));
    }

    #[test]
    fn code_configs_are_never_read() {
        let repo = Repo::new();
        repo.file(".markdownlint.cjs", "module.exports = {};");
        repo.file(".markdownlint.mjs", "export default {};");
        let doc = repo.doc("doc.md");

        assert_eq!(found(&doc), None);
    }

    #[test]
    fn json_wins_over_yaml_in_the_same_folder() {
        let repo = Repo::new();
        let json = repo.file(".markdownlint.json", "{}");
        repo.file(".markdownlint.yaml", "MD013: false");
        let doc = repo.doc("doc.md");

        assert_eq!(found(&doc), Some(path_str(json)));
    }

    #[test]
    fn the_spec_order_is_json_jsonc_yaml_yml() {
        let repo = Repo::new();
        let names = [
            ".markdownlint.json",
            ".markdownlint.jsonc",
            ".markdownlint.yaml",
            ".markdownlint.yml",
        ];
        let doc = repo.doc("doc.md");
        for name in names {
            repo.file(name, "{}");
        }

        for name in names {
            assert_eq!(found(&doc), Some(path_str(repo.0.join(name))));
            fs::remove_file(repo.0.join(name)).unwrap();
        }
    }

    #[test]
    fn a_folder_named_like_a_config_is_skipped() {
        let repo = Repo::new();
        fs::create_dir_all(repo.0.join("a/.markdownlint.json")).unwrap();
        let yaml = repo.file("a/.markdownlint.yaml", "{}");
        let doc = repo.doc("a/doc.md");

        assert_eq!(found(&doc), Some(path_str(yaml)));
    }

    #[test]
    fn the_config_path_is_canonical_like_a_doc_path() {
        let repo = Repo::new();
        let config = repo.file(".markdownlint.json", "{}");
        repo.doc("a/doc.md");
        let roundabout = repo.0.join("a/./../a/doc.md");

        assert_eq!(found(&roundabout), Some(path_str(config)));
    }

    // Ruling 357: a huge file is not a config, and reading it all could stall the search.
    #[test]
    fn a_config_over_1_mb_is_an_error_and_one_of_1_mb_is_read() {
        let repo = Repo::new();
        let config = repo.0.join(".markdownlint.json");
        let doc = repo.doc("doc.md");
        let padded = |len: usize| format!("{{{}}}", " ".repeat(len - 2));

        fs::write(&config, padded(1_000_000)).unwrap();
        assert_eq!(find(&doc).unwrap().unwrap().text.len(), 1_000_000);

        fs::write(&config, padded(1_000_001)).unwrap();
        let err = find(&doc).unwrap_err();
        assert_eq!(
            err,
            FindError {
                path: Some(path_str(config)),
                message: "Lintel does not read lint config files over 1 MB.".to_owned(),
                timed_out: false,
            }
        );
    }

    #[test]
    fn a_config_that_is_not_utf8_is_an_error() {
        let repo = Repo::new();
        let config = repo.0.join(".markdownlint.json");
        fs::write(&config, [0xff, 0xfe, 0x7b]).unwrap();
        let doc = repo.doc("doc.md");

        let err = find(&doc).unwrap_err();

        assert_eq!(
            err,
            FindError {
                path: Some(path_str(config)),
                message: "Lintel reads lint config files in UTF-8 only.".to_owned(),
                timed_out: false,
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_config_is_found_at_the_file_it_links_to() {
        let repo = Repo::new();
        let real = repo.file("shared/lint.json", "{}");
        std::os::unix::fs::symlink(&real, repo.0.join(".markdownlint.json")).unwrap();
        let doc = repo.doc("doc.md");

        assert_eq!(found(&doc), Some(path_str(real)));
    }

    #[test]
    fn a_search_that_blocks_ends_at_the_time_budget() {
        let started = std::time::Instant::now();

        let answer = within(Duration::from_millis(50), || {
            thread::sleep(Duration::from_secs(2));
            Ok(())
        });

        assert_eq!(answer, Err(FindError::timed_out()));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    mod the_command {
        use super::*;
        use std::sync::atomic::AtomicUsize;
        use std::time::Instant;
        use tauri::async_runtime::block_on;
        use tauri::test::{mock_builder, MockRuntime};
        use tauri::Manager;

        const SLOW: Duration = Duration::from_secs(3);

        fn app(finder: Finder) -> tauri::App<MockRuntime> {
            mock_builder()
                .manage(Searches {
                    finder,
                    running: Arc::default(),
                })
                .build(crate::test_support::mock_context())
                .unwrap()
        }

        fn search(
            app: &tauri::App<MockRuntime>,
            doc: &str,
        ) -> Result<Option<LintConfigResult>, FindError> {
            block_on(find_lint_config(app.state(), doc.to_owned()))
        }

        #[test]
        fn answers_with_the_config_found() {
            let repo = Repo::new();
            let config = repo.file(".markdownlint.json", "{}");
            let doc = path_str(repo.doc("doc.md"));

            let answer = search(&app(find), &doc).unwrap();

            assert_eq!(answer.map(|r| r.path), Some(path_str(config)));
        }

        #[test]
        fn a_search_that_blocks_times_out_within_the_budget() {
            fn blocking(_: &Path) -> Result<Option<LintConfigResult>, FindError> {
                thread::sleep(SLOW);
                Ok(None)
            }
            let started = Instant::now();

            let answer = search(&app(blocking), "/blocked/doc.md");

            assert_eq!(answer, Err(FindError::timed_out()));
            assert!(started.elapsed() < files::CHECK_BUDGET + Duration::from_millis(500));
        }

        #[test]
        fn a_folder_still_being_searched_answers_timed_out_at_once() {
            static CALLS: AtomicUsize = AtomicUsize::new(0);
            fn counted(_: &Path) -> Result<Option<LintConfigResult>, FindError> {
                // Only the first search is slow.
                if CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
                    thread::sleep(files::CHECK_BUDGET + Duration::from_millis(500));
                }
                Ok(None)
            }
            let app = app(counted);
            assert_eq!(search(&app, "/slow/a.md"), Err(FindError::timed_out()));

            let started = Instant::now();
            let again = search(&app, "/slow/b.md");

            assert_eq!(again, Err(FindError::timed_out()));
            assert!(started.elapsed() < Duration::from_millis(200));
            assert_eq!(CALLS.load(Ordering::SeqCst), 1);
            // Once the first search ends, the folder can be searched again.
            thread::sleep(Duration::from_millis(1000));
            assert_eq!(search(&app, "/slow/a.md"), Ok(None));
            assert_eq!(CALLS.load(Ordering::SeqCst), 2);
        }

        #[test]
        fn a_search_that_panics_is_an_error_and_frees_its_folder() {
            fn panics(_: &Path) -> Result<Option<LintConfigResult>, FindError> {
                panic!("a search bug");
            }
            let app = app(panics);

            assert_eq!(search(&app, "/x/doc.md"), Err(FindError::crashed()));
            assert_eq!(search(&app, "/x/doc.md"), Err(FindError::crashed()));
        }
    }

    #[test]
    fn a_find_error_reaches_the_window_in_camel_case() {
        let value = serde_json::to_value(FindError::timed_out()).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "path": null,
                "message": "Looking for a lint config took too long.",
                "timedOut": true,
            })
        );
    }
}
