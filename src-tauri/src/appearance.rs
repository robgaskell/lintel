//! Themes each window's own title bar on macOS (Ruling 195). Tauri 2.12.7's `setTheme`
//! reaches tao 0.37.3's `set_ns_theme`, which sets only `NSApplication.appearance`; under
//! macOS Dark a Light chosen at run time left the title bars dark. `NSWindow.appearance`
//! on each window takes precedence over the app's.

/// What the page asks for: a forced theme, or the system's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
    Light,
    Dark,
    System,
}

/// Reads the value the page sends: "light", "dark", or null for the system.
pub fn parse_appearance(theme: Option<&str>) -> Result<Appearance, String> {
    match theme {
        None => Ok(Appearance::System),
        Some("light") => Ok(Appearance::Light),
        Some("dark") => Ok(Appearance::Dark),
        Some(other) => Err(format!(
            "Window theme must be light, dark or null; got {} characters",
            other.len()
        )),
    }
}

/// Sets the appearance of every window, as they all share one theme. The Settings window
/// has no app commands (Ruling 160), so the document windows set it too. Does nothing off
/// macOS, where `setTheme` already acts on the one window.
#[tauri::command]
pub fn set_window_appearance<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    theme: Option<String>,
) -> Result<(), String> {
    let appearance = parse_appearance(theme.as_deref())?;
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        for each in window.app_handle().webview_windows().into_values() {
            each.with_webview(move |webview| apply(webview.ns_window(), appearance))
                .map_err(|err| err.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, appearance);
    Ok(())
}

// Runs on the main thread, where with_webview calls back.
#[cfg(target_os = "macos")]
fn apply(ns_window: *mut std::ffi::c_void, appearance: Appearance) {
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
        NSWindow,
    };
    if ns_window.is_null() {
        return;
    }
    // SAFETY: tauri hands over the live NSWindow of this webview, on the main thread.
    let window = unsafe { &*(ns_window as *const NSWindow) };
    // SAFETY: AppKit's appearance name constants are always set.
    let name = unsafe {
        match appearance {
            Appearance::Light => Some(NSAppearanceNameAqua),
            Appearance::Dark => Some(NSAppearanceNameDarkAqua),
            Appearance::System => None,
        }
    };
    // Nil lets the window follow the app, and so the system.
    let named = name.and_then(NSAppearance::appearanceNamed);
    window.setAppearance(named.as_deref());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_light_dark_and_system() {
        assert_eq!(parse_appearance(Some("light")), Ok(Appearance::Light));
        assert_eq!(parse_appearance(Some("dark")), Ok(Appearance::Dark));
        assert_eq!(parse_appearance(None), Ok(Appearance::System));
    }

    #[test]
    fn refuses_anything_else_without_echoing_it() {
        let err = parse_appearance(Some("Light")).unwrap_err();
        assert!(err.contains("light, dark or null"));
        assert!(!err.contains("Light"));
        assert!(parse_appearance(Some("system")).is_err());
    }
}
