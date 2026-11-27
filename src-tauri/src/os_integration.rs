//! The `lintel` command and "Make Lintel the default", run for Settings > Files.

use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Runtime};

use crate::files::write_atomic;

const OS_ACTION: &str = "lintel://os-action";
const OS_ACTION_RESULT: &str = "lintel://os-action-result";

const BUNDLE_ID: &str = "com.robgaskell.lintel";
// Ruling 247: Lintel replaces only a file that carries this in its first lines.
const MARKER: &str = "# Installed by Lintel";
#[cfg(unix)]
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(unix)]
const PATH_START: &str = "<<lintel-path>>";
#[cfg(unix)]
const PATH_END: &str = "<</lintel-path>>";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetOs {
    MacOs,
    Windows,
    Linux,
}

impl TargetOs {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// The command's path relative to home, and its text. Windows uses `exe_path`; Linux
/// uses `appimage`, or the .deb's program when there is none.
pub fn cli_script(os: TargetOs, exe_path: &Path, appimage: Option<&Path>) -> (PathBuf, String) {
    match os {
        TargetOs::MacOs => (
            PathBuf::from(".local/bin/lintel"),
            format!("#!/bin/sh\n{MARKER}\n{ABSOLUTE_ARGS}exec open -g -b {BUNDLE_ID} \"$@\"\n"),
        ),
        // `start` returns at once, so a first launch does not hold the terminal.
        TargetOs::Windows => (
            PathBuf::from("AppData/Local/Microsoft/WindowsApps/lintel.cmd"),
            windows_cmd(exe_path, &windows_profile_dirs()),
        ),
        TargetOs::Linux => (
            PathBuf::from(".local/bin/lintel"),
            format!(
                "#!/bin/sh\n{MARKER}\nprogram={}\n{LINUX_LAUNCH}",
                shell_quote(&linux_program(appimage))
            ),
        ),
    }
}

// Ruling 248: absolute paths, so a name starting with "-" is never read as an option.
const ABSOLUTE_ARGS: &str = r#"for arg do
  shift
  case $arg in
    /*) set -- "$@" "$arg" ;;
    *) set -- "$@" "$PWD/$arg" ;;
  esac
done
"#;

/// The profile folders a per-user install sits under, most specific first.
fn windows_profile_dirs() -> Vec<(&'static str, OsString)> {
    ["LOCALAPPDATA", "USERPROFILE"]
        .into_iter()
        .filter_map(|name| Some((name, std::env::var_os(name)?)))
        .collect()
}

// cmd.exe reads a .cmd in the console's code page, so a non-ASCII path breaks. A profile
// folder is named by its variable; any other path runs under code page 65001 (Ruling 252).
fn windows_cmd(exe_path: &Path, profile_dirs: &[(&str, OsString)]) -> String {
    let exe = exe_path.to_string_lossy();
    let in_profile = profile_dirs.iter().find_map(|(name, dir)| {
        let rest = strip_folder(&exe, &dir.to_string_lossy())?;
        Some(format!("%{name}%{}", rest.replace('%', "%%")))
    });
    let head = format!("@echo off\r\nrem {MARKER}\r\n");
    match in_profile {
        Some(path) if path.is_ascii() => format!("{head}start \"\" \"{path}\" %*\r\n"),
        in_profile => {
            let path = in_profile.unwrap_or_else(|| exe.replace('%', "%%"));
            format!(
                "{head}setlocal\r\n\
                 for /f \"tokens=2 delims=:.\" %%c in ('chcp') do set \"LINTEL_CP=%%c\"\r\n\
                 chcp 65001 >nul\r\n\
                 start \"\" \"{path}\" %*\r\n\
                 chcp %LINTEL_CP% >nul\r\n"
            )
        }
    }
}

/// The rest of `path` after the folder `dir`, from its separator on. Case is ignored for
/// ASCII letters only, which covers the drive and the usual folder names.
fn strip_folder<'a>(path: &'a str, dir: &str) -> Option<&'a str> {
    let dir = dir.trim_end_matches(['\\', '/']);
    let head = path.as_bytes().get(..dir.len())?;
    if dir.is_empty() || !head.eq_ignore_ascii_case(dir.as_bytes()) {
        return None;
    }
    let rest = path.get(dir.len()..)?;
    rest.starts_with(['\\', '/']).then_some(rest)
}

// Ruling 253: Lintel runs detached, so closing the terminal never takes it down.
const LINUX_LAUNCH: &str = r#"if [ ! -x "$program" ]; then
  echo "lintel: Lintel is not installed at $program" >&2
  exit 127
fi
if command -v setsid >/dev/null 2>&1; then
  exec setsid -f "$program" "$@" >/dev/null 2>&1
fi
nohup "$program" "$@" >/dev/null 2>&1 &
"#;

fn linux_program(appimage: Option<&Path>) -> PathBuf {
    appimage.map_or_else(|| PathBuf::from("/usr/bin/lintel"), Path::to_path_buf)
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

/// Installs the `lintel` command for this user and resolves to its path.
pub fn install_cli() -> Result<String, String> {
    let exe =
        std::env::current_exe().map_err(|e| format!("Could not find Lintel's own program: {e}"))?;
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let path = install_cli_in(&home()?, TargetOs::current(), &exe, appimage.as_deref())?;
    Ok(path.display().to_string())
}

/// The folder the command goes in for this user.
fn cli_folder(home: &Path, os: TargetOs) -> PathBuf {
    let (relative, _) = cli_script(os, Path::new(""), None);
    home.join(relative.parent().unwrap_or(Path::new("")))
}

fn install_cli_in(
    home: &Path,
    os: TargetOs,
    exe_path: &Path,
    appimage: Option<&Path>,
) -> Result<PathBuf, String> {
    let (relative, script) = cli_script(os, exe_path, appimage);
    let path = home.join(relative);
    let failed = |e: io::Error| format!("Could not install the lintel command: {e}");
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(failed)?;
    }
    if !may_replace(&path).map_err(failed)? {
        return Err(format!(
            "A different `lintel` already exists at {}, so it was not replaced.",
            path.display()
        ));
    }
    write_atomic(&path, script.as_bytes(), executable()).map_err(failed)?;
    Ok(path)
}

/// True when nothing is at `path` or it is a script Lintel wrote. A link is never
/// replaced, even one to Lintel's own script (Ruling 247).
fn may_replace(path: &Path) -> io::Result<bool> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e),
    };
    if !meta.is_file() {
        return Ok(false);
    }
    let mut head = Vec::new();
    fs::File::open(path)?.take(512).read_to_end(&mut head)?;
    let head = String::from_utf8_lossy(&head);
    Ok(head.lines().take(3).any(|line| line.contains(MARKER)))
}

#[cfg(unix)]
fn executable() -> Option<fs::Permissions> {
    use std::os::unix::fs::PermissionsExt;
    Some(fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn executable() -> Option<fs::Permissions> {
    None
}

fn home() -> Result<PathBuf, String> {
    // Debug builds only, so a manual check can install somewhere other than the real home.
    if cfg!(debug_assertions) {
        if let Some(home) = std::env::var_os("LINTEL_DEBUG_HOME") {
            return Ok(PathBuf::from(home));
        }
    }
    std::env::home_dir().ok_or_else(|| "Lintel could not find your home folder.".to_owned())
}

/// What to add after the installed path. `search_path` is None when it could not be read.
fn path_hint(dir: &Path, shown: &str, search_path: Option<&OsStr>) -> Option<String> {
    match search_path {
        Some(search) if std::env::split_paths(search).any(|entry| same_dir(&entry, dir)) => None,
        Some(_) => Some(format!("Add {shown} to your PATH.")),
        None => Some(format!(
            "If `lintel` is not found, add {shown} to your PATH."
        )),
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
            == b.to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .to_lowercase()
    } else {
        a == b
    }
}

/// `made_folder` is whether this install created the command's folder.
fn install_message(os: TargetOs, path: &str, hint: Option<String>, made_folder: bool) -> String {
    let mut message = format!("Installed the lintel command at {path}.");
    // Ruling 253: a Linux desktop session's PATH was set before the folder existed.
    let new_terminal = (os == TargetOs::Linux && made_folder)
        .then(|| "Open a new terminal (or log in again) to use it.".to_owned());
    for extra in [hint, new_terminal].into_iter().flatten() {
        message.push(' ');
        message.push_str(&extra);
    }
    message
}

/// The PATH a terminal gets. On macOS and Linux an app started from the desktop has a bare
/// PATH, so the login shell is asked (Ruling 246).
#[cfg(unix)]
fn user_search_path() -> Option<OsString> {
    login_shell_path(&std::env::var_os("SHELL")?, PROBE_TIMEOUT).map(OsString::from)
}

#[cfg(not(unix))]
fn user_search_path() -> Option<OsString> {
    std::env::var_os("PATH")
}

#[cfg(unix)]
fn login_shell_path(shell: &OsStr, timeout: Duration) -> Option<String> {
    use std::process::{Command, Stdio};
    // Interactive too, since zsh reads ~/.zshrc only then (Ruling 253).
    let command = format!("printf '{PATH_START}%s{PATH_END}' \"$PATH\"");
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &command])
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sent, received) = std::sync::mpsc::channel();
    // A thread, so a shell that never closes its output cannot hold up the timeout.
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = sent.send(stdout.read_to_end(&mut out).map(|_| out));
    });
    let output = received.recv_timeout(timeout).ok().and_then(Result::ok);
    let _ = child.kill();
    let _ = child.wait();
    let text = String::from_utf8_lossy(&output?).into_owned();
    // The markers set PATH apart from whatever rc files print.
    let start = text.rfind(PATH_START)? + PATH_START.len();
    let len = text[start..].find(PATH_END)?;
    let path = &text[start..start + len];
    (!path.is_empty()).then(|| path.to_owned())
}

/// Makes Lintel the default app for Markdown files. Windows apps may not do this
/// themselves, so there it opens the Default apps settings page.
#[cfg(target_os = "macos")]
pub fn make_default_handler() -> Result<(), String> {
    launch_services::make_default("net.daringfireball.markdown", BUNDLE_ID)
}

#[cfg(windows)]
pub fn make_default_handler() -> Result<(), String> {
    tauri_plugin_opener::open_url("ms-settings:defaultapps", None::<&str>)
        .map_err(|e| format!("Could not open the Default apps settings: {e}"))
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn make_default_handler() -> Result<(), String> {
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    write_desktop_entry_if_missing(&home()?, appimage.as_deref())?;
    let (program, args) = xdg_mime_default();
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("Could not run xdg-mime: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "xdg-mime could not make Lintel the default ({status})."
        ))
    }
}

#[cfg(target_os = "macos")]
mod launch_services {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    // core-foundation does not export these.
    const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;
    const K_LS_APPLICATION_NOT_FOUND_ERR: i32 = -10814;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            content_type: CFStringRef,
            role: u32,
            handler_bundle_id: CFStringRef,
        ) -> i32;
    }

    pub fn make_default(content_type: &str, bundle_id: &str) -> Result<(), String> {
        let content_type = CFString::new(content_type);
        let bundle_id = CFString::new(bundle_id);
        // SAFETY: both CFStrings outlive the call, which does not keep them.
        let status = unsafe {
            LSSetDefaultRoleHandlerForContentType(
                content_type.as_concrete_TypeRef(),
                K_LS_ROLES_ALL,
                bundle_id.as_concrete_TypeRef(),
            )
        };
        result(status)
    }

    pub fn result(status: i32) -> Result<(), String> {
        match status {
            0 => Ok(()),
            K_LS_APPLICATION_NOT_FOUND_ERR => Err("macOS does not know where Lintel is installed. Open Lintel from your Applications folder, then try again.".to_owned()),
            other => Err(format!("macOS could not make Lintel the default (error {other}).")),
        }
    }
}

#[cfg(any(test, not(any(target_os = "macos", windows))))]
fn xdg_mime_default() -> (&'static str, [&'static str; 3]) {
    ("xdg-mime", ["default", "lintel.desktop", "text/markdown"])
}

#[cfg(any(test, not(any(target_os = "macos", windows))))]
fn desktop_entry(program: &Path) -> String {
    format!(
        "[Desktop Entry]\n{MARKER}\nType=Application\nName=Lintel\nComment=A markdown reader and editor\nExec={} %F\nIcon=lintel\nTerminal=false\nCategories=Office;TextEditor;\nMimeType=text/markdown;text/x-markdown;\n",
        desktop_exec_arg(program)
    )
}

/// Quoted as the Desktop Entry spec asks: its string escapes apply first, so a literal
/// backslash inside quotes is written as four.
#[cfg(any(test, not(any(target_os = "macos", windows))))]
fn desktop_exec_arg(program: &Path) -> String {
    let text = program.to_string_lossy();
    if text
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c))
    {
        return text.into_owned();
    }
    let mut quoted = String::from("\"");
    for c in text.chars() {
        match c {
            '"' | '`' | '$' => {
                quoted.push_str(r"\\");
                quoted.push(c);
            }
            '\\' => quoted.push_str(r"\\\\"),
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(any(test, not(any(target_os = "macos", windows))))]
fn write_desktop_entry_if_missing(home: &Path, appimage: Option<&Path>) -> Result<(), String> {
    let path = home.join(".local/share/applications/lintel.desktop");
    let failed = |e: io::Error| format!("Could not write {}: {e}", path.display());
    match fs::symlink_metadata(&path) {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(failed(e)),
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(failed)?;
    }
    let entry = desktop_entry(&linux_program(appimage));
    write_atomic(&path, entry.as_bytes(), None).map_err(failed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OsAction {
    InstallCli,
    MakeDefault,
}

impl OsAction {
    fn named(name: &str) -> Option<Self> {
        match name {
            "install-cli" => Some(Self::InstallCli),
            "make-default" => Some(Self::MakeDefault),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OsActionRequest {
    action: String,
    request_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OsActionResult {
    request_id: String,
    ok: bool,
    message: String,
}

/// Settings has no app commands (Ruling 160), so its buttons ask by event (Ruling 245).
pub fn listen_for_os_actions<R: Runtime>(app: &AppHandle<R>) {
    answer_os_actions(app, run_action);
}

fn answer_os_actions<R, F>(app: &AppHandle<R>, run: F)
where
    R: Runtime,
    F: Fn(OsAction) -> Result<String, String> + Send + Sync + 'static,
{
    let run = Arc::new(run);
    let handle = app.clone();
    app.listen(OS_ACTION, move |event| {
        let Ok(request) = serde_json::from_str::<OsActionRequest>(event.payload()) else {
            eprintln!("Ignored a malformed {OS_ACTION}: {}", event.payload());
            return;
        };
        let (handle, run) = (handle.clone(), Arc::clone(&run));
        // The PATH probe can take 2 s, and the emitter waits for its listeners.
        std::thread::spawn(move || {
            let outcome = match OsAction::named(&request.action) {
                Some(action) => run(action),
                None => Err(format!(
                    "Lintel does not know the action {}.",
                    request.action
                )),
            };
            let (ok, message) = match outcome {
                Ok(message) => (true, message),
                Err(message) => (false, message),
            };
            let result = OsActionResult {
                request_id: request.request_id,
                ok,
                message,
            };
            if let Err(err) = handle.emit_to(crate::SETTINGS, OS_ACTION_RESULT, result) {
                eprintln!("Could not answer Settings: {err}");
            }
        });
    });
}

fn run_action(action: OsAction) -> Result<String, String> {
    match action {
        OsAction::InstallCli => {
            let made_folder = !cli_folder(&home()?, TargetOs::current()).is_dir();
            let path = install_cli()?;
            let dir = Path::new(&path).parent().unwrap_or(Path::new(""));
            let shown = match TargetOs::current() {
                TargetOs::Windows => dir.display().to_string(),
                _ => "~/.local/bin".to_owned(),
            };
            let hint = path_hint(dir, &shown, user_search_path().as_deref());
            Ok(install_message(
                TargetOs::current(),
                &path,
                hint,
                made_folder,
            ))
        }
        // Settings words the success itself (Default apps opens on Windows).
        OsAction::MakeDefault => make_default_handler().map(|()| String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// A fresh empty folder per test, so tests can run in parallel. Removed when dropped.
    struct TempDir(PathBuf);

    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir() -> TempDir {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lintel-os-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    #[test]
    fn test_folders_are_removed_afterwards() {
        let dir = temp_dir();
        fs::write(dir.join("file"), "x").unwrap();
        let path = dir.to_path_buf();
        drop(dir);
        assert!(!path.exists());
    }

    #[test]
    fn settings_and_rust_use_the_same_event_names() {
        assert_eq!(OS_ACTION, "lintel://os-action");
        assert_eq!(OS_ACTION_RESULT, "lintel://os-action-result");
        let ipc = include_str!("../../src/lib/ipc.ts");
        assert!(ipc.contains("export const OS_ACTION = 'lintel://os-action';"));
        assert!(ipc.contains("export const OS_ACTION_RESULT = 'lintel://os-action-result';"));
    }

    fn mac_script() -> String {
        cli_script(TargetOs::MacOs, Path::new("/x/lintel"), None).1
    }

    #[test]
    fn macos_script_opens_files_in_the_background_from_local_bin() {
        let (path, script) = cli_script(TargetOs::MacOs, Path::new("/x/lintel"), None);
        assert_eq!(path, PathBuf::from(".local/bin/lintel"));
        assert!(
            script.starts_with("#!/bin/sh\n# Installed by Lintel\n"),
            "{script}"
        );
        assert!(
            script.ends_with("\nexec open -g -b com.robgaskell.lintel \"$@\"\n"),
            "{script}"
        );
    }

    #[test]
    fn the_script_opens_this_app_by_its_bundle_id() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], BUNDLE_ID);
        assert!(mac_script().contains(&format!("-b {BUNDLE_ID} ")));
    }

    #[test]
    fn windows_script_is_a_cmd_in_windows_apps_calling_the_exe() {
        let exe = Path::new(r"C:\Program Files\Lintel\lintel.exe");
        let (path, script) = cli_script(TargetOs::Windows, exe, None);
        assert_eq!(
            path,
            PathBuf::from("AppData/Local/Microsoft/WindowsApps/lintel.cmd")
        );
        assert!(script.starts_with("@echo off\r\nrem # Installed by Lintel\r\n"));
        assert!(script.contains("start \"\" \"C:\\Program Files\\Lintel\\lintel.exe\" %*\r\n"));
    }

    fn profile_dirs() -> Vec<(&'static str, OsString)> {
        vec![
            ("LOCALAPPDATA", r"C:\Users\José\AppData\Local".into()),
            ("USERPROFILE", r"C:\Users\José".into()),
        ]
    }

    // cmd.exe reads a .cmd in the console's code page, not UTF-8 (Ruling 252).
    #[test]
    fn windows_script_names_a_per_user_exe_through_localappdata() {
        let exe = Path::new(r"C:\Users\José\AppData\Local\Lintel\lintel.exe");
        assert_eq!(
            windows_cmd(exe, &profile_dirs()),
            "@echo off\r\nrem # Installed by Lintel\r\nstart \"\" \"%LOCALAPPDATA%\\Lintel\\lintel.exe\" %*\r\n"
        );
    }

    #[test]
    fn windows_script_names_an_exe_elsewhere_in_the_profile_through_userprofile() {
        let exe = Path::new(r"c:\users\josé\Apps\Lintel\lintel.exe");
        let script = windows_cmd(exe, &profile_dirs());
        assert!(script.is_ascii(), "{script}");
        assert!(
            script.contains("start \"\" \"%USERPROFILE%\\Apps\\Lintel\\lintel.exe\" %*\r\n"),
            "{script}"
        );
    }

    #[test]
    fn windows_script_switches_to_utf8_for_an_exe_outside_the_profile() {
        let exe = Path::new(r"D:\Programme\Lintel – Éditeur\lintel.exe");
        assert_eq!(
            windows_cmd(exe, &profile_dirs()),
            concat!(
                "@echo off\r\n",
                "rem # Installed by Lintel\r\n",
                "setlocal\r\n",
                "for /f \"tokens=2 delims=:.\" %%c in ('chcp') do set \"LINTEL_CP=%%c\"\r\n",
                "chcp 65001 >nul\r\n",
                "start \"\" \"D:\\Programme\\Lintel – Éditeur\\lintel.exe\" %*\r\n",
                "chcp %LINTEL_CP% >nul\r\n",
            )
        );
    }

    #[test]
    fn windows_script_does_not_take_a_lookalike_folder_for_the_profile() {
        let exe = Path::new(r"C:\Users\JoséX\lintel.exe");
        let script = windows_cmd(exe, &profile_dirs());
        assert!(
            script.contains(r#""C:\Users\JoséX\lintel.exe" %*"#),
            "{script}"
        );
        assert!(script.contains("chcp 65001"), "{script}");
    }

    #[test]
    fn windows_script_keeps_a_percent_sign_in_the_exe_path() {
        let script = windows_cmd(Path::new(r"C:\100%\lintel.exe"), &profile_dirs());
        assert!(script.contains(r#""C:\100%%\lintel.exe" %*"#), "{script}");
        let script = windows_cmd(
            Path::new(r"C:\Users\José\AppData\Local\100%\lintel.exe"),
            &profile_dirs(),
        );
        assert!(
            script.contains(r#""%LOCALAPPDATA%\100%%\lintel.exe" %*"#),
            "{script}"
        );
    }

    #[test]
    fn linux_script_calls_the_appimage_when_given() {
        let appimage = Path::new("/home/me/Apps/Lintel 1.0.AppImage");
        let (path, script) = cli_script(
            TargetOs::Linux,
            Path::new("/tmp/.mount/lintel"),
            Some(appimage),
        );
        assert_eq!(path, PathBuf::from(".local/bin/lintel"));
        assert!(
            script.starts_with(
                "#!/bin/sh\n# Installed by Lintel\nprogram='/home/me/Apps/Lintel 1.0.AppImage'\n"
            ),
            "{script}"
        );
    }

    #[test]
    fn linux_script_calls_the_deb_program_otherwise() {
        let (_, script) = cli_script(TargetOs::Linux, Path::new("/usr/bin/lintel"), None);
        assert!(script.contains("\nprogram='/usr/bin/lintel'\n"), "{script}");
    }

    #[test]
    fn linux_script_quotes_a_quote_in_the_appimage_path() {
        let (_, script) = cli_script(
            TargetOs::Linux,
            Path::new("x"),
            Some(Path::new("/a/it's.AppImage")),
        );
        assert!(
            script.contains(r#"program='/a/it'\''s.AppImage'"#),
            "{script}"
        );
    }

    // Runs the Linux script against a stand-in Lintel that records its arguments.
    #[cfg(unix)]
    struct LinuxRun {
        dir: TempDir,
        program: PathBuf,
    }

    #[cfg(unix)]
    impl LinuxRun {
        fn new() -> Self {
            let dir = temp_dir();
            fs::create_dir_all(dir.join("bin")).unwrap();
            let program = dir.join("Lintel.AppImage");
            let record =
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LOG.tmp\"\n/bin/mv \"$LOG.tmp\" \"$LOG\"\n";
            write_program(&program, record);
            Self { dir, program }
        }

        fn run(&self, program: &Path, path: &str) -> std::process::Output {
            let script = self.dir.join("lintel");
            fs::write(
                &script,
                cli_script(TargetOs::Linux, Path::new("x"), Some(program)).1,
            )
            .unwrap();
            std::process::Command::new("/bin/sh")
                .arg(&script)
                .arg("a b.md")
                .env("PATH", path)
                .env("LOG", self.log())
                .output()
                .unwrap()
        }

        fn log(&self) -> PathBuf {
            self.dir.join("log")
        }

        fn wait_for_log(&self) -> String {
            let start = Instant::now();
            while !self.log().exists() && start.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(10));
            }
            fs::read_to_string(self.log()).unwrap_or_default()
        }
    }

    // Ruling 253: detached, so closing the terminal never takes Lintel with it.
    #[cfg(unix)]
    #[test]
    fn linux_script_starts_lintel_in_its_own_session_through_setsid() {
        let run = LinuxRun::new();
        let setsid = "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LOG\"\n";
        write_program(&run.dir.join("bin/setsid"), setsid);
        let path = format!("{}:/usr/bin:/bin", run.dir.join("bin").display());
        let output = run.run(&run.program, &path);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            fs::read_to_string(run.log()).unwrap(),
            format!("-f\n{}\na b.md\n", run.program.display())
        );
    }

    #[cfg(unix)]
    #[test]
    fn linux_script_falls_back_to_nohup_in_the_background() {
        let run = LinuxRun::new();
        // Only nohup on PATH, so the script cannot find setsid.
        let nohup = ["/usr/bin/nohup", "/bin/nohup"]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .unwrap();
        std::os::unix::fs::symlink(nohup, run.dir.join("bin/nohup")).unwrap();
        let output = run.run(&run.program, &run.dir.join("bin").display().to_string());
        assert!(output.status.success(), "{output:?}");
        assert!(
            output.stdout.is_empty() && output.stderr.is_empty(),
            "{output:?}"
        );
        assert_eq!(run.wait_for_log(), "a b.md\n");
    }

    #[cfg(unix)]
    #[test]
    fn linux_script_says_when_lintel_is_missing() {
        let run = LinuxRun::new();
        let missing = run.dir.join("Gone.AppImage");
        let output = run.run(&missing, "/usr/bin:/bin");
        assert_eq!(output.status.code(), Some(127));
        assert_eq!(
            String::from_utf8_lossy(&output.stderr),
            format!("lintel: Lintel is not installed at {}\n", missing.display())
        );
    }

    // A stand-in `open` records its arguments, so the test never reaches LaunchServices.
    #[cfg(unix)]
    #[test]
    fn macos_script_passes_absolute_paths_and_returns_open_s_status() {
        use std::process::Command;
        let dir = temp_dir();
        let bin = dir.join("bin");
        let work = dir.join("work");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&work).unwrap();
        let open = "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LOG\"\nexit 3\n";
        write_program(&bin.join("open"), open);
        let script = dir.join("lintel");
        fs::write(&script, mac_script()).unwrap();

        let status = Command::new("/bin/sh")
            .arg(&script)
            .args(["a.md", "-n.md", "/abs/b.md", "sub dir/c.md", "--"])
            .current_dir(&work)
            .env_remove("PWD")
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("LOG", dir.join("log"))
            .status()
            .unwrap();

        assert_eq!(status.code(), Some(3));
        let cwd = fs::canonicalize(&work).unwrap();
        let cwd = cwd.display();
        let expected = format!(
            "-g\n-b\ncom.robgaskell.lintel\n{cwd}/a.md\n{cwd}/-n.md\n/abs/b.md\n{cwd}/sub dir/c.md\n{cwd}/--\n"
        );
        assert_eq!(fs::read_to_string(dir.join("log")).unwrap(), expected);
    }

    fn install(home: &Path) -> Result<PathBuf, String> {
        install_cli_in(home, TargetOs::MacOs, Path::new("/x/lintel"), None)
    }

    #[test]
    fn cli_folder_is_where_install_puts_the_command() {
        let home = temp_dir();
        for os in [TargetOs::MacOs, TargetOs::Windows, TargetOs::Linux] {
            let path = install_cli_in(&home, os, Path::new("x"), None).unwrap();
            assert_eq!(
                Some(cli_folder(&home, os).as_path()),
                path.parent(),
                "{os:?}"
            );
        }
    }

    #[test]
    fn install_creates_the_folder_and_writes_the_script() {
        let home = temp_dir();
        let path = install(&home).unwrap();
        assert_eq!(path, home.join(".local/bin/lintel"));
        assert_eq!(fs::read_to_string(&path).unwrap(), mac_script());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
    }

    #[test]
    fn install_replaces_a_script_lintel_wrote_before() {
        let home = temp_dir();
        let path = home.join(".local/bin/lintel");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "#!/bin/sh\n# Installed by Lintel\nexec old \"$@\"\n").unwrap();
        install(&home).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), mac_script());
    }

    fn refusal(path: &Path) -> String {
        format!(
            "A different `lintel` already exists at {}, so it was not replaced.",
            path.display()
        )
    }

    #[test]
    fn install_leaves_a_different_lintel_alone() {
        let home = temp_dir();
        let path = home.join(".local/bin/lintel");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // The marker below the first lines does not count.
        let other = "#!/bin/sh\n# another tool\n\n\necho '# Installed by Lintel'\n";
        fs::write(&path, other).unwrap();
        assert_eq!(install(&home), Err(refusal(&path)));
        assert_eq!(fs::read_to_string(&path).unwrap(), other);
    }

    #[test]
    fn install_leaves_a_folder_named_lintel_alone() {
        let home = temp_dir();
        let path = home.join(".local/bin/lintel");
        fs::create_dir_all(&path).unwrap();
        assert_eq!(install(&home), Err(refusal(&path)));
        assert!(path.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn install_never_writes_through_a_symlink() {
        let home = temp_dir();
        let path = home.join(".local/bin/lintel");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Even a link to a script Lintel wrote stays as it is.
        let target = home.join("dev-lintel");
        let ours = "#!/bin/sh\n# Installed by Lintel\nexec dev \"$@\"\n";
        fs::write(&target, ours).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert_eq!(install(&home), Err(refusal(&path)));
        assert_eq!(fs::read_to_string(&target).unwrap(), ours);
        assert!(fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn install_reports_a_folder_it_cannot_make() {
        let home = temp_dir();
        fs::write(home.join(".local"), "a file where the folder goes").unwrap();
        let err = install(&home).unwrap_err();
        assert!(
            err.starts_with("Could not install the lintel command: "),
            "{err}"
        );
    }

    fn search_path(dirs: &[&str]) -> std::ffi::OsString {
        std::env::join_paths(dirs).unwrap()
    }

    #[test]
    fn no_path_hint_when_the_folder_is_on_path() {
        let dir = Path::new("/h/.local/bin");
        for dirs in [["/usr/bin", "/h/.local/bin"], ["/h/.local/bin/", "/bin"]] {
            let path = search_path(&dirs);
            assert_eq!(
                path_hint(dir, "~/.local/bin", Some(&path)),
                None,
                "{dirs:?}"
            );
        }
    }

    #[test]
    fn path_hint_when_the_folder_is_missing_from_path() {
        let path = search_path(&["/usr/bin", "/h/.local/binx"]);
        assert_eq!(
            path_hint(Path::new("/h/.local/bin"), "~/.local/bin", Some(&path)).as_deref(),
            Some("Add ~/.local/bin to your PATH.")
        );
    }

    #[test]
    fn hedged_path_hint_when_path_could_not_be_read() {
        assert_eq!(
            path_hint(Path::new("/h/.local/bin"), "~/.local/bin", None).as_deref(),
            Some("If `lintel` is not found, add ~/.local/bin to your PATH.")
        );
    }

    #[test]
    fn install_message_names_the_path_then_the_hint() {
        let hint = || Some("Add ~/.local/bin to your PATH.".to_owned());
        assert_eq!(
            install_message(TargetOs::MacOs, "/h/.local/bin/lintel", hint(), false),
            "Installed the lintel command at /h/.local/bin/lintel. Add ~/.local/bin to your PATH."
        );
        assert_eq!(
            install_message(TargetOs::MacOs, "/h/.local/bin/lintel", None, true),
            "Installed the lintel command at /h/.local/bin/lintel."
        );
    }

    // Ruling 253: the desktop session's PATH was set before the folder existed.
    #[test]
    fn linux_message_says_to_open_a_new_terminal_when_the_folder_is_new() {
        assert_eq!(
            install_message(TargetOs::Linux, "/h/.local/bin/lintel", None, true),
            "Installed the lintel command at /h/.local/bin/lintel. Open a new terminal (or log in again) to use it."
        );
        assert_eq!(
            install_message(TargetOs::Linux, "/h/.local/bin/lintel", None, false),
            "Installed the lintel command at /h/.local/bin/lintel."
        );
    }

    // The folder goes with the shell, so it lives as long as the test holds it.
    #[cfg(unix)]
    fn fake_shell(body: &str) -> (TempDir, PathBuf) {
        let dir = temp_dir();
        let shell = dir.join("shell");
        write_program(&shell, &format!("#!/bin/sh\n{body}\n"));
        (dir, shell)
    }

    // Written by a child: a write handle held here could leak into a process another test
    // is starting, and running the program would then fail with "Text file busy".
    #[cfg(unix)]
    fn write_program(path: &Path, text: &str) {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("/bin/sh")
            .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"])
            .arg(path)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
    }

    // Ruling 253: interactive too, since zsh reads ~/.zshrc only then.
    #[cfg(unix)]
    #[test]
    fn login_shell_path_asks_an_interactive_login_shell_with_a_dumb_terminal() {
        let (dir, shell) = fake_shell(
            "printf '%s|' \"$1\" \"$2\" \"$3\" \"$TERM\" > \"${0%/*}/asked\"\nPATH=/stub/bin:/usr/bin /bin/sh -c \"$4\"",
        );
        assert_eq!(
            login_shell_path(shell.as_os_str(), PROBE_TIMEOUT).as_deref(),
            Some("/stub/bin:/usr/bin")
        );
        assert_eq!(
            fs::read_to_string(dir.join("asked")).unwrap(),
            "-l|-i|-c|dumb|"
        );
    }

    // Like an rc file that greets, prints half a line and says goodbye on exit.
    #[cfg(unix)]
    #[test]
    fn login_shell_path_ignores_what_rc_files_print() {
        let (_dir, shell) = fake_shell(
            "echo 'Welcome back!'\nprintf 'no newline'\nPATH=/a:/b /bin/sh -c \"$4\"\necho\necho 'Logged out.'",
        );
        assert_eq!(
            login_shell_path(shell.as_os_str(), PROBE_TIMEOUT).as_deref(),
            Some("/a:/b")
        );
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_path_is_none_when_the_shell_prints_no_path() {
        let (_dir, shell) = fake_shell("echo 'nothing useful'");
        assert_eq!(login_shell_path(shell.as_os_str(), PROBE_TIMEOUT), None);
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_path_gives_up_on_a_slow_shell() {
        let (_dir, shell) = fake_shell("exec sleep 10");
        let start = Instant::now();
        assert_eq!(
            login_shell_path(shell.as_os_str(), Duration::from_millis(200)),
            None
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn login_shell_path_is_none_without_a_shell() {
        assert_eq!(
            login_shell_path(OsStr::new("/no/such/shell"), PROBE_TIMEOUT),
            None
        );
    }

    #[test]
    fn linux_make_default_runs_xdg_mime_for_markdown() {
        assert_eq!(
            xdg_mime_default(),
            ("xdg-mime", ["default", "lintel.desktop", "text/markdown"])
        );
    }

    #[test]
    fn linux_desktop_entry_launches_lintel_with_its_files() {
        let entry = desktop_entry(Path::new("/usr/bin/lintel"));
        assert!(entry.starts_with("[Desktop Entry]\n"), "{entry}");
        for line in [
            "Type=Application",
            "Name=Lintel",
            "Exec=/usr/bin/lintel %F",
            "MimeType=text/markdown;text/x-markdown;",
        ] {
            assert!(entry.lines().any(|l| l == line), "{line} in {entry}");
        }
    }

    #[test]
    fn linux_desktop_entry_quotes_an_appimage_path() {
        let entry = desktop_entry(Path::new("/home/me/My Apps/Lintel 100%.AppImage"));
        assert!(
            entry
                .lines()
                .any(|l| l == r#"Exec="/home/me/My Apps/Lintel 100%%.AppImage" %F"#),
            "{entry}"
        );
        let entry = desktop_entry(Path::new(r#"/a/$b"c\d"#));
        assert!(
            entry.lines().any(|l| l == r#"Exec="/a/\\$b\\"c\\\\d" %F"#),
            "{entry}"
        );
    }

    #[test]
    fn linux_writes_a_desktop_entry_only_when_missing() {
        let home = temp_dir();
        let appimage = Path::new("/home/me/Lintel.AppImage");
        write_desktop_entry_if_missing(&home, Some(appimage)).unwrap();
        let path = home.join(".local/share/applications/lintel.desktop");
        assert_eq!(fs::read_to_string(&path).unwrap(), desktop_entry(appimage));

        fs::write(&path, "[Desktop Entry]\nExec=mine\n").unwrap();
        write_desktop_entry_if_missing(&home, Some(appimage)).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "[Desktop Entry]\nExec=mine\n"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_services_errors_say_what_went_wrong() {
        assert_eq!(launch_services::result(0), Ok(()));
        assert_eq!(
            launch_services::result(-10814),
            Err("macOS does not know where Lintel is installed. Open Lintel from your Applications folder, then try again.".into())
        );
        assert_eq!(
            launch_services::result(-50),
            Err("macOS could not make Lintel the default (error -50).".into())
        );
    }

    mod events {
        use super::*;
        use tauri::test::{mock_builder, mock_context, noop_assets};
        use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

        type Heard = Arc<Mutex<Vec<serde_json::Value>>>;

        fn settings_app() -> (tauri::App<tauri::test::MockRuntime>, Heard) {
            let app = mock_builder().build(mock_context(noop_assets())).unwrap();
            let settings = WebviewWindowBuilder::new(&app, crate::SETTINGS, WebviewUrl::default())
                .build()
                .unwrap();
            let heard = Heard::default();
            let log = Arc::clone(&heard);
            settings.listen(OS_ACTION_RESULT, move |e| {
                log.lock()
                    .unwrap()
                    .push(serde_json::from_str(e.payload()).unwrap())
            });
            (app, heard)
        }

        fn wait_for(heard: &Heard, count: usize) -> Vec<serde_json::Value> {
            let start = Instant::now();
            while heard.lock().unwrap().len() < count && start.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(10));
            }
            let mut answers = heard.lock().unwrap().clone();
            answers.sort_by_key(|a| a["requestId"].as_str().unwrap_or_default().to_owned());
            answers
        }

        #[test]
        fn settings_hears_each_action_s_outcome() {
            let (app, heard) = settings_app();
            answer_os_actions(app.handle(), |action| match action {
                OsAction::InstallCli => Ok("Installed.".into()),
                OsAction::MakeDefault => Err("Refused.".into()),
            });
            let ask = |action: &str, id: &str| {
                let request = serde_json::json!({ "action": action, "requestId": id });
                app.emit(OS_ACTION, request).unwrap();
            };
            ask("install-cli", "r1");
            ask("make-default", "r2");
            ask("format-disk", "r3");

            assert_eq!(
                wait_for(&heard, 3),
                [
                    serde_json::json!({ "requestId": "r1", "ok": true, "message": "Installed." }),
                    serde_json::json!({ "requestId": "r2", "ok": false, "message": "Refused." }),
                    serde_json::json!({ "requestId": "r3", "ok": false, "message": "Lintel does not know the action format-disk." }),
                ]
            );
        }

        // Setup's own listener answers too; an unknown action keeps the test off this Mac.
        #[test]
        fn setup_listens_for_settings_actions() {
            let (app, heard) = settings_app();
            app.manage(std::sync::Mutex::new(
                crate::open_queue::OpenQueue::default(),
            ));
            crate::setup_app(&app, Vec::<String>::new(), None);
            let request = serde_json::json!({ "action": "nothing", "requestId": "s1" });
            app.emit(OS_ACTION, request).unwrap();
            assert_eq!(
                wait_for(&heard, 1),
                [
                    serde_json::json!({ "requestId": "s1", "ok": false, "message": "Lintel does not know the action nothing." })
                ]
            );
        }
    }
}
