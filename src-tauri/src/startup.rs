//! The main window starts hidden and is themed before it shows, so a forced Light or Dark
//! never shows a frame in the macOS appearance (Ruling 154).

use std::time::Duration;
use tauri::window::Color;
use tauri::{Manager, Runtime, Theme, WebviewWindow};

/// The page shows the window once it has painted; after this long Rust shows it anyway.
const SHOW_DEADLINE: Duration = Duration::from_secs(2);

/// `theme` from settings.json: Some for a forced choice, None for system or anything unreadable.
pub fn stored_theme(json: Option<&str>) -> Option<Theme> {
    let value: serde_json::Value = serde_json::from_str(json?).ok()?;
    match value.get("theme")?.as_str()? {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

/// The default palette background of each theme (DEFAULT_SETTINGS in settings.svelte.ts).
pub fn background_for(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(0x18, 0x18, 0x17, 0xFF),
        _ => Color(0xFF, 0xFF, 0xFF, 0xFF),
    }
}

pub fn prepare_main_window<R: Runtime>(window: &WebviewWindow<R>) {
    let json = window
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok());
    let forced = stored_theme(json.as_deref());
    if let Err(err) = window.set_theme(forced) {
        eprintln!("Could not set the window theme: {err}");
    }
    let resolved = forced
        .or_else(|| window.theme().ok())
        .unwrap_or(Theme::Light);
    if let Err(err) = window.set_background_color(Some(background_for(resolved))) {
        eprintln!("Could not set the window background: {err}");
    }
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_DEADLINE);
        if !window.is_visible().unwrap_or(true) {
            if let Err(err) = window.show() {
                eprintln!("Could not show the window: {err}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_follows_the_system() {
        assert_eq!(stored_theme(None), None);
    }

    #[test]
    fn a_damaged_file_follows_the_system() {
        assert_eq!(stored_theme(Some("{ not json")), None);
        assert_eq!(stored_theme(Some("[]")), None);
        assert_eq!(stored_theme(Some("")), None);
    }

    #[test]
    fn reads_each_theme_value() {
        assert_eq!(
            stored_theme(Some(r#"{"version":1,"theme":"light"}"#)),
            Some(Theme::Light)
        );
        assert_eq!(
            stored_theme(Some(r#"{"version":1,"theme":"dark"}"#)),
            Some(Theme::Dark)
        );
        assert_eq!(
            stored_theme(Some(r#"{"version":1,"theme":"system"}"#)),
            None
        );
    }

    #[test]
    fn an_unknown_or_missing_theme_follows_the_system() {
        assert_eq!(stored_theme(Some(r#"{"theme":"blue"}"#)), None);
        assert_eq!(stored_theme(Some(r#"{"theme":1}"#)), None);
        assert_eq!(stored_theme(Some(r#"{"version":1}"#)), None);
    }

    #[test]
    fn backgrounds_match_the_default_palettes() {
        let defaults = include_str!("../../src/lib/settings/settings.svelte.ts");
        for (theme, hex) in [(Theme::Light, "#FFFFFF"), (Theme::Dark, "#181817")] {
            assert!(
                defaults.contains(&format!("background: '{hex}'")),
                "{hex} not in DEFAULT_SETTINGS"
            );
            let Color(r, g, b, a) = background_for(theme);
            assert_eq!(format!("#{r:02X}{g:02X}{b:02X}"), hex);
            assert_eq!(a, 0xFF);
        }
    }

    #[test]
    fn the_main_window_starts_hidden() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["windows"][0]["visible"], false);
    }
}
