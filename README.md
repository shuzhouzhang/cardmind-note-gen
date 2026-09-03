# CardMind

CardMind 是一个基于 [NoteGen](https://github.com/codexu/note-gen) 改造的本地优先知识学习桌面应用。当前目标不是保留 NoteGen 的全部功能，而是形成一条清晰的个人学习主线：

```text
记录 / Markdown / ChatGPT 对话
                ↓
         AI 理解与知识拆分
                ↓
       知识卡片 / 关系图 / 复习
                ↓
      Agent 基于个人材料继续工作
```

> 当前有效应用仓库是 `E:\CardMind\note-gen`。外层 `E:\CardMind` 是历史工作区和数据目录，不是运行命令的位置。

## 当前产品边界

目前重点维护：

- Windows Tauri 桌面应用
- 快速记录、Markdown 编辑和 AI 对话
- 用户触发的单 Agent 工具循环
- ChatGPT 对话、当前记录或笔记生成知识卡片
- 本地 SQLite 卡片、复习和结构化知识数据

仍保留但不是当前产品主线：

- NoteGen 上游的移动端、同步、模板、音频等代码
- Agent 的 Memory、Skill、MCP 工具定义；当前活动注册表没有启用这些类别
- `cm_*` 结构化知识引擎；它已实现导入和存储，但尚未成为前端图谱的唯一数据源

更详细的实现边界和调用链见 [架构与阅读指南](docs/ARCHITECTURE.md)。

如果目标是把项目用于面试，请按 [项目掌握与面试过关手册](docs/INTERVIEW_OWNERSHIP.md) 训练。准备中的个人功能设计见 [可信知识卡设计练习](docs/TRUSTED_CARDS_DESIGN.md)。

## 技术栈

- TypeScript、React 19、Next.js 15：页面、状态、Agent、数据库调用
- Tauri 2、Rust、Tokio、Reqwest：桌面壳和原生能力
- SQLite：聊天、记录、向量、卡片、复习和知识图谱数据
- Python：无界面的对话摄取和结构化知识应用
- Zustand、Tiptap、Tailwind CSS：状态、编辑器和界面
- OpenAI-compatible Chat Completions：模型调用和 Function Calling

## 目录入口

```text
src/app/core/main/       主工作区：记录、编辑器、聊天
src/app/core/cards/      卡片生成、知识图谱、复习
src/stores/              Zustand 状态和前端业务编排
src/db/                  SQLite 表和数据访问
src/lib/agent/           Agent 运行循环、工具、权限、追踪
src/lib/ai/              AI 配置和 Tauri 网络客户端
src-tauri/src/           Rust 桌面能力
scripts/                 Python 知识导入引擎
```

## 本地运行

在本目录执行：

```powershell
pnpm tauri dev
```

开发时，Tauri 会启动 `http://localhost:3456` 的 Next.js 前端；生产构建会加载静态导出的 `out` 目录。

## 验证

完整的快速验证入口：

```powershell
pnpm check
```

它依次执行：

1. TypeScript 类型检查
2. 卡片分块测试
3. Python 知识引擎测试

知识引擎测试不得使用正式数据库。正式数据库位于 `E:\CardMind\data\note.db`。

## 推荐阅读顺序

1. `src-tauri/tauri.conf.json`：桌面应用如何启动
2. `src/app/core/layout.tsx`：前端初始化
3. `src/app/core/main/page.tsx`：主界面布局
4. `src/app/core/main/chat/chat-send.tsx`：Agent 上下文来源
5. `src/lib/agent/runtime.ts`：Agent 多轮循环
6. `src/lib/agent/tool-registry.ts`：模型能够调用什么
7. `src/app/core/cards/page.tsx`：知识卡片用户流程
8. `scripts/cardmind.py`：结构化知识导入流程

## 上游与许可

CardMind 使用 NoteGen 作为应用基础，并在其上增加面向知识学习的卡片、图谱、摄取和 Agent 改造。发布或对外介绍时应保留 NoteGen 来源说明，并遵守仓库中的 GPL-3.0 许可。
