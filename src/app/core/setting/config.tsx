import {
  BotMessageSquare,
  Store,
  FolderOpen,
  FileCog,
  KeyboardIcon,
  Settings,
  MessageSquare,
  PenTool,
} from "lucide-react"

const baseConfig = [
  {
    icon: <Store className="size-4 md:size-6" />,
    anchor: 'about',
  },
  {
    icon: <Settings className="size-4 md:size-6" />,
    anchor: 'general',
  },
  {
    icon: <MessageSquare className="size-4 md:size-6" />,
    anchor: 'chat',
  },
  {
    icon: <FileCog className="size-4 md:size-6" />,
    anchor: 'editor',
  },
  {
    icon: <PenTool className="size-4 md:size-6" />,
    anchor: 'record',
  },
  '-',
  {
    icon: <BotMessageSquare className="size-4 md:size-6" />,
    anchor: 'ai',
  },
  '-',
  {
    icon: <FolderOpen className="size-4 md:size-6" />,
    anchor: 'file',
  },
  {
    icon: <KeyboardIcon className="size-4 md:size-6" />,
    anchor: 'shortcuts',
  },
]

export default baseConfig

export type ModelType = 'chat' | 'image' | 'video' | 'tts' | 'stt' | 'embedding' | 'rerank';

export interface ModelConfig {
  id: string
  model: string
  modelType: ModelType
  temperature?: number
  topP?: number
  voice?: string
  enableStream?: boolean
}

export interface AiConfig {
  key: string
  title: string
  apiKey?: string
  baseURL?: string
  templateKey?: string
  templateSource?: 'builtin' | 'remote' | 'custom'
  icon?: string
  apiKeyUrl?: string
  customHeaders?: Record<string, string>
  models?: ModelConfig[]
  // 保持向后兼容
  model?: string
  temperature?: number
  topP?: number
  modelType?: ModelType
  voice?: string
  speed?: number
  enableStream?: boolean
}

export interface Model {
  id: string
  object: string
  created: number
  owned_by: string
}

// Define base AI configuration without translations
const builtinProviderTemplates: AiConfig[] = [
  {
    key: 'chatgpt',
    title: 'ChatGPT',
    baseURL: 'https://api.openai.com/v1',
    icon: 'https://s2.loli.net/2025/06/25/cVMf586WTBYAju4.png',
    apiKeyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    key: 'gemini',
    title: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    icon: 'https://s2.loli.net/2025/06/25/JU2jVxLFsW4lB6S.png',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey'
  },
  {
    key: 'ollama',
    title: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
    icon: 'https://s2.loli.net/2025/06/25/legkEpHACDBQ5Xz.png',
  },
  {
    key: 'lmstudio',
    title: 'LM Studio',
    baseURL: 'http://localhost:1234/v1',
    icon: 'https://s2.loli.net/2025/06/25/IifFV4HTQ9dpGZE.png',
  },
]

const baseAiConfig = builtinProviderTemplates

export { baseAiConfig, builtinProviderTemplates }
