// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod analytics;
#[cfg(target_os = "android")]
mod android_ocr;
mod app_setup;
mod backup;
mod chatgpt_share;
mod device;
mod file_open;
mod fonts;
mod fuzzy_search;
mod keywords;
mod mcp;
mod mcp_runtime;
mod ocr_packages;
mod screenshot;
mod skills;
mod tray;
mod window;

use ai::{
    ai_binary_request, ai_chat_completion_stream, ai_json_request, ai_multipart_request,
    cancel_ai_request, AiRequestManager,
};
use backup::{export_app_data, import_app_data, import_app_data_from_file};
use device::get_device_id;
use fonts::list_system_fonts;
use fuzzy_search::{fuzzy_search, fuzzy_search_parallel};
use keywords::rank_keywords;
use mcp::{send_mcp_message, start_mcp_stdio_server, stop_mcp_server, McpServerManager};
use mcp_runtime::{
    cancel_mcp_runtime_install, inspect_mcp_runtime, install_mcp_runtime, RuntimeInstallManager,
};
use ocr_packages::{list_ocr_providers, run_ocr_provider};
use screenshot::{cleanup_temp_screenshot_dir, screenshot};
use skills::import_skill_zip;
use tray::update_tray_record_toolbar_config;

fn main() {
    tauri::Builder::default()
        // 单实例插件必须最先加载，避免 Windows 文件关联二次启动时继续初始化托盘等资源。
        .plugin(tauri_plugin_single_instance::init(
            window::handle_single_instance,
        ))
        // 核心插件
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        // MCP 服务器管理器
        .manage(file_open::PendingOpenFiles::default())
        .manage(McpServerManager::new())
        .manage(RuntimeInstallManager::new())
        .manage(AiRequestManager::new())
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
            import_skill_zip,
            start_mcp_stdio_server,
            stop_mcp_server,
            send_mcp_message,
            inspect_mcp_runtime,
            install_mcp_runtime,
            cancel_mcp_runtime_install,
            get_device_id,
            list_system_fonts,
            analytics::track_analytics_event,
            ai_json_request,
            ai_binary_request,
            ai_multipart_request,
            ai_chat_completion_stream,
            cancel_ai_request,
            chatgpt_share::fetch_chatgpt_share_html,
            update_tray_record_toolbar_config,
            list_ocr_providers,
            run_ocr_provider,
            file_open::drain_pending_open_files,
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
