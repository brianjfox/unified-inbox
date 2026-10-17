fn main() {
    // The two commands the remote GUI may call get generated permissions
    // (`allow-platform`, `allow-open-deep-link`) that capabilities/remote.json
    // grants to the relay origin only.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["platform", "open_deep_link"])),
    )
    .expect("failed to run tauri-build");
}
