import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EvalReport } from './types'

function requiredNumber(report: EvalReport, key: string) {
  const value = report.metrics[key]
  if (typeof value !== 'number') {
    throw new Error(`Passed report is missing numeric metric: ${key}`)
  }
  return value
}

export function writeResumeDrafts(report: EvalReport, outputDirectory?: string) {
  if (report.schemaVersion !== 1 || !report.passed || !report.comparable) {
    throw new Error('Resume drafts require a comparable, passed schemaVersion 1 report')
  }
  if (requiredNumber(report, 'unexpectedRealExecutionCount') !== 0) {
    throw new Error('Resume drafts require zero unexpected real executions')
  }

  const directory = resolve(outputDirectory || resolve('docs', 'resume'))
  mkdirSync(directory, { recursive: true })
  const warning = report.workingTreeDirty
    ? '> 本地未提交证据，勿投递；请在干净提交上重跑 Eval 后再使用。\n\n'
    : ''

  const scenarioPass = requiredNumber(report, 'scenarioPassCount')
  const assertionPass = requiredNumber(report, 'guardrailAssertionPassCount')
  const guardrailDenominator = report.denominator.guardrailAssertions
  if (typeof guardrailDenominator !== 'number') {
    throw new Error('Passed report is missing the guardrail assertion denominator')
  }
  const agent = `${warning}# AI Agent 工程版（证据生成稿）

- 基于开源 NoteGen（GPL-3.0）二次开发 CardMind 单 Agent Runtime，引入模型与工具端口注入、明确终止状态、取消/超时、流式重试和运行内副作用去重；未宣称多 Agent、Responses API、生产级 MCP 或跨运行幂等。
- 使用 Ajv 在权限判断前校验完整工具参数，并将审批绑定到工具、规范化目标与选区；对拒绝、异常、部分成功和无法取消的在途写入返回可审计结果。
- 构建纯内存 Replay Eval，在提交 \`${report.commit.slice(0, 12)}\` 上完成 ${scenarioPass}/${report.denominator.scenarios} 个场景、${assertionPass}/${guardrailDenominator} 项守卫断言，意外真实执行 0；该数字不代表真实模型路由准确率。
`
  const systems = `${warning}# C++ / Linux 辅助版（证据生成稿）

- 基于开源 NoteGen（GPL-3.0）二次开发桌面 Agent 执行链，将模型流、审批和工具调用收口为带终止原因的可取消状态机，补齐工具超时、停止传播和 \`effect_unknown\` 边界。
- 在 Tauri/Rust 命令面移除 v1 未启用的 MCP/runtime-installer 注册，收紧 CSP 与 Markdown 渲染边界，同时保留既有本机用户配置而不写入默认凭据。
- 以 Fake Model、内存工具目录和 Record/Replay 验证 ${scenarioPass}/${report.denominator.scenarios} 个离线场景、${assertionPass}/${guardrailDenominator} 项守卫断言，真实笔记/SQLite/Tauri 副作用为 0；未将离线回放包装成生产压测。
`

  const agentPath = resolve(directory, 'agent-engineering.md')
  const systemsPath = resolve(directory, 'cpp-linux-supporting.md')
  writeFileSync(agentPath, agent, 'utf8')
  writeFileSync(systemsPath, systems, 'utf8')
  return { agentPath, systemsPath }
}
