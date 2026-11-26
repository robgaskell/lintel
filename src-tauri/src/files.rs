use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

const NOT_UTF8: &str = "Lintel opens UTF-8 text files only.";

#[derive(Debug, Serialize)]
pub struct ReadResult {
    pub text: String,
    pub hash: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

// Async so file I/O runs off the main thread.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<ReadResult, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let hash = sha256_hex(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| NOT_UTF8.to_owned())?;
    Ok(ReadResult { text, hash })
}

/// Returns the sha-256 hex of the bytes written.
#[tauri::command]
pub async fn write_text_file(path: String, text: String) -> Result<String, String> {
    write_atomic(Path::new(&path), text.as_bytes())
        .map_err(|e| format!("Could not save {path}: {e}"))?;
    Ok(sha256_hex(text.as_bytes()))
}

/// Writes `.<name>.lintel-tmp` beside the target, syncs it, then renames it over
/// the target, so a crash never leaves a half-written file.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let tmp = dir.join(format!(".{}.lintel-tmp", name.to_string_lossy()));

    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        // Keep the target's mode; a new temp file would get the default one.
        if let Ok(meta) = fs::metadata(path) {
            file.set_permissions(meta.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
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
}
