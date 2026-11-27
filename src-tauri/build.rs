fn main() {
    // Listing the app's commands puts them under the capability system, so only the
    // windows granted them can call them. Settings gets update_settings only (Rulings 160, 271).
    let manifest = tauri_build::AppManifest::new().commands(&[
        "normalize_path",
        "paths_exist",
        "read_image_as_data_uri",
        "read_text_file",
        "write_text_file",
        "write_binary_file",
        "fetch_remote_image",
        "claim_path",
        "release_path",
        "transfer_path",
        "complete_handoff",
        "cancel_handoff",
        "handoff_status",
        "set_window_appearance",
        "frontend_ready",
        "watch_path",
        "unwatch_path",
        "find_lint_config",
        "copy_notices",
        "update_settings",
        "update_state",
        "install_update",
    ]);
    let mut attributes = tauri_build::Attributes::new().app_manifest(manifest);
    if is_windows_msvc() {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_windows_manifest_everywhere();
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

fn is_windows_msvc() -> bool {
    let var = |name| std::env::var(name).unwrap_or_default();
    var("CARGO_CFG_TARGET_OS") == "windows" && var("CARGO_CFG_TARGET_ENV") == "msvc"
}

/// tauri-build links its manifest into binaries only. Without the Common Controls v6
/// dependency it declares, a test binary dies at load with STATUS_ENTRYPOINT_NOT_FOUND.
/// The linker embeds it in every target instead, as tauri's own build.rs does for its tests.
fn embed_windows_manifest_everywhere() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", path.display());
    // Keeps the app's manifest as tauri-build wrote it, with no added UAC section.
    println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
}
