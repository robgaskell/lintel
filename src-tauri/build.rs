fn main() {
    // Listing the app's commands puts them under the capability system, so only the
    // windows granted them can call them; the Settings window is not (Ruling 160).
    let manifest = tauri_build::AppManifest::new().commands(&[
        "normalize_path",
        "paths_exist",
        "read_image_as_data_uri",
        "read_text_file",
        "write_text_file",
        "fetch_remote_image",
        "claim_path",
        "release_path",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
