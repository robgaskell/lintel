//! Help > Third-Party Notices (Ruling 332). The bundled file is copied to the cache folder
//! as a read-only file and the copy is opened, so no viewer can save over it, and the app
//! bundle, whose signature covers the original, is never written.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::files;

/// The file name in the bundle's resources and in the cache folder.
const NOTICES: &str = "THIRD_PARTY_NOTICES.md";

/// Returns the path of a fresh read-only copy of the bundled notices.
#[tauri::command]
pub fn copy_notices<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let paths = app.path();
    let source = paths
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join(NOTICES);
    let cache = paths.app_cache_dir().map_err(|e| e.to_string())?;
    read_only_copy(&source, &cache)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| format!("Could not open the third-party notices: {e}"))
}

/// Copies `source` into `dir` under the same name, replacing an earlier copy, and makes the
/// copy read-only. `source` is only read.
pub(crate) fn read_only_copy(source: &Path, dir: &Path) -> io::Result<PathBuf> {
    let bytes = fs::read(source)?;
    fs::create_dir_all(dir)?;
    let target = dir.join(NOTICES);
    // Windows will not rename over a read-only file; Unix needs only the folder writable.
    #[cfg(windows)]
    if let Ok(meta) = fs::metadata(&target) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            fs::set_permissions(&target, perms)?;
        }
    }
    files::write_atomic(&target, &bytes, None)?;
    let mut perms = fs::metadata(&target)?.permissions();
    perms.set_readonly(true);
    fs::set_permissions(&target, perms)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lintel-notices-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn writable(path: &Path) {
        let mut perms = fs::metadata(path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(path, perms).unwrap();
    }

    #[test]
    fn copies_the_notices_read_only_and_leaves_the_source_alone() {
        let root = temp_dir("copy");
        let source = root.join("bundle").join(NOTICES);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "# Third-party notices\n").unwrap();
        let before = fs::metadata(&source).unwrap();

        let copy = read_only_copy(&source, &root.join("cache")).unwrap();

        assert_eq!(copy, root.join("cache").join(NOTICES));
        assert_ne!(copy, source);
        assert_eq!(
            fs::read_to_string(&copy).unwrap(),
            "# Third-party notices\n"
        );
        assert!(fs::metadata(&copy).unwrap().permissions().readonly());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&copy).unwrap().permissions().mode() & 0o222, 0);
        }
        // A viewer's save fails on the copy.
        assert!(fs::OpenOptions::new().write(true).open(&copy).is_err());
        let after = fs::metadata(&source).unwrap();
        assert_eq!(after.permissions(), before.permissions());
        assert_eq!(after.modified().unwrap(), before.modified().unwrap());
        assert_eq!(
            fs::read_to_string(&source).unwrap(),
            "# Third-party notices\n"
        );

        writable(&copy);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn replaces_an_earlier_read_only_copy() {
        let root = temp_dir("replace");
        let source = root.join(NOTICES);
        let cache = root.join("cache");
        fs::write(&source, "old").unwrap();
        read_only_copy(&source, &cache).unwrap();
        fs::write(&source, "new").unwrap();

        let copy = read_only_copy(&source, &cache).unwrap();

        assert_eq!(fs::read_to_string(&copy).unwrap(), "new");
        assert!(fs::metadata(&copy).unwrap().permissions().readonly());
        writable(&copy);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_source_is_an_error() {
        let root = temp_dir("missing");
        assert!(read_only_copy(&root.join(NOTICES), &root.join("cache")).is_err());
        assert!(!root.join("cache").join(NOTICES).exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
