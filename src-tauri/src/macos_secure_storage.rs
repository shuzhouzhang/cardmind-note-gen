use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use security_framework_sys::base::errSecItemNotFound;

const SERVICE: &str = "com.codexu.NoteGen.server-sync";

#[tauri::command]
pub async fn set_macos_secure_value(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_generic_password(SERVICE, &key, value.as_bytes()).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_macos_secure_value(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match get_generic_password(SERVICE, &key) {
        Ok(value) => String::from_utf8(value).map(Some).map_err(|error| error.to_string()),
        Err(error) if error.code() == errSecItemNotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_macos_secure_value(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match delete_generic_password(SERVICE, &key) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == errSecItemNotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    })
    .await
    .map_err(|error| error.to_string())?
}
