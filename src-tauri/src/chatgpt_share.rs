use reqwest::{redirect::Policy, Client, Url};
use std::time::Duration;

const MAX_SHARE_HTML_BYTES: usize = 8 * 1024 * 1024;

#[tauri::command]
pub async fn fetch_chatgpt_share_html(url: String) -> Result<String, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "ChatGPT 分享链接格式不正确".to_string())?;
    let is_allowed = parsed.scheme() == "https"
        && parsed.host_str() == Some("chatgpt.com")
        && parsed.path().starts_with("/share/");

    if !is_allowed {
        return Err("只允许读取 https://chatgpt.com/share/... 公开分享链接".to_string());
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .redirect(Policy::limited(5))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
        )
        .build()
        .map_err(|error| format!("无法初始化对话读取器: {error}"))?;

    let response = client
        .get(parsed)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|error| format!("无法读取 ChatGPT 分享页: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "ChatGPT 分享页读取失败（HTTP {}）",
            status.as_u16()
        ));
    }

    if response.content_length().unwrap_or(0) > MAX_SHARE_HTML_BYTES as u64 {
        return Err("ChatGPT 分享页内容过大，已停止读取".to_string());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("无法读取 ChatGPT 分享页正文: {error}"))?;
    if bytes.len() > MAX_SHARE_HTML_BYTES {
        return Err("ChatGPT 分享页内容过大，已停止读取".to_string());
    }

    String::from_utf8(bytes.to_vec()).map_err(|_| "ChatGPT 分享页不是有效的 UTF-8 内容".to_string())
}
