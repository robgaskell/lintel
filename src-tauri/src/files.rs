use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::hash_map::RandomState;
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions, Permissions};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const NOT_UTF8: &str = "Lintel opens UTF-8 text files only.";
const READ_ONLY: &str = "This file is read-only.";
const NOT_AN_IMAGE: &str = "Lintel shows png, jpg, jpeg, gif, webp and svg images only.";
// 1 MB = 1,000,000 bytes, as for the large-file guard.
const MAX_IMAGE_BYTES: usize = 10_000_000;
const NETWORK_PATH: &str = "Lintel does not load images from network paths.";
const NOT_IMAGE_FILE: &str = "Not an image file.";
// A stalled disk or mount must not hold a worker that Save also needs (Ruling 95).
const IMAGE_BUDGET: Duration = Duration::from_secs(2);

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

/// The canonical spelling of an existing file's path, so one file never opens in two tabs.
/// Letter case is not folded on case-insensitive volumes (Ruling 44).
#[tauri::command]
pub async fn normalize_path(path: String) -> Result<String, String> {
    let real = fs::canonicalize(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    let real = real
        .into_os_string()
        .into_string()
        .map_err(|_| format!("Could not open {path}: the path is not valid Unicode."))?;
    #[cfg(windows)]
    let real = strip_verbatim_prefix(&real);
    Ok(real)
}

/// Whether each path may still be a file, in order. False only when it is definitely gone.
/// plugin-fs `exists` is not used: its `**` scope rejects dot-folders such as ~/.claude (Ruling 51).
#[tauri::command]
pub async fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    let count = paths.len();
    tauri::async_runtime::spawn_blocking(move || check_within(paths, CHECK_BUDGET, may_be_file))
        .await
        .unwrap_or_else(|_| vec![true; count])
}

// A stat on a network mount whose server is gone can block for minutes (Ruling 71).
const CHECK_BUDGET: Duration = Duration::from_secs(1);

/// Errors other than "not there", such as permission denied, count as present, so a file
/// that only cannot be checked right now is not dropped from Open Recent.
fn may_be_file(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(meta) => meta.is_file(),
        Err(e) => !matches!(
            e.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
        ),
    }
}

/// Runs `check` on each path, in order, on its own thread. Paths not answered within
/// `budget` count as present; a stuck check is left to finish on its own.
fn check_within<F>(paths: Vec<String>, budget: Duration, check: F) -> Vec<bool>
where
    F: Fn(&Path) -> bool + Send + 'static,
{
    let mut found = vec![true; paths.len()];
    let (send, answers) = mpsc::channel();
    thread::spawn(move || {
        for (i, path) in paths.iter().enumerate() {
            if send.send((i, check(Path::new(path)))).is_err() {
                return;
            }
        }
    });
    let deadline = Instant::now() + budget;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match answers.recv_timeout(left) {
            Ok((i, present)) => found[i] = present,
            // Out of time, or every path answered.
            Err(_) => break,
        }
    }
    found
}

/// Windows canonical paths start with `\\?\`, which other tools and file dialogs do not use.
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path.to_owned()
    }
}

/// A local image as a `data:` URI, so the preview never needs a file scope on the webview.
/// Refuses network paths, other types, content that is not that type, and files over 10 MB.
#[tauri::command]
pub async fn read_image_as_data_uri(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_within(path, IMAGE_BUDGET, read_image))
        .await
        .map_err(|e| format!("Could not read the image: {e}"))?
}

/// Runs `read` on its own thread; past `budget` it is left to finish on its own.
fn read_within<F>(path: String, budget: Duration, read: F) -> Result<String, String>
where
    F: FnOnce(&str) -> Result<String, String> + Send + 'static,
{
    let (send, answer) = mpsc::channel();
    let shown = path.clone();
    thread::spawn(move || {
        let _ = send.send(read(&path));
    });
    match answer.recv_timeout(budget) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!("Timed out reading {shown}.")),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("Could not read {shown}.")),
    }
}

fn read_image(path: &str) -> Result<String, String> {
    // Opening a UNC path on Windows connects to that host and can leak the user's hash (Ruling 94).
    if is_network_path(path) || walk_reaches_network_path(Path::new(path), &RealLinks) {
        return Err(NETWORK_PATH.to_owned());
    }
    let kind = image_kind(Path::new(path)).ok_or_else(|| NOT_AN_IMAGE.to_owned())?;
    let fail = |e: io::Error| format!("Could not read {path}: {e}");
    // A mapped drive canonicalises to its share, so it is refused too (Rulings 104, 116).
    let real = fs::canonicalize(path).map_err(fail)?;
    if resolves_to_network_path(&real.to_string_lossy()) {
        return Err(NETWORK_PATH.to_owned());
    }
    let mut bytes = Vec::new();
    // Reading one byte past the limit catches a file that grows after a size check would.
    File::open(&real)
        .map_err(fail)?
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(fail)?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("{path} is larger than 10 MB, so it is not shown."));
    }
    // A symlinked "logo.png" may point at a key file; only real images pass (Ruling 96).
    if !kind.matches(&bytes) {
        return Err(NOT_IMAGE_FILE.to_owned());
    }
    Ok(format!("data:{};base64,{}", kind.mime(), BASE64_STANDARD.encode(&bytes)))
}

/// What the walk needs from the filesystem; tests supply a fake.
trait Links {
    /// The target of `path` when `path` itself is a symlink. Must not follow the link.
    fn link_target(&self, path: &Path) -> Option<PathBuf>;
}

struct RealLinks;

impl Links for RealLinks {
    // symlink_metadata and read_link read the link itself; neither opens what it points at.
    fn link_target(&self, path: &Path) -> Option<PathBuf> {
        let meta = fs::symlink_metadata(path).ok()?;
        if !meta.file_type().is_symlink() {
            return None;
        }
        fs::read_link(path).ok()
    }
}

/// Walks `path` one component at a time from the root, checking each symlink's target for a
/// network prefix before following it. So no step opens a path through a link to a share,
/// which on Windows would connect to that host (Ruling 116). A chain of more than 40 links
/// also counts as reaching one, since its end was never checked (Ruling 118).
fn walk_reaches_network_path(path: &Path, links: &impl Links) -> bool {
    let mut resolved = PathBuf::new();
    let mut rest: VecDeque<PathBuf> = path.components().map(|c| PathBuf::from(c.as_os_str())).collect();
    let mut hops = 0;
    while let Some(part) = rest.pop_front() {
        match part.components().next() {
            Some(Component::Normal(_)) => resolved.push(&part),
            Some(Component::ParentDir) => {
                resolved.pop();
                continue;
            }
            Some(Component::RootDir | Component::Prefix(_)) => {
                resolved.push(&part);
                continue;
            }
            Some(Component::CurDir) | None => continue,
        }
        let Some(target) = links.link_target(&resolved) else {
            continue;
        };
        if resolves_to_network_path(&target.to_string_lossy()) {
            return true;
        }
        hops += 1;
        if hops > 40 {
            // A loop, or a chain too long to check to its end: refuse (Ruling 118).
            return true;
        }
        resolved.pop();
        if target.has_root() {
            resolved = PathBuf::new();
        }
        for part in target.components().rev() {
            rest.push_front(PathBuf::from(part.as_os_str()));
        }
    }
    false
}

/// Windows canonical paths carry `\\?\`, which would look like a network path on its own.
fn resolves_to_network_path(canonical: &str) -> bool {
    is_network_path(&strip_verbatim_prefix(canonical))
}

/// Two leading separators in any mix (`//`, `\\`, `/\`, `\/`) mean UNC, `\\?\` or `\\.\` on
/// Windows. Checked on every OS, so the rule is tested everywhere.
fn is_network_path(path: &str) -> bool {
    let mut chars = path.chars();
    let is_sep = |c: Option<char>| matches!(c, Some('/' | '\\'));
    if is_sep(chars.next()) && is_sep(chars.next()) {
        return true;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if let Some(Component::Prefix(prefix)) = Path::new(path).components().next() {
            return matches!(
                prefix.kind(),
                Prefix::UNC(..) | Prefix::VerbatimUNC(..) | Prefix::DeviceNS(..)
            );
        }
    }
    false
}

#[derive(Clone, Copy)]
enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
}

// The type comes from the extension; the content must then agree with it.
fn image_kind(path: &Path) -> Option<ImageKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => ImageKind::Png,
        "jpg" | "jpeg" => ImageKind::Jpeg,
        "gif" => ImageKind::Gif,
        "webp" => ImageKind::Webp,
        "svg" => ImageKind::Svg,
        _ => return None,
    })
}

impl ImageKind {
    fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Gif => "image/gif",
            ImageKind::Webp => "image/webp",
            ImageKind::Svg => "image/svg+xml",
        }
    }

    fn matches(self, bytes: &[u8]) -> bool {
        match self {
            ImageKind::Png => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
            ImageKind::Jpeg => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
            ImageKind::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            ImageKind::Webp => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
            ImageKind::Svg => std::str::from_utf8(bytes).is_ok_and(starts_with_svg_element),
        }
    }
}

/// True when the first element is `<svg`, after an optional BOM, XML declaration,
/// comments and doctype (with or without an internal subset).
fn starts_with_svg_element(text: &str) -> bool {
    let mut rest = text.trim_start_matches('\u{feff}');
    loop {
        rest = rest.trim_start();
        let skipped = if rest.starts_with("<?") {
            rest.find("?>").map(|end| end + 2)
        } else if rest.starts_with("<!--") {
            rest.find("-->").map(|end| end + 3)
        } else if rest.get(..9).is_some_and(|head| head.eq_ignore_ascii_case("<!DOCTYPE")) {
            doctype_end(rest)
        } else {
            break;
        };
        match skipped {
            Some(end) => rest = &rest[end..],
            None => return false,
        }
    }
    rest.strip_prefix("<svg")
        .and_then(|after| after.chars().next())
        .is_some_and(|c| c.is_whitespace() || c == '>' || c == '/')
}

// A doctype ends at the first `>` outside its `[...]` internal subset.
fn doctype_end(text: &str) -> Option<usize> {
    let mut in_subset = false;
    for (i, c) in text.char_indices() {
        match c {
            '[' => in_subset = true,
            ']' => in_subset = false,
            '>' if !in_subset => return Some(i + 1),
            _ => {}
        }
    }
    None
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
    fn normalize_path_removes_dot_segments() {
        let dir = temp_dir();
        fs::write(dir.join("note.md"), "x").unwrap();

        let dotted = block_on(normalize_path(path_str(&dir.join(".").join("note.md")))).unwrap();
        let plain = block_on(normalize_path(path_str(&dir.join("note.md")))).unwrap();

        assert_eq!(dotted, plain);
        assert!(!dotted.contains("/./"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn normalize_path_resolves_a_symlinked_folder() {
        let dir = temp_dir();
        let real = dir.join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("note.md"), "x").unwrap();
        std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();

        let via_link =
            block_on(normalize_path(path_str(&dir.join("link").join("note.md")))).unwrap();
        let direct = block_on(normalize_path(path_str(&real.join("note.md")))).unwrap();

        assert_eq!(via_link, direct);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn normalize_path_names_a_missing_file() {
        let dir = temp_dir();
        let missing = path_str(&dir.join("missing.md"));

        let err = block_on(normalize_path(missing.clone())).unwrap_err();

        assert!(err.contains(&missing), "{err}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn strip_verbatim_prefix_gives_plain_windows_paths() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\notes\a.md"),
            r"C:\notes\a.md"
        );
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\a.md"),
            r"\\server\share\a.md"
        );
        assert_eq!(strip_verbatim_prefix(r"C:\notes\a.md"), r"C:\notes\a.md");
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

    #[test]
    fn paths_exist_reports_each_path_in_order() {
        let dir = temp_dir();
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::create_dir(dir.join("folder")).unwrap();

        let found = block_on(paths_exist(vec![
            path_str(&dir.join("missing.md")),
            path_str(&dir.join("a.md")),
            path_str(&dir.join("folder")),
        ]));

        assert_eq!(found, vec![false, true, false]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn paths_exist_sees_files_inside_dot_folders() {
        let dir = temp_dir();
        let hidden = dir.join(".claude").join("plans");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join("plan.md"), "x").unwrap();

        let found = block_on(paths_exist(vec![path_str(&hidden.join("plan.md"))]));

        assert_eq!(found, vec![true]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn paths_exist_counts_a_file_it_may_not_stat_as_present() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let locked = dir.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("a.md"), "x").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let found = block_on(paths_exist(vec![path_str(&locked.join("a.md"))]));

        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(found, vec![true]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checks_over_budget_count_as_present() {
        let paths = vec!["/gone".to_owned(), "/slow".to_owned(), "/after".to_owned()];
        let started = std::time::Instant::now();

        let found = check_within(paths, std::time::Duration::from_millis(50), |path| {
            if path == Path::new("/slow") {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            false
        });

        assert_eq!(found, vec![false, true, true]);
        assert!(started.elapsed() < std::time::Duration::from_millis(400));
    }
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0];
    const GIF: &[u8] = b"GIF89a";
    const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 ";
    const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>";

    fn read_image(path: &Path) -> Result<String, String> {
        block_on(read_image_as_data_uri(path_str(path)))
    }

    fn data_uri(mime: &str, bytes: &[u8]) -> String {
        format!("data:{mime};base64,{}", BASE64_STANDARD.encode(bytes))
    }

    #[test]
    fn image_becomes_a_data_uri_with_its_type() {
        let dir = temp_dir();
        let file = dir.join("pic.png");
        fs::write(&file, PNG).unwrap();

        assert_eq!(read_image(&file).unwrap(), "data:image/png;base64,iVBORw0KGgo=");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn image_type_comes_from_the_extension_in_any_case() {
        let dir = temp_dir();
        let cases = [
            ("a.JPG", "image/jpeg", JPEG),
            ("b.jpeg", "image/jpeg", JPEG),
            ("c.gif", "image/gif", GIF),
            ("d.webp", "image/webp", WEBP),
            ("e.svg", "image/svg+xml", SVG),
        ];
        for (name, mime, bytes) in cases {
            let file = dir.join(name);
            fs::write(&file, bytes).unwrap();
            assert_eq!(read_image(&file).unwrap(), data_uri(mime, bytes), "{name}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn image_refuses_other_extensions() {
        let dir = temp_dir();
        for name in ["a.bmp", "notes.md", "README", "pic.png.exe"] {
            let file = dir.join(name);
            fs::write(&file, PNG).unwrap();
            assert_eq!(read_image(&file).unwrap_err(), NOT_AN_IMAGE, "{name}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn image_refuses_a_file_over_10_mb() {
        let dir = temp_dir();
        let file = dir.join("big.png");
        let mut bytes = PNG.to_vec();
        bytes.resize(MAX_IMAGE_BYTES + 1, 0);
        fs::write(&file, bytes).unwrap();

        let err = read_image(&file).unwrap_err();

        assert!(err.contains("larger than 10 MB"), "{err}");
        assert!(err.contains("big.png"), "{err}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn image_of_exactly_10_mb_is_read() {
        let dir = temp_dir();
        let file = dir.join("edge.gif");
        let mut bytes = GIF.to_vec();
        bytes.resize(MAX_IMAGE_BYTES, 0);
        fs::write(&file, bytes).unwrap();

        assert!(read_image(&file).unwrap().starts_with("data:image/gif;base64,R0lGODlh"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn image_names_a_missing_file() {
        let dir = temp_dir();
        let file = dir.join("gone.png");

        let err = read_image(&file).unwrap_err();

        assert!(err.starts_with(&format!("Could not read {}", path_str(&file))), "{err}");
        fs::remove_dir_all(dir).unwrap();
    }

    // Ruling 94: these must be refused before any read, so no test touches a network.
    #[test]
    fn image_refuses_network_paths_on_every_os() {
        let paths = [
            "//evil.example/share/a.png",
            r"\\evil.example\share\a.png",
            r"/\evil.example\share\a.png",
            r"\/evil.example/share/a.png",
            r"\\?\UNC\evil.example\share\a.png",
            r"\\.\pipe\name.png",
        ];
        for path in paths {
            let err = block_on(read_image_as_data_uri(path.to_owned())).unwrap_err();
            assert_eq!(err, NETWORK_PATH, "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn image_refuses_unc_and_device_prefixes() {
        for path in [r"\\server\share\a.png", r"\\?\UNC\server\share\a.png", r"\\.\COM1\a.png"] {
            assert!(is_network_path(path), "{path}");
        }
        assert!(!is_network_path(r"C:\pics\a.png"));
    }

    // Ruling 96: the content must be what the extension claims.
    #[test]
    fn image_refuses_content_that_is_not_that_image_type() {
        let dir = temp_dir();
        let cases: [(&str, &[u8]); 8] = [
            ("text.png", b"-----BEGIN OPENSSH PRIVATE KEY-----\n"),
            ("jpeg-bytes.png", JPEG),
            ("short.jpg", &[0xFF, 0xD8]),
            ("text.gif", b"GIF90a"),
            ("wave.webp", b"RIFF\x24\x00\x00\x00WAVEfmt "),
            ("page.svg", b"<html><svg/></html>"),
            ("binary.svg", &[0xFF, 0xFE, b'<', 0]),
            ("accent.svg", "<!DOCTYPé><svg/>".as_bytes()),
        ];
        for (name, bytes) in cases {
            let file = dir.join(name);
            fs::write(&file, bytes).unwrap();
            assert_eq!(read_image(&file).unwrap_err(), NOT_IMAGE_FILE, "{name}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    // Ruling 104: a local name must not lead to a share. The target is never opened here.
    #[cfg(unix)]
    #[test]
    fn image_refuses_a_symlink_that_points_at_a_network_path() {
        let dir = temp_dir();
        let direct = dir.join("share.png");
        std::os::unix::fs::symlink("//evil.example/share/a.png", &direct).unwrap();
        let chained = dir.join("logo.png");
        std::os::unix::fs::symlink(&direct, &chained).unwrap();

        assert_eq!(read_image(&direct).unwrap_err(), NETWORK_PATH);
        assert_eq!(read_image(&chained).unwrap_err(), NETWORK_PATH);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn image_reads_through_a_local_symlink() {
        let dir = temp_dir();
        let real = dir.join("real.png");
        fs::write(&real, PNG).unwrap();
        let link = dir.join("link.png");
        std::os::unix::fs::symlink("real.png", &link).unwrap();

        assert_eq!(read_image(&link).unwrap(), "data:image/png;base64,iVBORw0KGgo=");
        fs::remove_dir_all(dir).unwrap();
    }

    /// Symlinks as a map, recording every path the walk asks about.
    struct FakeLinks {
        links: std::collections::HashMap<PathBuf, PathBuf>,
        asked: std::cell::RefCell<Vec<PathBuf>>,
    }

    impl FakeLinks {
        fn new(links: &[(&str, &str)]) -> Self {
            let links = links.iter().map(|(from, to)| (PathBuf::from(from), PathBuf::from(to))).collect();
            FakeLinks { links, asked: Default::default() }
        }
    }

    impl Links for FakeLinks {
        fn link_target(&self, path: &Path) -> Option<PathBuf> {
            self.asked.borrow_mut().push(path.to_path_buf());
            self.links.get(path).cloned()
        }
    }

    // Ruling 116: a folder link to a share is caught before anything looks inside it.
    #[test]
    fn walk_refuses_a_folder_link_to_a_share_before_following_it() {
        let links = FakeLinks::new(&[("/docs/assets", "//evil.example/share")]);

        assert!(walk_reaches_network_path(Path::new("/docs/assets/pics/a.png"), &links));
        let asked = links.asked.borrow();
        assert_eq!(asked.last().unwrap(), Path::new("/docs/assets"));
        assert!(!asked.iter().any(|p| p.starts_with("/docs/assets/pics")));
    }

    #[test]
    fn walk_follows_relative_links_and_dot_dot() {
        let links = FakeLinks::new(&[("/docs/img", "../pics"), ("/pics", r"\\evil.example\share")]);

        assert!(walk_reaches_network_path(Path::new("/docs/img/a.png"), &links));
    }

    #[test]
    fn walk_allows_local_links_and_local_verbatim_targets() {
        let links = FakeLinks::new(&[("/docs/img", "/pics"), ("/pics/a.png", r"\\?\C:\pics\a.png")]);

        assert!(!walk_reaches_network_path(Path::new("/docs/img/a.png"), &links));
        assert!(!walk_reaches_network_path(Path::new("/docs/plain.png"), &links));
    }

    // Ruling 118: past the hop cap the walk cannot tell, so it refuses.
    #[test]
    fn walk_refuses_a_link_loop() {
        let links = FakeLinks::new(&[("/a", "/b"), ("/b", "/a")]);

        assert!(walk_reaches_network_path(Path::new("/a/x.png"), &links));
    }

    #[test]
    fn walk_refuses_a_45_link_chain_that_ends_at_a_share() {
        let names: Vec<String> = (0..=45).map(|i| format!("/l{i}")).collect();
        let mut chain: Vec<(&str, &str)> = names.windows(2).map(|w| (w[0].as_str(), w[1].as_str())).collect();
        chain.push(("/l45", "//evil.example/share"));
        let links = FakeLinks::new(&chain);

        assert!(walk_reaches_network_path(Path::new("/l0/a.png"), &links));
    }

    #[cfg(unix)]
    #[test]
    fn image_refuses_a_path_through_a_folder_link_to_a_network_path() {
        let dir = temp_dir();
        let assets = dir.join("assets");
        std::os::unix::fs::symlink("//evil.example/share", &assets).unwrap();

        assert_eq!(read_image(&assets.join("a.png")).unwrap_err(), NETWORK_PATH);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn canonical_windows_paths_are_judged_without_their_verbatim_prefix() {
        assert!(!resolves_to_network_path(r"\\?\C:\pics\a.png"));
        assert!(resolves_to_network_path(r"\\?\UNC\evil.example\share\a.png"));
        assert!(!resolves_to_network_path("/Users/me/a.png"));
    }

    #[cfg(unix)]
    #[test]
    fn image_refuses_a_symlinked_png_that_points_at_a_text_file() {
        let dir = temp_dir();
        let secret = dir.join("id_ed25519");
        fs::write(&secret, b"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n").unwrap();
        let logo = dir.join("logo.png");
        std::os::unix::fs::symlink(&secret, &logo).unwrap();

        assert_eq!(read_image(&logo).unwrap_err(), NOT_IMAGE_FILE);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn svg_may_start_with_a_declaration_comments_and_a_doctype() {
        let dir = temp_dir();
        let file = dir.join("logo.svg");
        let svg = "\u{feff}<?xml version=\"1.0\"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x.dtd\" [ <!ENTITY a \"b\"> ]>\n<svg>\n</svg>";
        fs::write(&file, svg).unwrap();

        assert_eq!(read_image(&file).unwrap(), data_uri("image/svg+xml", svg.as_bytes()));
        fs::remove_dir_all(dir).unwrap();
    }

    // Ruling 95: a stalled read gives up after the budget instead of holding a worker.
    #[test]
    fn image_read_gives_up_after_its_budget() {
        let started = std::time::Instant::now();

        let err = read_within("/slow.png".to_owned(), Duration::from_millis(100), |_| {
            std::thread::sleep(Duration::from_millis(1000));
            Ok(String::new())
        })
        .unwrap_err();

        assert_eq!(err, "Timed out reading /slow.png.");
        assert!(started.elapsed() < Duration::from_millis(600));
    }

    #[test]
    fn image_read_within_budget_returns_the_result() {
        let got = read_within("/a.png".to_owned(), Duration::from_secs(1), |p| Ok(p.to_owned()));
        assert_eq!(got.unwrap(), "/a.png");
    }
}
