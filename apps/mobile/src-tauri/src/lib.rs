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

#[cfg(target_os = "linux")]
fn register_linux_deep_links(app: &tauri::AppHandle) -> Result<(), String> {
    use std::process::Command;
    use tauri::Manager;
    use tauri_plugin_deep_link::DeepLinkExt;

    if app.deep_link().register_all().is_ok() {
        return Ok(());
    }

    // The plugin writes the handler before refreshing the desktop database.
    // Minimal AppImage hosts often omit `update-desktop-database`, but
    // `xdg-mime` can still install that already-written handler directly.
    let bin = std::env::current_exe().map_err(|error| error.to_string())?;
    let file_name = format!(
        "{}-handler.desktop",
        bin.file_name()
            .ok_or_else(|| "desktop executable has no file name".to_string())?
            .to_string_lossy()
    );
    let handler = app
        .path()
        .data_dir()
        .map_err(|error| error.to_string())?
        .join("applications")
        .join(&file_name);
    if !handler.is_file() {
        return Err("the desktop deep-link handler could not be written".to_string());
    }
    let status = Command::new("xdg-mime")
        .args(["default", &file_name, "x-scheme-handler/beeline"])
        .status()
        .map_err(|error| format!("could not run xdg-mime: {error}"))?;
    if !status.success() {
        return Err(format!("xdg-mime exited with {status}"));
    }
    Ok(())
}

// The shell hosts the Expo web bundle but owns the few native boundaries that
// cannot safely degrade to browser APIs, including session credential custody.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // The deep-link feature forwards a matching URL before this callback.
        // Bring the existing window forward too: delivery is not useful when
        // its visible result stays hidden behind the invoking application.
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            {
                // AppImages have no installer to register their desktop file.
                // Installed packages already carry their association; direct
                // AppImages register on launch, including minimal hosts that
                // have xdg-mime but omit update-desktop-database.
                if let Err(error) = register_linux_deep_links(_app.handle()) {
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
