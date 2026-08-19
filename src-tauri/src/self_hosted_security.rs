use tauri::AppHandle;

const SERVICE: &str = "com.codexu.NoteGen.self-hosted-sync";

#[tauri::command]
pub async fn self_hosted_secure_set(
    app_handle: AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    let key = namespaced_key(&key)?;
    secure_set(app_handle, key, value).await
}

#[tauri::command]
pub async fn self_hosted_secure_get(
    app_handle: AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    let key = namespaced_key(&key)?;
    secure_get(app_handle, key).await
}

#[tauri::command]
pub async fn self_hosted_secure_delete(app_handle: AppHandle, key: String) -> Result<(), String> {
    let key = namespaced_key(&key)?;
    secure_delete(app_handle, key).await
}

fn namespaced_key(key: &str) -> Result<String, String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'-'))
    {
        return Err("Secure storage key is invalid".to_string());
    }
    Ok(format!("self-hosted-sync.{key}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn secure_set(_app_handle: AppHandle, key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        keyring::Entry::new(SERVICE, &key)
            .and_then(|entry| entry.set_password(&value))
            .map_err(|error| format!("Failed to save secure sync credential: {error}"))
    })
    .await
    .map_err(|error| format!("Secure storage task failed: {error}"))?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn secure_get(_app_handle: AppHandle, key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE, &key)
            .map_err(|error| format!("Failed to open secure sync credential: {error}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("Failed to read secure sync credential: {error}")),
        }
    })
    .await
    .map_err(|error| format!("Secure storage task failed: {error}"))?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn secure_delete(_app_handle: AppHandle, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE, &key)
            .map_err(|error| format!("Failed to open secure sync credential: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("Failed to delete secure sync credential: {error}")),
        }
    })
    .await
    .map_err(|error| format!("Secure storage task failed: {error}"))?
}

#[cfg(target_os = "ios")]
async fn secure_set(app_handle: AppHandle, key: String, value: String) -> Result<(), String> {
    crate::ios_ocr::set_ios_secure_value(app_handle, key, value).await
}

#[cfg(target_os = "ios")]
async fn secure_get(app_handle: AppHandle, key: String) -> Result<Option<String>, String> {
    crate::ios_ocr::get_ios_secure_value(app_handle, key).await
}

#[cfg(target_os = "ios")]
async fn secure_delete(app_handle: AppHandle, key: String) -> Result<(), String> {
    crate::ios_ocr::delete_ios_secure_value(app_handle, key).await
}

#[cfg(target_os = "android")]
async fn secure_set(app_handle: AppHandle, key: String, value: String) -> Result<(), String> {
    crate::android_cloud_folder::set_android_secure_value(app_handle, key, value).await
}

#[cfg(target_os = "android")]
async fn secure_get(app_handle: AppHandle, key: String) -> Result<Option<String>, String> {
    crate::android_cloud_folder::get_android_secure_value(app_handle, key).await
}

#[cfg(target_os = "android")]
async fn secure_delete(app_handle: AppHandle, key: String) -> Result<(), String> {
    crate::android_cloud_folder::delete_android_secure_value(app_handle, key).await
}
