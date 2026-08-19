mod ai;
mod analytics;
#[cfg(target_os = "android")]
mod android_cloud_folder;
#[cfg(target_os = "android")]
mod android_ocr;
mod backup;
mod backup_manager;
mod cloud_folder_sync;
mod database_recovery;
mod device;
mod document_parser;
mod fonts;
#[cfg(target_os = "ios")]
mod ios_ocr;
mod mcp;
mod mcp_runtime;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod microsoft_oauth;
mod mobile_system_bars;
mod notion_import;
mod ocr_packages;
mod printing;
mod remote_skills;
mod self_hosted_crypto;
mod self_hosted_files;
mod self_hosted_security;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod skill_runtime;
mod skills;
mod storefront;
mod system_trash;

use ai::{
    ai_binary_request, ai_chat_completion_stream, ai_json_request, ai_multipart_request,
    cancel_ai_request, AiRequestManager,
};
use backup::{export_app_data, import_app_data, import_app_data_from_file};
use backup_manager::{create_managed_backup, list_managed_backups, restore_managed_backup};
use cloud_folder_sync::{
    delete_cloud_folder_sync_file, get_icloud_sync_folder, list_cloud_folder_sync_files,
    migrate_workspace_to_cloud_folder, read_cloud_folder_sync_file, test_cloud_folder_sync,
    write_cloud_folder_sync_file,
};
use device::get_device_id;
use fonts::list_system_fonts;
use mcp::{
    send_mcp_message, send_mcp_notification, start_mcp_stdio_server, stop_mcp_server,
    McpServerManager,
};
use mcp_runtime::{
    cancel_mcp_runtime_install, inspect_mcp_runtime, install_mcp_runtime, RuntimeInstallManager,
};
use notion_import::import_notion_zip;
use ocr_packages::{list_ocr_providers, run_ocr_provider};
use remote_skills::{
    cancel_remote_skill_download, inspect_remote_skill, install_remote_skill, search_remote_skills,
    RemoteSkillManager,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use skill_runtime::{
    cancel_skill_script, inspect_skill_python, install_skill_python_dependencies, run_skill_script,
    SkillProcessManager,
};
use skills::{
    import_skill, import_skill_zip, install_skill_package, uninstall_skill, validate_skill_package,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(McpServerManager::new())
        .manage(RuntimeInstallManager::new())
        .manage(AiRequestManager::new())
        .manage(RemoteSkillManager::default());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.manage(SkillProcessManager::default());

    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_cloud_folder::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_ocr::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(mobile_system_bars::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(ios_ocr::init());

    builder
        .invoke_handler(tauri::generate_handler![
            start_mcp_stdio_server,
            stop_mcp_server,
            send_mcp_message,
            send_mcp_notification,
            inspect_mcp_runtime,
            install_mcp_runtime,
            cancel_mcp_runtime_install,
            get_device_id,
            document_parser::parse_document,
            list_system_fonts,
            analytics::track_analytics_event,
            export_app_data,
            import_app_data,
            import_app_data_from_file,
            create_managed_backup,
            list_managed_backups,
            restore_managed_backup,
            get_icloud_sync_folder,
            test_cloud_folder_sync,
            write_cloud_folder_sync_file,
            read_cloud_folder_sync_file,
            delete_cloud_folder_sync_file,
            list_cloud_folder_sync_files,
            migrate_workspace_to_cloud_folder,
            database_recovery::delete_local_database,
            import_skill,
            import_skill_zip,
            import_notion_zip,
            validate_skill_package,
            install_skill_package,
            uninstall_skill,
            search_remote_skills,
            inspect_remote_skill,
            install_remote_skill,
            cancel_remote_skill_download,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            run_skill_script,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            cancel_skill_script,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            inspect_skill_python,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            install_skill_python_dependencies,
            ai_json_request,
            ai_binary_request,
            ai_multipart_request,
            ai_chat_completion_stream,
            cancel_ai_request,
            list_ocr_providers,
            run_ocr_provider,
            #[cfg(target_os = "ios")]
            ios_ocr::pick_ios_sync_folder,
            #[cfg(target_os = "ios")]
            ios_ocr::restore_ios_sync_folder,
            #[cfg(target_os = "ios")]
            ios_ocr::release_ios_sync_folder,
            #[cfg(target_os = "ios")]
            ios_ocr::set_ios_secure_value,
            #[cfg(target_os = "ios")]
            ios_ocr::get_ios_secure_value,
            #[cfg(target_os = "ios")]
            ios_ocr::delete_ios_secure_value,
            #[cfg(target_os = "android")]
            android_cloud_folder::set_android_secure_value,
            #[cfg(target_os = "android")]
            android_cloud_folder::get_android_secure_value,
            #[cfg(target_os = "android")]
            android_cloud_folder::delete_android_secure_value,
            #[cfg(any(target_os = "android", target_os = "ios"))]
            microsoft_oauth::microsoft_oauth_request,
            #[cfg(target_os = "android")]
            android_cloud_folder::pick_android_sync_folder,
            #[cfg(target_os = "android")]
            android_cloud_folder::release_android_sync_folder,
            #[cfg(target_os = "android")]
            android_cloud_folder::test_android_cloud_folder,
            #[cfg(target_os = "android")]
            android_cloud_folder::write_android_cloud_folder_file,
            #[cfg(target_os = "android")]
            android_cloud_folder::read_android_cloud_folder_file,
            #[cfg(target_os = "android")]
            android_cloud_folder::delete_android_cloud_folder_file,
            #[cfg(target_os = "android")]
            android_cloud_folder::list_android_cloud_folder_files,
            storefront::get_app_storefront_country_code,
            printing::print_webview,
            mobile_system_bars::set_mobile_system_bars,
            system_trash::move_paths_to_trash,
            self_hosted_crypto::self_hosted_generate_workspace_key,
            self_hosted_crypto::self_hosted_generate_device_key_pair,
            self_hosted_crypto::self_hosted_encrypt,
            self_hosted_crypto::self_hosted_encrypt_bytes,
            self_hosted_crypto::self_hosted_decrypt,
            self_hosted_crypto::self_hosted_decrypt_packed,
            self_hosted_crypto::self_hosted_decrypt_packed_bytes,
            self_hosted_crypto::self_hosted_sha256,
            self_hosted_crypto::self_hosted_derive_argon2id_key,
            self_hosted_crypto::self_hosted_wrap_workspace_key,
            self_hosted_crypto::self_hosted_unwrap_workspace_key,
            self_hosted_security::self_hosted_secure_set,
            self_hosted_security::self_hosted_secure_get,
            self_hosted_security::self_hosted_secure_delete,
            self_hosted_files::self_hosted_portable_path,
            self_hosted_files::self_hosted_import_object_id,
            self_hosted_files::self_hosted_atomic_write,
            self_hosted_files::self_hosted_delete_file,
            self_hosted_files::self_hosted_create_directory,
            self_hosted_files::self_hosted_delete_directory,
            self_hosted_files::self_hosted_move_path,
            self_hosted_files::self_hosted_pending_file_journal,
            self_hosted_files::self_hosted_recover_file_journal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
