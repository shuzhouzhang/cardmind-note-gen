# CardMind 架构与阅读指南

这份文档只描述当前能够从代码确认的实现，不把仍保留在仓库中的 NoteGen 模块都视为已启用功能。

## 1. 先确定仓库边界

当前机器上存在两层仓库：

```text
E:\CardMind              历史仓库、数据和工具目录
└─ note-gen\.git         当前 CardMind 应用仓库
```

运行、类型检查和 Git 操作都应从 `E:\CardMind\note-gen` 开始。正式 SQLite 数据库位于外层 `E:\CardMind\data\note.db`，不要用它执行测试。

## 2. 运行时总览

```text
                         ┌─ Markdown 工作区文件
用户 ─> React / Next.js ─┼─ store.json（设置和界面状态）
          │              └─ SQLite（业务数据）
          │
          ├─ AgentRuntime ─> OpenAI-compatible 模型
          │       │               │
          │       └─ 权限检查 <─ 工具调用
          │               │
          │               └─ 编辑器 / 笔记 / 标签 / 记录工具
          │
          └─ Tauri invoke ─> Rust
                              ├─ HTTP / AI 流式请求
                              ├─ 文件、托盘、截图和 OCR
                              └─ MCP 子进程与系统能力

Python CLI ─> 对话摄取 / 结构化知识应用 ─> 同一个 SQLite
```

应用主体是 TypeScript。Rust 不是独立业务后端，而是桌面原生能力层；Python 也不是常驻服务，而是知识摄取辅助入口。

## 3. 启动链路

1. `src-tauri/src/main.rs` 创建桌面窗口并注册 Tauri 插件和 Rust 命令。
2. `src-tauri/tauri.conf.json` 在开发环境运行 `pnpm dev`，访问 `localhost:3456`。
3. `src/app/page.tsx` 从 `store.json` 恢复上次页面，默认进入 `/core/main`。
4. `src/app/core/layout.tsx` 初始化设置、SQLite、快捷键和向量索引。
5. `src/app/core/main/page.tsx` 组合左侧记录、编辑器和聊天面板。

## 4. 数据所有权

### Markdown 工作区

笔记正文以真实文件保存。`src/stores/article.ts` 负责前端文件状态，`src/lib/workspace.ts` 负责默认工作区和自定义工作区的路径转换。

### store.json

通过 `@tauri-apps/plugin-store` 保存模型、主题、快捷键、上次页面等轻量设置。它不是业务数据库。

### SQLite

`src/db/index.ts` 加载 `E:/CardMind/data/note.db`，并初始化以下数据域：

- `chats`、`conversations`：AI 对话
- `marks`、`notes`、`tags`：记录和笔记元数据
- 向量索引与旧 Memory 数据
- `knowledge_cards`、`card_reviews`：用户可见的卡片和复习记录
- `cm_*`：结构化知识摄取、来源和关系数据

## 5. Agent 主链路

```text
chat-send.tsx
  ├─ 当前笔记
  ├─ 当前快速记录
  ├─ RAG 检索结果
  ├─ 关联文件
  └─ 当前选区
          ↓
AgentHandler
          ↓
AgentRuntime
  ├─ ContextManager
  ├─ PromptAssembler
  ├─ ToolRegistry
  ├─ PermissionEngine
  ├─ RecoveryManager
  └─ TraceRecorder
          ↓
模型 Function Calling，最多 15 轮
```

模型请求使用 OpenAI-compatible Chat Completions 协议。TypeScript 的 `tauri-client.ts` 把请求转成 Tauri command，再由 `src-tauri/src/ai.rs` 执行实际网络访问和流式回传。

当前活动工具集中在编辑器、笔记、文件夹、标签和快速记录。Memory、Skill、MCP 的定义仍在代码中，但 `tool-registry.ts` 在返回活动工具前过滤了这些类别。

## 6. 两条知识处理路径

这是当前最需要注意的边界。

### 路径 A：用户可见的卡片生成

```text
ChatGPT 对话 / 当前记录 / 当前笔记
        ↓
分块并逐块调用模型
        ↓
question / answer / tags / sourceSnippet
        ↓
用户预览和保存
        ↓
knowledge_cards / card_reviews
        ↓
卡片图谱和复习
```

主要文件：

- `src/app/core/cards/page.tsx`
- `src/stores/cards.ts`
- `src/db/cards.ts`
- `src/app/core/cards/card-knowledge-graph.tsx`

当前图谱根据卡片的结构标签、共享主题和顺序推导连线，不直接读取 `cm_knowledge_edges`。

### 路径 B：结构化知识摄取

```text
cardmind.py ingest
        ↓
保存原始对话和稳定消息 ID
        ↓
cardmind.py pending
        ↓
Agent 按 JSON Schema 生成知识结果
        ↓
cardmind.py apply
        ↓
cm_topics / cm_knowledge_points / cm_knowledge_sources / cm_knowledge_edges
```

Python 引擎负责摄取、去重、校验和应用结果，不会自行完成中间的 LLM 知识提取。活动知识点会镜像到旧的 `knowledge_cards` 表，但两条路径目前还不是同一个统一读写模型。

## 7. 当前代码分类

| 分类 | 当前判断 | 阅读建议 |
|---|---|---|
| `src/app/core/main` | 活动主线 | 优先阅读 |
| `src/app/core/cards` | CardMind 新主线 | 优先阅读 |
| `src/lib/agent` | 活动 Agent 核心 | 优先阅读 |
| `src/db/cards.ts`、`knowledge-engine.ts` | 活动但存在双模型 | 对照阅读 |
| `scripts/cardmind*` | 活动的无 UI 摄取入口 | 理解第二条知识路径 |
| `src/lib/mcp`、`src/lib/skills`、`src/db/memories.ts` | 底层代码保留，Agent 当前未注册 | 暂时跳过 |
| 移动端、同步、模板、音频相关目录 | NoteGen 遗留或已从 UI 移除 | 暂时跳过 |

## 8. 推荐研究顺序

第一轮只回答“应用怎么跑”：

1. `src-tauri/tauri.conf.json`
2. `src-tauri/src/main.rs`
3. `src/app/page.tsx`
4. `src/app/core/layout.tsx`
5. `src/app/core/main/page.tsx`

第二轮只回答“Agent 怎么工作”：

1. `src/app/core/main/chat/chat-send.tsx`
2. `src/lib/agent/agent-handler.ts`
3. `src/lib/agent/runtime.ts`
4. `src/lib/agent/tool-registry.ts`
5. `src/lib/agent/permission-engine.ts`

第三轮只回答“知识怎么形成”：

1. `src/app/core/cards/page.tsx`
2. `src/stores/cards.ts`
3. `src/db/cards.ts`
4. `scripts/cardmind.py`
5. `scripts/cardmind_engine.py`
6. `src/db/knowledge-engine.ts`

## 9. 后续清理原则

在真正删除旧代码之前，应先完成：

1. 为每个候选目录检查 import、路由、Tauri command 和配置引用。
2. 确定 `knowledge_cards` 与 `cm_knowledge_points` 谁是知识主数据。
3. 确定 Windows 桌面是否为唯一目标，再处理移动端和 `lib.rs`。
4. 确认同步、MCP、Skill、Memory 是否永久放弃，而不是暂时隐藏。
5. 每个小批次运行 `pnpm check`，避免一次删除大量代码后无法定位回归。
