import type { AiConfig } from '@/app/core/setting/config'
import {
  createOpenAIClient,
  getAISettings,
  getSystemPromptContent,
  handleAIError,
  validateAIService,
} from '@/lib/ai/utils'
import { AgentContextManager } from './context-manager'
import { AgentPromptAssembler } from './prompt-assembler'
import { abortableSleep } from './recovery-manager'
import { createAgentId } from './trace-recorder'
import { agentToolRegistry } from './tool-registry'
import type {
  AgentModelPort,
  AgentModelSettings,
  AgentRuntimeDependencies,
} from './types'

function toSettings(config: AiConfig): AgentModelSettings {
  return {
    model: config.model || '',
    baseURL: config.baseURL,
    temperature: config.temperature,
    topP: config.topP,
    raw: config,
  }
}

const productionModelPort: AgentModelPort = {
  async loadSettings() {
    const config = await getAISettings()
    return config ? toSettings(config) : null
  },
  async validateSettings(settings) {
    if (!settings.model.trim()) {
      return { ok: false, reason: '未配置可用的模型。' }
    }
    const baseURL = await validateAIService(settings.baseURL)
    return baseURL
      ? { ok: true }
      : { ok: false, reason: '未配置有效的 AI 服务地址。' }
  },
  getSystemPrompt: getSystemPromptContent,
  async createStream(request) {
    const client = await createOpenAIClient(request.settings.raw as AiConfig | undefined)
    return client.chat.completions.create({
      model: request.settings.model,
      messages: request.messages,
      temperature: request.settings.temperature,
      top_p: request.settings.topP,
      tools: request.tools,
      tool_choice: request.toolChoice,
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: request.signal })
  },
  formatError(error) {
    return handleAIError(error, false) || (error instanceof Error ? error.message : String(error))
  },
}

export function createDefaultAgentRuntimeDependencies(): AgentRuntimeDependencies {
  const contextManager = new AgentContextManager()
  const promptAssembler = new AgentPromptAssembler()

  return {
    modelPort: productionModelPort,
    toolCatalog: agentToolRegistry,
    now: Date.now,
    createId: createAgentId,
    sleep: abortableSleep,
    maxIterations: 15,
    maxModelRetries: 2,
    modelTimeoutMs: 30_000,
    toolTimeoutMs: 30_000,
    approvalTimeoutMs: 5 * 60_000,
    prepareMessages: (messages) => contextManager.prepareMessages(messages),
    buildCurrentUserMessage: (text, imageUrls) =>
      contextManager.buildCurrentUserMessage(text, imageUrls),
    assemblePrompt: (context, tools, basePrompt) =>
      promptAssembler.assemble(context, tools, basePrompt),
  }
}
