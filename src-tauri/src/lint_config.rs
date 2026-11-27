//! Finds the markdownlint config file that applies to a document (spec end state 21).

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::files;

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

#[tauri::command]
pub async fn find_lint_config(doc_path: String) -> Result<Option<LintConfigResult>, String> {
    find(Path::new(&doc_path))
}

/// Searches from the document's folder up, stopping after the first folder that holds
/// `.git` (a folder, or a file in worktrees and submodules) or at the root.
pub fn find(doc_path: &Path) -> Result<Option<LintConfigResult>, String> {
    let Some(folder) = doc_path.parent() else {
        return Ok(None);
    };
    // The same spelling as normalize_path, so the config's watch and events match.
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

fn read(path: &Path, format: &'static str) -> Result<LintConfigResult, String> {
    let shown = path.display();
    let bytes = fs::read(path).map_err(|e| format!("Could not read {shown}: {e}"))?;
    let hash = files::sha256_hex(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| format!("{shown} is not UTF-8 text."))?;
    Ok(LintConfigResult {
        path: path.to_string_lossy().into_owned(),
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

    #[test]
    fn a_config_that_is_not_utf8_is_an_error() {
        let repo = Repo::new();
        let config = repo.0.join(".markdownlint.json");
        fs::write(&config, [0xff, 0xfe, 0x7b]).unwrap();
        let doc = repo.doc("doc.md");

        let err = find(&doc).unwrap_err();

        assert!(err.contains(".markdownlint.json"), "{err}");
    }
}
