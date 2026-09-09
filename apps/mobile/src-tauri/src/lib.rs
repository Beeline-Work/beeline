const SESSION_KEYS: [&str; 2] = ["buzzy.monolith.refresh.v1", "buzzy.monolith.identity.v1"];

fn credential(app: &tauri::AppHandle, key: &str) -> Result<keyring::Entry, String> {
    if !SESSION_KEYS.contains(&key) {
        return Err("unknown desktop credential key".to_string());
    }
    keyring::Entry::new(&app.config().identifier, key).map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_secure_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    match credential(&app, &key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn desktop_secure_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    credential(&app, &key)?
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_secure_remove(app: tauri::AppHandle, key: String) -> Result<(), String> {
    match credential(&app, &key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

// The shell hosts the Expo web bundle but owns the few native boundaries that
// cannot safely degrade to browser APIs, including session credential custody.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
        // The deep-link feature forwards a matching URL before this callback.
    }));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // AppImages have no installer to register their desktop file.
                // Minimal Linux images may omit update-desktop-database. The
                // shell must still launch; installed packages already carry
                // their protocol association and direct AppImage registration
                // can be retried on the next launch.
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("could not register desktop deep links: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_secure_get,
            desktop_secure_set,
            desktop_secure_remove
        ])
        .run(tauri::generate_context!())
        .expect("error while running Beeline desktop");
}
