# C++ / Linux 辅助版（证据生成稿）

- 基于开源 NoteGen（GPL-3.0）二次开发桌面 Agent 执行链，将模型流、审批和工具调用收口为带终止原因的可取消状态机，补齐工具超时、停止传播和 `effect_unknown` 边界。
- 在 Tauri/Rust 命令面移除 v1 未启用的 MCP/runtime-installer 注册，收紧 CSP 与 Markdown 渲染边界，同时保留既有本机用户配置而不写入默认凭据。
- 以 Fake Model、内存工具目录和 Record/Replay 验证 10/10 个离线场景、5/5 项守卫断言，真实笔记/SQLite/Tauri 副作用为 0；未将离线回放包装成生产压测。
