//! The main window starts hidden and is themed before it shows, so a forced Light or Dark
//! never shows a frame in the macOS appearance (Ruling 154), nor a custom background a
//! frame of the default one (Ruling 170).

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

/// The resolved theme's palette background from settings.json, read as loadSettings
/// would: version 1 with both palettes whole and every colour #RRGGBB, else the default
/// (Ruling 170). The window then starts in the colour the page will paint.
pub fn stored_background(theme: Theme, json: Option<&str>) -> Color {
    stored_palette_background(theme, json).unwrap_or_else(|| background_for(theme))
}

fn stored_palette_background(theme: Theme, json: Option<&str>) -> Option<Color> {
    let value: serde_json::Value = serde_json::from_str(json?).ok()?;
    // JSON.parse reads 1.0 and 1e0 as 1, so loadSettings accepts them too.
    if value.get("version")?.as_f64()? != 1.0 {
        return None;
    }
    let palettes = value.get("palettes")?;
    let whole = |name: &str| {
        let palette = palettes.get(name)?;
        PALETTE_KEYS
            .iter()
            .all(|key| {
                palette
                    .get(key)
                    .and_then(|c| c.as_str())
                    .and_then(parse_hex)
                    .is_some()
            })
            .then_some(palette)
    };
    let (light, dark) = (whole("light")?, whole("dark")?);
    let palette = if theme == Theme::Dark { dark } else { light };
    parse_hex(palette.get("background")?.as_str()?)
}

const PALETTE_KEYS: [&str; 5] = ["background", "text", "accent", "link", "codeBackground"];

fn parse_hex(colour: &str) -> Option<Color> {
    let digits = colour.strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).ok();
    Some(Color(channel(0)?, channel(2)?, channel(4)?, 0xFF))
}

/// Lintel's tabs live in the page. With macOS window tabbing on, AppKit adds its own Show
/// Next/Previous Tab to the Window menu and claims Ctrl+Tab (Ruling 173).
#[cfg(target_os = "macos")]
pub fn disable_window_tabbing() {
    match objc2::MainThreadMarker::new() {
        Some(mtm) => objc2_app_kit::NSWindow::setAllowsAutomaticWindowTabbing(false, mtm),
        None => eprintln!("Could not turn off window tabbing: not on the main thread"),
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
    let background = stored_background(resolved, json.as_deref());
    if let Err(err) = window.set_background_color(Some(background)) {
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

    fn hex(color: Color) -> String {
        let Color(r, g, b, a) = color;
        assert_eq!(a, 0xFF);
        format!("#{r:02X}{g:02X}{b:02X}")
    }

    const PALETTE: &str = r##"{"background":"#7E8080","text":"#FFFFF8","accent":"#0F766E","link":"#0F766E","codeBackground":"#333333"}"##;

    fn with_palettes(light: &str, dark: &str) -> String {
        format!(r#"{{"version":1,"palettes":{{"light":{light},"dark":{dark}}}}}"#)
    }

    #[test]
    fn uses_the_stored_background_of_each_theme() {
        let dark = PALETTE.replace("#7E8080", "#0b1b33");
        let json = with_palettes(PALETTE, &dark);
        assert_eq!(hex(stored_background(Theme::Light, Some(&json))), "#7E8080");
        assert_eq!(hex(stored_background(Theme::Dark, Some(&json))), "#0B1B33");
    }

    #[test]
    fn an_invalid_background_gets_the_default() {
        for bad in [
            "\"red\"",
            "\"#7E808\"",
            "\"#7E8080FF\"",
            "\"#GGGGGG\"",
            "7",
            "null",
        ] {
            let broken = PALETTE.replace("\"#7E8080\"", bad);
            let json = with_palettes(&broken, &broken);
            assert_eq!(
                hex(stored_background(Theme::Light, Some(&json))),
                "#FFFFFF",
                "{bad}"
            );
            assert_eq!(
                hex(stored_background(Theme::Dark, Some(&json))),
                "#181817",
                "{bad}"
            );
        }
    }

    #[test]
    fn a_palette_the_settings_loader_would_reject_gets_the_default() {
        // loadSettings keeps the palettes only when both are whole and valid.
        let bad_link = PALETTE.replace("\"link\":\"#0F766E\"", "\"link\":\"blue\"");
        let json = with_palettes(PALETTE, &bad_link);
        assert_eq!(hex(stored_background(Theme::Light, Some(&json))), "#FFFFFF");
        let json = format!(r#"{{"version":1,"palettes":{{"light":{PALETTE}}}}}"#);
        assert_eq!(hex(stored_background(Theme::Light, Some(&json))), "#FFFFFF");
        let json = format!(r#"{{"version":2,"palettes":{{"light":{PALETTE},"dark":{PALETTE}}}}}"#);
        assert_eq!(hex(stored_background(Theme::Light, Some(&json))), "#FFFFFF");
    }

    #[test]
    fn reads_a_version_written_as_a_float_like_the_settings_loader() {
        for version in ["1.0", "1e0"] {
            let json = with_palettes(PALETTE, PALETTE)
                .replace(r#""version":1"#, &format!(r#""version":{version}"#));
            assert_eq!(
                hex(stored_background(Theme::Light, Some(&json))),
                "#7E8080",
                "{version}"
            );
        }
        let json = with_palettes(PALETTE, PALETTE).replace(r#""version":1"#, r#""version":1.5"#);
        assert_eq!(hex(stored_background(Theme::Light, Some(&json))), "#FFFFFF");
    }

    #[test]
    fn a_missing_file_or_palette_gets_the_default() {
        for json in [
            None,
            Some("{ not json"),
            Some(r#"{"version":1}"#),
            Some(r#"{"version":1,"palettes":[]}"#),
        ] {
            assert_eq!(
                hex(stored_background(Theme::Light, json)),
                "#FFFFFF",
                "{json:?}"
            );
            assert_eq!(
                hex(stored_background(Theme::Dark, json)),
                "#181817",
                "{json:?}"
            );
        }
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
