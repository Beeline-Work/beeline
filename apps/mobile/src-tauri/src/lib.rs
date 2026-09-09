// The desktop shell hosts the same Expo web bundle the browser serves; every
// feature lives in TypeScript. Rust's whole job here is to open the window and
// register the plugins the JS side already depends on, so there are no custom
// commands to keep in sync with the client.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running Beeline desktop");
}
