// Entry point shared by the desktop binary (`main.rs`) and the mobile
// entry-point macro (`tauri::mobile_entry_point`). The frontend is the
// existing Vue SPA + WASM engine; this crate is purely the Tauri shell.
// No fs/dialog plugins are wired — the app is fully self-contained in
// the webview (IndexedDB for persistence, fetch for sync).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
