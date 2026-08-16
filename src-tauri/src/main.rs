// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod analytics;
#[cfg(target_os = "android")]
mod android_ocr;
mod app_setup;
mod backup;
mod backup_manager;
mod cloud_folder_sync;
mod database_recovery;
mod device;
mod document_parser;
mod file_open;
mod fonts;
mod fuzzy_search;
mod keywords;
#[cfg(target_os = "macos")]
mod macos_secure_storage;
mod mcp;
mod mcp_runtime;
mod notion_import;
mod ocr_packages;
mod printing;
mod remote_skills;
mod screenshot;
mod skill_runtime;
mod skills;
mod storefront;
mod system_trash;
mod sync_atomic;
mod tray;
mod web_clipper;
mod window;

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
use fuzzy_search::{fuzzy_search, fuzzy_search_parallel};
use keywords::rank_keywords;
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
use screenshot::{cleanup_temp_screenshot_dir, screenshot};
use skill_runtime::{
    cancel_skill_script, inspect_skill_python, install_skill_python_dependencies, run_skill_script,
    SkillProcessManager,
};
use skills::{
    import_skill, import_skill_zip, install_skill_package, uninstall_skill, validate_skill_package,
};
use tray::update_tray_record_toolbar_config;
use web_clipper::{
    approve_web_clipper_pairing, get_web_clipper_status, list_web_clipper_connections,
    reject_web_clipper_pairing, resolve_web_clipper_request, revoke_web_clipper_connection,
    set_web_clipper_enabled, set_web_clipper_ready, WebClipperState,
};

fn main() {
    tauri::Builder::default()
        // 单实例插件必须最先加载，避免 Windows 文件关联二次启动时继续初始化托盘等资源。
        .plugin(tauri_plugin_single_instance::init(
            window::handle_single_instance,
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        // 核心插件
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        // MCP 服务器管理器
        .manage(file_open::PendingOpenFiles::default())
        .manage(McpServerManager::new())
        .manage(RuntimeInstallManager::new())
        .manage(AiRequestManager::new())
        .manage(sync_atomic::SyncAtomicDatabase::default())
        .manage(SkillProcessManager::default())
        .manage(RemoteSkillManager::default())
        .manage(WebClipperState::new())
        // 系统级插件
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        // UI 相关插件
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 功能插件
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 注册命令处理器
        .invoke_handler(tauri::generate_handler![
            screenshot,
            fuzzy_search,
            fuzzy_search_parallel,
            rank_keywords,
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
            run_skill_script,
            cancel_skill_script,
            inspect_skill_python,
            install_skill_python_dependencies,
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
            ai_json_request,
            ai_binary_request,
            ai_multipart_request,
            ai_chat_completion_stream,
            cancel_ai_request,
            update_tray_record_toolbar_config,
            list_ocr_providers,
            run_ocr_provider,
            storefront::get_app_storefront_country_code,
            printing::print_webview,
            file_open::drain_pending_open_files,
            system_trash::move_paths_to_trash,
            sync_atomic::apply_sync_atomic_batch,
            #[cfg(target_os = "macos")]
            macos_secure_storage::set_macos_secure_value,
            #[cfg(target_os = "macos")]
            macos_secure_storage::get_macos_secure_value,
            #[cfg(target_os = "macos")]
            macos_secure_storage::delete_macos_secure_value,
            approve_web_clipper_pairing,
            reject_web_clipper_pairing,
            get_web_clipper_status,
            list_web_clipper_connections,
            revoke_web_clipper_connection,
            set_web_clipper_enabled,
            set_web_clipper_ready,
            resolve_web_clipper_request,
        ])
        // 应用设置 - 在所有插件和命令注册后
        .setup(app_setup::setup_app)
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                window::handle_macos_reopen(&app_handle, has_visible_windows);
            }
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            tauri::RunEvent::Opened { urls } => {
                file_open::handle_opened_urls(&app_handle, urls);
            }
            tauri::RunEvent::Exit => {
                cleanup_temp_screenshot_dir(&app_handle);
            }
            _ => {}
        });
}
