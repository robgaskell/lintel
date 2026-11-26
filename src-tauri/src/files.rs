use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::hash_map::RandomState;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions, Permissions};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const NOT_UTF8: &str = "Lintel opens UTF-8 text files only.";
const READ_ONLY: &str = "This file is read-only.";

#[derive(Debug, Serialize)]
pub struct ReadResult {
    pub text: String,
    pub hash: String,
}

// Async so file I/O runs off the main thread.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<ReadResult, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    // NUL-interleaved UTF-16 is valid UTF-8 byte for byte, but it is not text.
    if bytes.contains(&0) {
        return Err(NOT_UTF8.to_owned());
    }
    let hash = sha256_hex(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| NOT_UTF8.to_owned())?;
    Ok(ReadResult { text, hash })
}

/// Returns the sha-256 hex of the bytes written.
#[tauri::command]
pub async fn write_text_file(path: String, text: String) -> Result<String, String> {
    let fail = |e: io::Error| format!("Could not save {path}: {e}");
    let target = resolve_symlinks(Path::new(&path)).map_err(fail)?;
    let existing = match fs::metadata(&target) {
        Ok(meta) => Some(meta.permissions()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(fail(e)),
    };
    if existing.as_ref().is_some_and(Permissions::readonly) {
        return Err(READ_ONLY.to_owned());
    }
    write_atomic(&target, text.as_bytes(), existing).map_err(fail)?;
    Ok(sha256_hex(text.as_bytes()))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// The real file behind a symlink, so a save updates it instead of
/// replacing the link. A path that does not exist yet is used as given.
fn resolve_symlinks(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(real) => Ok(real),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(e),
    }
}

/// Writes a new temp file in the target's folder, syncs it, then renames it
/// over the target. Readers see the old bytes or the new bytes, never a mix.
/// The rename breaks hard links (Ruling 10).
fn write_atomic(path: &Path, bytes: &[u8], mode: Option<Permissions>) -> io::Result<()> {
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let (tmp, mut file) = create_temp(dir, mode.as_ref())?;

    let result = (|| {
        // Set the mode before writing so a private file is never readable by others.
        if let Some(mode) = mode {
            file.set_permissions(mode)?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Creates `.lintel-<16 random hex>.tmp`. A unique name lets saves run at the
/// same time, and create_new never follows or reuses a file someone planted.
fn create_temp(dir: &Path, mode: Option<&Permissions>) -> io::Result<(PathBuf, File)> {
    let mut last_error = None;
    for _ in 0..8 {
        let tmp = dir.join(format!(".lintel-{:016x}.tmp", random_u64()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(mode.mode() & 0o777);
        }
        #[cfg(not(unix))]
        let _ = mode;
        match options.open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last_error = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("could not create a temp file")))
}

/// std seeds each RandomState from OS randomness, so this needs no extra crate.
fn random_u64() -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::async_runtime::block_on;

    /// A fresh empty folder per test, so tests can run in parallel.
    fn temp_dir() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lintel-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn path_str(path: &Path) -> String {
        path.to_str().unwrap().to_owned()
    }

    #[test]
    fn sha256_hex_matches_known_digest() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn round_trip_returns_same_text_and_hash() {
        let dir = temp_dir();
        let file = path_str(&dir.join("note.md"));
        let text = "# Title\r\n\r\nCafé ✓\r\n".to_owned();

        let written_hash = block_on(write_text_file(file.clone(), text.clone())).unwrap();
        let read = block_on(read_text_file(file)).unwrap();

        assert_eq!(read.text, text);
        assert_eq!(read.hash, written_hash);
        assert_eq!(read.hash, sha256_hex(text.as_bytes()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn overwrite_leaves_no_temp_file() {
        let dir = temp_dir();
        let file = dir.join("note.md");
        fs::write(&file, "old").unwrap();

        block_on(write_text_file(path_str(&file), "new".to_owned())).unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec!["note.md"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_invalid_utf8() {
        let dir = temp_dir();
        let file = dir.join("utf16.md");
        fs::write(&file, [0xFF, 0xFE, 0x00]).unwrap();

        let err = block_on(read_text_file(path_str(&file))).unwrap_err();

        assert_eq!(err, "Lintel opens UTF-8 text files only.");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_file_is_an_error() {
        let dir = temp_dir();
        let result = block_on(read_text_file(path_str(&dir.join("missing.md"))));
        assert!(result.is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn overwrite_keeps_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let file = dir.join("private.md");
        fs::write(&file, "old").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();

        block_on(write_text_file(path_str(&file), "new".to_owned())).unwrap();

        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        fs::remove_dir_all(dir).unwrap();
    }

    fn file_names(dir: &Path) -> Vec<std::ffi::OsString> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn refuses_nul_bytes() {
        let dir = temp_dir();
        let file = dir.join("utf16-no-bom.md");
        fs::write(&file, b"a\0b\0").unwrap();

        let err = block_on(read_text_file(path_str(&file))).unwrap_err();

        assert_eq!(err, "Lintel opens UTF-8 text files only.");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_read_only_file() {
        let dir = temp_dir();
        let file = dir.join("locked.md");
        fs::write(&file, "old").unwrap();
        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&file, perms).unwrap();

        let err = block_on(write_text_file(path_str(&file), "new".to_owned())).unwrap_err();

        assert_eq!(err, "This file is read-only.");
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        assert_eq!(file_names(&dir), vec!["locked.md"]);
        // Windows will not delete a read-only file.
        #[cfg(windows)]
        {
            let mut perms = fs::metadata(&file).unwrap().permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            fs::set_permissions(&file, perms).unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn saves_a_250_byte_file_name() {
        let dir = temp_dir();
        let name = format!("{}.md", "a".repeat(247));
        assert_eq!(name.len(), 250);
        let file = dir.join(&name);
        fs::write(&file, "old").unwrap();

        block_on(write_text_file(path_str(&file), "new".to_owned())).unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_saves_to_same_path_both_succeed() {
        let dir = temp_dir();
        let file = path_str(&dir.join("note.md"));
        let big_a = "a".repeat(2 * 1024 * 1024);
        let big_b = "b".repeat(2 * 1024 * 1024);

        for _ in 0..20 {
            let (fa, fb) = (file.clone(), file.clone());
            let (ta, tb) = (big_a.clone(), big_b.clone());
            let a = std::thread::spawn(move || block_on(write_text_file(fa, ta)));
            let b = std::thread::spawn(move || block_on(write_text_file(fb, tb)));
            let hash_a = a.join().unwrap().unwrap();
            let hash_b = b.join().unwrap().unwrap();

            let on_disk = sha256_hex(&fs::read(&file).unwrap());
            assert!(on_disk == hash_a || on_disk == hash_b);
        }
        assert_eq!(file_names(&dir), vec!["note.md"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_rename_leaves_no_temp_file() {
        let dir = temp_dir();
        // A folder where the file should be makes the rename fail.
        fs::create_dir(dir.join("note.md")).unwrap();

        let result = block_on(write_text_file(
            path_str(&dir.join("note.md")),
            "new".to_owned(),
        ));

        assert!(result.is_err());
        assert_eq!(file_names(&dir), vec!["note.md"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn write_replaces_the_file_instead_of_writing_in_place() {
        use std::io::Read;
        use std::os::unix::fs::MetadataExt;
        let dir = temp_dir();
        let file = dir.join("note.md");
        fs::write(&file, "old").unwrap();
        let inode_before = fs::metadata(&file).unwrap().ino();
        let mut old_handle = File::open(&file).unwrap();

        block_on(write_text_file(path_str(&file), "new".to_owned())).unwrap();

        let mut seen = String::new();
        old_handle.read_to_string(&mut seen).unwrap();
        assert_eq!(seen, "old");
        assert_ne!(fs::metadata(&file).unwrap().ino(), inode_before);
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn save_through_symlink_updates_real_file() {
        let dir = temp_dir();
        let real = dir.join("real.md");
        let link = dir.join("link.md");
        fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        block_on(write_text_file(path_str(&link), "new".to_owned())).unwrap();

        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(file_names(&dir), vec!["link.md", "real.md"]);
        fs::remove_dir_all(dir).unwrap();
    }
}
